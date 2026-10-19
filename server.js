const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const https = require('https');
const store = require('./store');
const { seedDemoContent } = require('./seed-demo');

const app = express();
try {
  const compression = require('compression');
  app.use(compression());
} catch (e) {
  // Compression optional
}

// ---------------------------------------------------------------------------
// Crash resilience.
//
// Node's default is to exit on an unhandled rejection or an uncaught
// exception. On Render that means the instance dies, the health check starts
// failing, and the site stops answering entirely - which is exactly the
// "opens and never loads" failure. Log loudly and keep serving instead; a
// single bad request must not take the whole site down.
// ---------------------------------------------------------------------------
process.on('unhandledRejection', (reason) => {
  console.error('[fatal:unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal:uncaughtException]', err && err.stack ? err.stack : err);
});
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/api/ws' });

const PORT = process.env.PORT || 3000;
const SITE_DIR = __dirname;
const REMOTE_CDN = process.env.REMOTE_CDN || 'https://cdn.caser.day';
const CACHE_DIR = process.env.CASES_CACHE_DIR || path.join(SITE_DIR, 'cases_cache');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

app.use(express.json());

// Boot the storage layer, then start listening. Requests are not served until
// the database is reachable (or the in-memory fallback is active).
let storageReady = false;
const storeReady = store
  .init()
  .catch((err) => console.error('[store] init failed:', err.message))
  .finally(() => {
    storageReady = true;
  });

// Sessions and balances live in the database (see store.js); nothing is cached
// in module scope, so every request reads the current state.

const DEFAULT_AVATARS = [
  'https://avatars.steamstatic.com/6ee7f3e3312c196dbdb6bdd754a4e021abc16885_full.jpg',
  'https://avatars.steamstatic.com/b62474de115ac86b1f76c65ee7821bc3a33aebcd_full.jpg',
  'https://avatars.steamstatic.com/f4c7e12795942db02bf89508924f93f92ee40895_full.jpg',
  'https://avatars.steamstatic.com/a91903aaf5442d0b774b9a85239914555d3d1614_full.jpg',
  'https://avatars.steamstatic.com/fd5be41c9a765b8ccc16726ee7686d391031be40_full.jpg'
];

function parseCookies(req) {
  const list = {};
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    const value = rest.join('=').trim();
    list[name] = decodeURIComponent(value);
  });
  return list;
}

// Malformed JSON bodies raise here. Answer 400 instead of letting the default
// handler dump a stack trace into the deploy log on every bad request.
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ success: false, message: 'Malformed JSON body' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: 'Body too large' });
  }
  console.error('[http:error]', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, message: 'Internal error' });
});

// CORS & Headers
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "frame-ancestors *;");
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Health check (used by Render and by uptime monitors).
// Reports the boot stage too: if the process is stuck or crash-looping, the
// stage tells you where without needing shell access to the box.
const BOOT = { startedAt: Date.now(), stage: 'booting', errors: 0 };

app.get('/healthz', async (req, res) => {
  res.json({
    ok: true,
    stage: BOOT.stage,
    bootedInMs: Date.now() - BOOT.startedAt,
    uptime: Math.round(process.uptime()),
    cases: casesData.length,
    shopItems: SHOP_ITEMS.length,
    online: wss.clients.size,
    storage: await store.stats(),
    // Surfaced so a failing write is visible without reading the deploy log.
    lastStoreError: lastStoreError.message,
    time: new Date().toISOString()
  });
});

// Load cases list
let casesData = [];
try {
  const rawCases = fs.readFileSync(path.join(SITE_DIR, 'cases.json'), 'utf8');
  casesData = JSON.parse(rawCases).data.cases;
  console.log(`[boot] cases.json loaded: ${casesData.length} cases`);
} catch (e) {
  console.warn('[boot] Could not read cases.json:', e.message);
}

// Sample skin pool with Steam CDN images
const SAMPLE_SKINS = [
  {
    id: "s1",
    appId: 730,
    marketName: "StatTrak™ AK-47 | Ice Coaled (Field-Tested)",
    price: 2890.00,
    image: "https://community.akamai.steamstatic.com/economy/image/i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyLwlcK3wiFO0POlPPNSI_-UGm-Zz-llj-xsSyCmmFMi5GrcwtivdnnCOgd2DsNxTeIJuxbqk9XuN-_i5gKI3d1BxH35iy1P8G81tKMOXOY4/360fx360f",
    rarity: "14",
    exterior: "3",
    weapon: "1",
    skin: "Ice Coaled"
  },
  {
    id: "s2",
    appId: 730,
    marketName: "AWP | Elite Build (Field-Tested)",
    price: 3450.00,
    image: "https://community.akamai.steamstatic.com/economy/image/i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyLwiYbf_jdk7uW-V6lsM-SWHH6vzOtyufRkAXnjzRx15WrWmd37JC7FZgEoCsFzFOQM4UHqm4a0YrnrtAXWg4IUmyTgznQe9p8sU8k/360fx360f",
    rarity: "15",
    exterior: "3",
    weapon: "3",
    skin: "Elite Build"
  },
  {
    id: "s3",
    appId: 730,
    marketName: "StatTrak™ Zeus x27 | Olympus (Factory New)",
    price: 1420.00,
    image: "https://community.akamai.steamstatic.com/economy/image/i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyLln4Xl7x1B6ue9V7BlNf6XC3WvxuFyj-1gSCGn2xl2sm7XnI6hdC-XPAcmXsF2RLIP4xbslty2NLvqswePjYlEySn33S9XrnE8cYTqlUY/360fx360f",
    rarity: "15",
    exterior: "2",
    weapon: "20",
    skin: "Olympus"
  },
  {
    id: "s4",
    appId: 730,
    marketName: "★ Falchion Knife | Marble Fade (Factory New)",
    price: 48500.00,
    image: "https://community.akamai.steamstatic.com/economy/image/i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyL6kJ_m-B1d7v6tYK1iLs-SA1idwPx0vORWSSi3kCIrujqNjsGqdXrFbFIlA8QjTO8Lu0O7m921ZLy05gfXj99Aziz_2nscuic6sr4AT-N7rSTjmXt5/360fx360f",
    rarity: "12",
    exterior: "2",
    weapon: "512",
    skin: "Marble Fade"
  },
  {
    id: "s5",
    appId: 730,
    marketName: "MAC-10 | Disco Tech (Battle-Scarred)",
    price: 680.00,
    image: "https://community.akamai.steamstatic.com/economy/image/i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyL8n5WxrR1Y-s2jaac8cM-dD2SCxNF-teB_Vme1wx5ysWiEmYv6JXPCagAlCJNyTbEJtxi_kN3vYuPr4g3Y2IhHzyyqkGoXuZENuRkn/360fx360f",
    rarity: "15",
    exterior: "1",
    weapon: "15",
    skin: "Disco Tech"
  },
  {
    id: "s6",
    appId: 730,
    marketName: "USP-S | Stainless (Minimal Wear)",
    price: 1200.00,
    image: "https://community.akamai.steamstatic.com/economy/image/i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyLkjYbf7itX6vytbbZSIeGsG3SA_v1isehnQyyghiIrujqNjsGqcHuVa1VxCcciR7MP50a5ktLuP-rr5ATXioJNyij93y0a7nlstboAT-N7rU1N1uE6/360fx360f",
    rarity: "16",
    exterior: "4",
    weapon: "32",
    skin: "Stainless"
  },
  {
    id: "s7",
    appId: 730,
    marketName: "Glock-18 | Gamma Doppler (Well-Worn)",
    price: 3100.00,
    image: "https://community.akamai.steamstatic.com/economy/image/i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyL2kpnj9h1a4s2paalgIc-XAXeAzetkj_FhTjq2xiIgvzKGkbD0JC_OK1s-CptwReUJshXtwNeyZb605ATZ3owTziz_iiIa735pt70HBKVx-KPV3haBb-PioPG43g/360fx360f",
    rarity: "14",
    exterior: "5",
    weapon: "4",
    skin: "Gamma Doppler"
  },
  {
    id: "s8",
    appId: 730,
    marketName: "StatTrak™ MP7 | Just Smile (Factory New)",
    price: 2500.00,
    image: "https://community.akamai.steamstatic.com/economy/image/i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyL8jsHf8DIM0Pi7e7BSM_2aAmKvzedxuPUnHXrkzU4i4z-Dno6sci3BaQApDpN4R-cCthnqx4W2MunhtgCI3d0QmzK-0H0MYFOvtA/360fx360f",
    rarity: "15",
    exterior: "2",
    weapon: "19",
    skin: "Just Smile"
  }
];

// Starting balance of a freshly provisioned player
const START_BALANCE = 2043.31;

/**
 * Money is rounded to 2 decimals on every read.
 *
 * Repeated float arithmetic (stake sums, percentage payouts) otherwise leaves
 * values like 2043.3099999999998, which render differently depending on the
 * endpoint the client happened to read last.
 */
function round2(n) {
  const v = typeof n === 'number' ? n : parseFloat(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/**
 * The site's own formatAmount() (chunks/3afhs_vz7l64i.js) does:
 *
 *   let s = typeof e === 'number' ? e.toString() : e;
 *   let [int, frac] = s.split('.');
 *   if (!/^\d*$/.test(int) || !/^\d*$/.test(frac)) return '0.00';
 *
 * Anything that is not plain decimal digits - thousand separators, exponential
 * notation, an empty string - silently renders as 0.00. toFixed itself starts
 * producing "1e+21" at 1e21, so a very large balance would display as zero
 * while the server held the real number.
 *
 * Money therefore never leaves the server in a shape the client cannot parse:
 * plain decimal, no separators, no exponent, and capped well below the
 * exponential threshold.
 */
const MAX_MONEY = 1e12; // a trillion - far past any plausible balance

/** Clamps to the range the client can render. */
function safeMoney(n) {
  const v = round2(n);
  if (!Number.isFinite(v)) return 0;
  if (v > MAX_MONEY) return MAX_MONEY;
  if (v < -MAX_MONEY) return -MAX_MONEY;
  return v;
}

/** A plain-decimal string with exactly two decimals, e.g. "7000000.00". */
function moneyString(n) {
  const v = safeMoney(n);
  // toFixed is safe below 1e21; MAX_MONEY is 1e12.
  return v.toFixed(2);
}

/**
 * Reads a query parameter as an integer inside [min, max].
 * Garbage input ("?limit=abc", "?offset=-5") collapses to `fallback` instead of
 * reaching SQL as NaN.
 */
function clampInt(raw, min, max, fallback) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Builds the full catalogue of distinct skins from every cached case so that
// ANY skin can be picked as an upgrade target / shop item.
function buildShopCatalogue() {
  const byMarketName = new Map();

  const add = (item) => {
    if (!item || typeof item.image !== 'string' || !item.image) return;
    const marketName = item.marketName || item.name;
    if (!marketName) return;
    const price = parseFloat(item.price);
    if (!Number.isFinite(price)) return;
    const key = marketName.trim().toLowerCase();
    const existing = byMarketName.get(key);
    // Keep the cheapest listing of the same skin
    if (existing && existing.price <= price) return;
    byMarketName.set(key, {
      id: String(item.id ?? key),
      appId: item.appId ?? 730,
      marketName,
      price,
      image: item.image,
      weapon: item.weapon ?? null,
      skin: item.skin ?? null,
      exterior: item.exterior ?? null,
      stattrak: item.stattrak ?? false,
      type: item.type ?? null,
      rarity: item.rarity ?? null
    });
  };

  // 1) Sample skins (always present)
  SAMPLE_SKINS.forEach(add);

  // 2) Every item of every cached case
  let cacheDir = CACHE_DIR;
  try {
    if (fs.existsSync(cacheDir) && fs.statSync(cacheDir).isDirectory()) {
      for (const file of fs.readdirSync(cacheDir)) {
        if (!file.endsWith('.json')) continue;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(cacheDir, file), 'utf8'));
          (data.items || []).forEach(add);
        } catch (e) { /* skip malformed cache file */ }
      }
    }
  } catch (e) {
    console.warn('Could not build item catalogue:', e.message);
  }

  const list = [...byMarketName.values()];
  // Stable ordering: cheap -> expensive, then by name
  list.sort((a, b) => a.price - b.price || a.marketName.localeCompare(b.marketName));
  return list;
}

// Inventory now lives in SQLite and is scoped per user (see store.js)

const NICKNAMES = [
  'you.scared016', "It's Dadudik <3", 'Отчимус Прайм', 'Dildos', 'beltoS1K7!',
  'detriss', 'err0r то', 'Fuzya', 'NpOpS', 'shamelless', 'HOMELANDER',
  'Fygooood', 'Zhenya', 'qwe', 'KOT', 'zxcVolodya2004', 'sinexx221', 'Kray'
];

const AVATARS = [
  'https://avatars.steamstatic.com/6ee7f3e3312c196dbdb6bdd754a4e021abc16885_full.jpg',
  'https://avatars.steamstatic.com/b62474de115ac86b1f76c65ee7821bc3a33aebcd_full.jpg',
  'https://avatars.steamstatic.com/f4c7e12795942db02bf89508924f93f92ee40895_full.jpg',
  'https://avatars.steamstatic.com/a91903aaf5442d0b774b9a85239914555d3d1614_full.jpg',
  'https://avatars.steamstatic.com/fd5be41c9a765b8ccc16726ee7686d391031be40_full.jpg'
];

// Live drops are real now. `liveDropsList` is only a warm cache for the
// homepage widget; /api/live-drops reads the drops table.
let liveDropsList = [];

/** Warms the in-process cache so a freshly booted server can answer at once. */
store.listRecentDrops(30).then((drops) => { liveDropsList = drops; }).catch(() => {});

// The enhancement script and stylesheet are ours, not part of the original
// bundle. They must not be pinned with `immutable`: browsers that already have
// a copy would keep running it for a year, which is how a page can stay broken
// long after the deploy that fixed it. Sent from memory because res.sendFile
// overwrites Cache-Control with its own `public, max-age=0`.
app.get(['/custom-auth.js', '/custom-auth.css'], (req, res) => {
  const file = path.join(SITE_DIR, req.path.slice(1));
  res.setHeader('Cache-Control', 'no-store');
  res.type(path.extname(file)).send(fs.readFileSync(file, 'utf8'));
});

// Resolves (and if needed provisions) the user for this request.
// Identity comes from the session cookie / bearer token, so every browser gets
// its own balance + inventory. Falls back to a freshly generated demo id.
async function resolveUser(req) {
  const cookies = parseCookies(req);
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  const candidates = [
    cookies['caser_user_id'],
    token ? token.replace(/^token_/, '') : null
  ].filter(Boolean);

  // Accounts are numbered 1, 2, 3 ... A cookie naming an account that already
  // exists is honoured as-is, so returning visitors keep their balance and
  // inventory; only an unknown identity is minted a fresh number. That is what
  // makes the profile show a plain "ID:242408" instead of a random slug.
  //
  // A slug left over from the days before numbering is renumbered here: the
  // account moves onto the next free number with its balance and history, and
  // the cookie is rewritten, so old visitors end up on a numbered account too.
  //
  // The client also sends its own id as a Bearer token, so a browser that
  // cannot keep cookies still resolves to the same account.
  let slug = null;
  let user = null;
  for (const id of candidates) {
    if (!/^\d+$/.test(id)) {
      if (!slug) slug = id;
      const migrated = await store.migrateLegacyUser(id);
      if (!migrated) continue; // never existed: fall through to a fresh number
      const renumbered = await store.getUser(migrated);
      if (renumbered) { user = renumbered; break; }
      continue;
    }
    const existing = await store.getUser(id);
    if (existing) { user = existing; break; }
  }

  // No known identity yet: mint a stable demo account for this browser.
  if (!user) {
    const id = await store.nextUserId();
    user = await store.ensureUser({
      id,
      nickname: 'CaserPlayer',
      image: DEFAULT_AVATARS[0],
      balance: START_BALANCE,
      tradeUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=12345678',
      role: 'user'
    });
    // The client keeps its own id in localStorage and sends it back with every
    // request. If it was a slug this account was minted from, remember the
    // pair: a browser that cannot hold the cookie still presents that slug, and
    // the alias is what lands it on this account instead of minting a new one
    // on every reload.
    if (slug) await store.aliasLegacyId(slug, id);
  }

  // Keep the cookie in step with the account we resolved. A browser that
  // dropped it (private mode, a strict privacy setting) otherwise has to rely
  // on the header on every single request.
  if (req.res && typeof req.res.cookie === 'function' && cookies['caser_user_id'] !== user.id) {
    req.res.cookie('caser_user_id', user.id, { maxAge: 31536000000, path: '/' });
    req.res.cookie('auth_flag', '1', { maxAge: 31536000000, path: '/' });
  }
  return user;
}

// ----------------------------------------------------
// AUTH REST API Endpoints
// ----------------------------------------------------

app.post('/api/auth/session', async (req, res) => {
  const incoming = req.body || {};
  if (!incoming.id) return res.status(400).json({ success: false, message: 'Invalid user data' });

  // Account numbers replaced the old random slugs. A session request that
  // still carries a slug is renumbered here, so no new legacy accounts are
  // ever created and resolveUser never has to migrate one of these.
  const id = /^\d+$/.test(String(incoming.id))
    ? String(incoming.id)
    : await store.nextUserId();

  const user = await store.ensureUser({
    id,
    nickname: incoming.nickname || 'CaserPlayer',
    image: incoming.image || DEFAULT_AVATARS[0],
    // The client-sent balance is only honoured when the account is brand new
    balance: incoming.balance ?? START_BALANCE,
    tradeUrl: incoming.tradeUrl || incoming.steamTradeLink || null,
    role: incoming.role || 'user'
  });
  res.cookie('caser_user_id', user.id, { maxAge: 31536000000, path: '/' });
  res.cookie('auth_flag', '1', { maxAge: 31536000000, path: '/' });
  res.json({ success: true, data: { ...user, balance: user.balance } });
});

app.post('/api/auth/login', async (req, res) => {
  const { username } = req.body || {};
  const user = await store.createUser({
    id: await store.nextUserId(),
    nickname: username || 'Player',
    image: DEFAULT_AVATARS[0],
    balance: START_BALANCE,
    tradeUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=12345678',
    role: 'user'
  });
  res.cookie('caser_user_id', user.id, { maxAge: 31536000000, path: '/' });
  res.cookie('auth_flag', '1', { maxAge: 31536000000, path: '/' });
  res.json({ success: true, data: user, token: 'token_' + user.id });
});

app.post('/api/auth/register', async (req, res) => {
  const { username, image, balance } = req.body || {};
  const user = await store.createUser({
    id: await store.nextUserId(),
    nickname: username || 'ProGamer',
    image: image || DEFAULT_AVATARS[0],
    balance: parseFloat(balance) || START_BALANCE,
    tradeUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=12345678',
    role: 'user'
  });
  res.cookie('caser_user_id', user.id, { maxAge: 31536000000, path: '/' });
  res.cookie('auth_flag', '1', { maxAge: 31536000000, path: '/' });
  res.json({ success: true, data: user, token: 'token_' + user.id });
});

app.post('/api/users/balance/topup', async (req, res) => {
  const user = await resolveUser(req);
  // Strict parsing. This used to fall back to a 5000 default, so a request
  // with a missing or malformed amount silently credited 5000 - including
  // `amount: 0`, which is falsy and therefore also got the default.
  const raw = req.body && req.body.amount;
  const amount = typeof raw === 'number' ? raw : parseFloat(raw);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ success: false, message: 'Неверная сумма' });
  }
  if (amount > MAX_MONEY) {
    return res.status(400).json({ success: false, message: 'Сумма превышает максимальный баланс' });
  }
  const balance = (await store.addBalance(user.id, amount, 'topup', { amount })) ?? user.balance;
  const safe = safeMoney(balance);
  pushBalance({ ...user, balance: safe });
  res.json({ success: true, balance: safe });
});

const handleLogout = (req, res) => {
  res.clearCookie('caser_user_id');
  res.clearCookie('auth_flag');
  res.json({ success: true });
};
app.post('/api/auth/logout', handleLogout);
app.post('/users/auth/logout', handleLogout);
app.post('/api/users/auth/logout', handleLogout);

const handleSteamRedirect = (req, res) => {
  const demoToken = 'token_demo_' + Date.now().toString(36);
  const demoUser = {
    id: 'user_demo',
    nickname: 'CaserPlayer',
    image: DEFAULT_AVATARS[0],
    balance: START_BALANCE,
    role: 'user'
  };
  const b64Token = Buffer.from(demoToken).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  res.json({
    redirect: `/ru?auth=${b64Token}`
  });
};
app.get('/api/users/auth/steam/redirect-url', handleSteamRedirect);
app.get('/users/auth/steam/redirect-url', handleSteamRedirect);

const handleRefresh = async (req, res) => {
  const user = await resolveUser(req);
  const token = user ? 'token_' + user.id : 'token_guest';
  res.json({
    token: token,
    refreshToken: 'refresh_' + token
  });
};
app.post('/api/users/auth/refresh', handleRefresh);
app.post('/users/auth/refresh', handleRefresh);

const handleUsersMe = async (req, res) => {
  const user = await resolveUser(req);
  if (!user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  res.json({
    id: user.id,
    nickname: user.nickname,
    image: user.image || DEFAULT_AVATARS[0],
    // Number, not a string: this endpoint and the topup/case-open endpoints
    // must agree on the type. A string here made the client treat the balance
    // differently depending on which request landed last.
    balance: safeMoney(user.balance ?? START_BALANCE),
    isCreator: !!user.isCreator,
    createdAt: user.createdAt || null,
    tradeUrl: user.tradeUrl || 'https://steamcommunity.com/tradeoffer/new/?partner=12345678',
    // Same value under the name the bundle actually reads.
    steamTradeLink: user.steamTradeLink || user.tradeUrl || 'https://steamcommunity.com/tradeoffer/new/?partner=12345678',
    role: user.role || 'user'
  });
};
app.get('/api/users/me', handleUsersMe);
app.get('/users/me', handleUsersMe);

app.post('/api/users/pwa-installed', (req, res) => res.json({ success: true }));
app.post('/users/pwa-installed', (req, res) => res.json({ success: true }));

// ----------------------------------------------------
// CASE DETAILS & OPENING REST API Endpoints
// ----------------------------------------------------

async function fetchCaseData(slug) {
  const cachePath = path.join(CACHE_DIR, `${slug}.json`);
  if (fs.existsSync(cachePath)) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch (e) {}
  }

  // Try fetching from remote CDN
  try {
    const data = await new Promise((resolve, reject) => {
      https.get(`${REMOTE_CDN}/api/game/cases/${slug}`, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (resp) => {
        if (resp.statusCode === 200) {
          let body = '';
          resp.on('data', chunk => body += chunk);
          resp.on('end', () => {
            try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
          });
        } else {
          reject(new Error('Status ' + resp.statusCode));
        }
      }).on('error', reject);
    });

    if (data && data.case) {
      fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
      return data;
    }
  } catch (err) {
    console.warn(`Could not fetch remote case ${slug}:`, err.message);
  }

  // Fallback synthesis from cases.json
  const foundCase = casesData.find(c => c.slug === slug) || {
    id: '999',
    title: slug.charAt(0).toUpperCase() + slug.slice(1),
    slug: slug,
    price: '100.000',
    image: '/cases/1611ed2e67dfcd18662d9d574b77a45e-6ab6460cd5709.webp'
  };

  const synthesized = {
    case: {
      ...foundCase,
      type: 'paid',
      prices: [
        { count: 1, price: foundCase.price },
        { count: 2, price: String(parseFloat(foundCase.price) * 2) },
        { count: 3, price: String(parseFloat(foundCase.price) * 3) }
      ],
      status: 'active',
      total_opens: 9740506,
      max_opens_at_once: 6
    },
    items: SAMPLE_SKINS.map((s, idx) => ({
      id: String(100 + idx),
      appId: 730,
      marketName: s.marketName,
      price: String(s.price),
      image: s.image,
      weapon: s.weapon,
      skin: s.skin,
      exterior: s.exterior,
      stattrak: false,
      type: "16",
      rarity: s.rarity
    }))
  };

  fs.writeFileSync(cachePath, JSON.stringify(synthesized, null, 2));
  return synthesized;
}

const handleGetCaseDetails = async (req, res) => {
  const slug = req.params.slug;
  try {
    const data = await fetchCaseData(slug);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load case data' });
  }
};

app.get('/api/game/cases/:slug', handleGetCaseDetails);
app.get('/game/cases/:slug', handleGetCaseDetails);

// Case Opening Handler
const handleOpenCase = async (req, res) => {
  const slug = req.params.slug;
  const count = Math.max(1, Math.min(6, parseInt(req.body?.count) || 1));
  const user = await resolveUser(req);

  try {
    const caseData = await fetchCaseData(slug);
    const casePrice = parseFloat(caseData.case?.price || 100);
    const totalCost = casePrice * count;

    // Atomic conditional debit: the WHERE guard is evaluated on the stored
    // balance, so concurrent clicks can never overdraw an account.
    const balance = await store.addBalance(user.id, -totalCost, 'case_open', { slug, count }, totalCost);
    if (balance == null) {
      return res.status(400).json({
        success: false,
        message: 'Недостаточно средств',
        balance: parseFloat(user.balance) || 0
      });
    }

    const wonItems = [];
    const createdEntries = [];
    // Only roll items that actually have a picture, otherwise the roulette
    // and the reveal card would fall back to the generic logo placeholder.
    const caseItems = Array.isArray(caseData.items) ? caseData.items : [];
    const drawableItems = caseItems.filter((it) => it && typeof it.image === 'string' && it.image.trim());
    const dropPool = drawableItems.length ? drawableItems : SAMPLE_SKINS;

    for (let i = 0; i < count; i++) {
      // Pick item from case pool using the RTP-weighted odds
      const odds = getCaseOdds(caseData);
      const won = odds
        ? dropPool[pickByOdds(odds)]
        : dropPool[crypto.randomInt(0, dropPool.length)];
      const marketName = won.marketName || won.name || 'AK-47 | Redline';
      const price = String(won.price ?? 1500);

      // Flat item payload: the client renders the roulette winner card and the
      // "you won" card straight from these fields (image / marketName / rarity).
      const flatItem = {
        id: String(won.id ?? ''),
        appId: 730,
        marketName,
        name: marketName,
        price,
        image: won.image,
        weapon: won.weapon ?? null,
        skin: won.skin ?? null,
        exterior: won.exterior ?? null,
        stattrak: won.stattrak ?? false,
        type: won.type ?? null,
        chance: won.chance ?? null,
        rarity: won.rarity || '14'
      };

      const itemInstance = {
        ...flatItem,
        id: store.newId('won'),
        price,
        item: flatItem
      };

      wonItems.push(itemInstance);

      // Add to this user's inventory
      const entry = await store.addInventoryItem(user.id, {
        id: itemInstance.id,
        price: parseFloat(itemInstance.price),
        status: 'available',
        canSell: true,
        canUpgrade: true,
        item: flatItem
      });
      createdEntries.push(entry);
    }

    await store.recordCaseOpen(user.id, slug, totalCost, wonItems.map((w) => w.marketName));

    // Tell the client about the new drops so the sell buttons light up and
    // the header balance refreshes without a reload
    pushNewItems(user.id, createdEntries);
    pushBalance({ ...user, balance });

    // Real drops for the live feed every visitor watches.
    for (const entry of createdEntries) {
      await publishDrop(user.id, entry.item, entry.price, 'case');
    }

    res.json({
      items: wonItems,
      balance,
      case_stats: {
        total_opens: (caseData.case?.total_opens || 9740506) + count
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to open case: ' + err.message });
  }
};

app.post('/api/game/cases/:slug/open', handleOpenCase);
app.post('/game/cases/:slug/open', handleOpenCase);

// ----------------------------------------------------
// GAME & CONTENT REST API Endpoints
// ----------------------------------------------------

// Site-wide counters.
//
// They are read on every /api/statistics hit and on every websocket tick, so
// summing the tables each time would be wasteful on a free instance: the
// numbers are refreshed once every few seconds and reused in between.
let siteCounters = { users: 0, casesOpened: 0, upgradesMade: 0 };
let siteCountersAt = 0;
const SITE_COUNTERS_TTL_MS = 4000;

async function currentSiteCounters() {
  if (Date.now() - siteCountersAt > SITE_COUNTERS_TTL_MS) {
    try {
      siteCounters = await store.siteStats();
      siteCountersAt = Date.now();
    } catch (err) {
      // Keep serving the previous numbers rather than blanking the footer.
    }
  }
  return siteCounters;
}

/** Drops the cached counters so the next read reflects a purge immediately. */
function invalidateSiteCounters() { siteCountersAt = 0; }

/** The payload the footer and the online badge both consume. */
async function countersPayload() {
  const totals = await currentSiteCounters();
  return {
    // Real: one per open socket. The old 3.8k was a sine wave, so the badge
    // showed thousands of "players" on a site nobody had signed up for.
    online: wss.clients.size,
    users_count: totals.users,
    cases_opened: totals.casesOpened,
    upgrader_count: totals.upgradesMade
  };
}

app.get('/api/statistics', async (req, res) => {
  res.json(await countersPayload());
});

/**
 * The live feed is real play now: every item a player wins is written to the
 * `drops` table and pushed to every connected client. The old version generated
 * a random skin every three seconds, so the feed was fiction.
 */
app.get('/api/live-drops', async (req, res) => {
  const limit = clampInt(req.query.limit, 1, 100, 40);
  const drops = await store.listRecentDrops(limit);
  res.json({
    liveDrops: drops,
    hotDrops: drops.filter((d) => d.item.rarity === 'covert' || d.item.rarity === 'extraordinary'),
    online: wss.clients.size
  });
});

/**
 * Called after a real win: persist the drop and tell every client.
 *
 * Failures are recorded rather than swallowed: a drop that is in the feed but
 * missing from the profile counters is exactly the kind of half-broken state
 * that is invisible from the UI, so it surfaces on /healthz.
 */
const lastStoreError = { message: null, at: null };
async function publishDrop(userId, item, price, source) {
  try {
    await store.recordDrop(userId, item, price, source);
    const [recent] = await store.listRecentDrops(30);
    if (recent) {
      liveDropsList.unshift(recent);
      if (liveDropsList.length > 60) liveDropsList.length = 60;
      wsBroadcast('live_drops.new', recent);
    }
  } catch (err) {
    lastStoreError.message = 'publishDrop: ' + err.message;
    lastStoreError.at = new Date().toISOString();
    console.error('[live-drops]', err.message);
  }
}

app.get('/api/game/cases', (req, res) => {
  res.json({
    cases: casesData
  });
});
app.get('/game/cases', (req, res) => {
  res.json({
    cases: casesData
  });
});

app.get('/api/game/free-cases', (req, res) => res.json({ cases: [] }));
app.get('/game/free-cases', (req, res) => res.json({ cases: [] }));

// (The winners feed itself is served further down, next to the rest of the
// giveaway mocks, in the shape the Next.js bundle expects.)

// Shop catalogue = every distinct skin known to the server (all cached cases + samples)
BOOT.stage = 'building-catalogue';
console.log('[boot] building shop catalogue...');
const SHOP_ITEMS = buildShopCatalogue();
console.log(`[boot] catalogue ready: ${SHOP_ITEMS.length} distinct skins`);

// A wiped database - Render's Free plan rebuilds the SQLite file on every cold
// start - would leave the rewards page with an empty board and an empty feed,
// so the demo content is restored as soon as the store is reachable. Guarded
// internally: a database that already has the content is left untouched.
// The demo roster - twelve pro nicknames, 48 drops and three settled rounds - is
// only ever wanted on an empty development database. On the deployed site it
// fills the top drop, the winner list and the player counter with people who
// never played, so it is off there: SEED_DEMO=1 puts it back.
const DEMO_SEEDING = process.env.SEED_DEMO === '1'
  || !(process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME);

if (DEMO_SEEDING) {
  storeReady
    .then(() => seedDemoContent(store, SHOP_ITEMS))
    .catch((err) => console.warn('[seed] skipped:', err.message));
} else {
  console.log('[seed] demo content disabled on this host (set SEED_DEMO=1 to restore it)');
}

const toShopPayload = (s) => {
  const rarity = Number(s.rarity);
  const type = Number(s.type);
  const exterior = Number(s.exterior);
  const weapon = Number(s.weapon);
  const extra = {};
  if (Number.isFinite(rarity)) extra.r = rarity;
  if (Number.isFinite(type)) extra.t = type;
  if (Number.isFinite(exterior)) extra.e = exterior;
  if (Number.isFinite(weapon)) extra.g = weapon;
  if (typeof s.stattrak === 'boolean') extra.st = s.stattrak;
  if (s.skin) extra.n = s.skin;

  return {
    id: String(s.id),
    appId: s.appId ?? 730,
    marketName: s.marketName,
    price: parseFloat(s.price) || 0,
    image: s.image,
    rarity: s.rarity ?? null,
    type: s.type ?? null,
    exterior: s.exterior ?? null,
    weapon: s.weapon ?? null,
    stattrak: s.stattrak ?? null,
    skin: s.skin ?? null,
    status: 'available',
    item: {
      id: String(s.id),
      appId: s.appId ?? 730,
      marketName: s.marketName,
      price: parseFloat(s.price) || 0,
      image: s.image,
      extra
    }
  };
};

// Paginated / filtered / sorted shop endpoint (used by the upgrade target picker)
function handleShop(req, res) {
  const q = req.query || {};
  const limit = Math.min(200, Math.max(1, parseInt(q.limit) || 16));
  const offset = Math.max(0, parseInt(q.offset) || 0);

  const priceFrom = parseFloat(q.priceFrom);
  const priceTo = parseFloat(q.priceTo);
  const search = typeof q.marketName === 'string' ? q.marketName.trim().toLowerCase() : '';
  const status = typeof q.status === 'string' ? q.status : '';

  let list = SHOP_ITEMS;
  if (Number.isFinite(priceFrom)) list = list.filter((i) => i.price >= priceFrom);
  if (Number.isFinite(priceTo)) list = list.filter((i) => i.price <= priceTo);
  if (search) list = list.filter((i) => i.marketName.toLowerCase().includes(search));
  if (status === 'available') list = list.filter(() => true);

  const dir = String(q.sortDirection || 'ASC').toUpperCase() === 'DESC' ? -1 : 1;
  const sortBy = String(q.sortBy || 'price');
  list = [...list].sort((a, b) => {
    if (sortBy === 'marketName' || sortBy === 'name') return dir * a.marketName.localeCompare(b.marketName);
    if (sortBy === 'rarity') return dir * ((Number(a.rarity) || 0) - (Number(b.rarity) || 0));
    return dir * (a.price - b.price);
  });

  const page = list.slice(offset, offset + limit);
  res.json({
    items: page.map(toShopPayload),
    total: list.length,
    hasMore: offset + page.length < list.length
  });
}

app.get('/api/items/shop', handleShop);
app.get('/items/shop', handleShop);
app.get('/api/game/items/shop', handleShop);

// Upgrade target picker: same catalogue, but the client only ever fetches
// /items/shop, so expose an explicit alias too.
app.get('/api/items/shop/list', handleShop);
app.get('/api/upgrade/shop', handleShop);

// ---------------------------------------------------------
// WEBSOCKET BROADCAST HELPERS
// The client listens for these native events, so the UI updates
// without a page reload:
//   users.update_balance          -> header balance
//   users.update_inventory_balance-> inventory balance widget
//   inventory.new_items           -> "just dropped" items (sell buttons)
// ---------------------------------------------------------
function wsBroadcast(event, data) {
  const payload = JSON.stringify({ event, data });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(payload); } catch (e) { /* ignore */ }
    }
  }
}

/**
 * Pushes a balance update to the owner only.
 *
 * This used to be a global broadcast, which made every player's balance pill
 * jump to whoever spent money last - with two tabs open, or two players, the
 * number appeared to flicker between completely different values. Balance is
 * per-account, so the event has to be routed per-account.
 */
function pushBalance(user) {
  if (!user || !user.id) return;
  const amount = parseFloat(user.balance) || 0;
  if (!Number.isFinite(amount)) return;
  wsSendToUser(user.id, 'users.update_balance', amount);
}

/**
 * Pushes the value of the items the player owns to the header's second figure.
 *
 * Kept separate from pushBalance on purpose: that one is the coin balance, and
 * sending it here too made the header print the same number in both slots.
 */
async function pushInventoryBalance(userId) {
  if (!userId) return;
  try {
    const total = await store.totalInventoryValue(userId);
    wsSendToUser(userId, 'users.update_inventory_balance', { amount: moneyString(safeMoney(total)) });
  } catch (e) {
    // Never let a cosmetic update take down the request that triggered it.
  }
}

/**
 * Announces freshly won items to their owner only. Broadcasting this made
 * every connected client try to render (and sell) items it does not own.
 */
function pushNewItems(userId, items) {
  if (!userId || !Array.isArray(items) || !items.length) return;
  wsSendToUser(userId, 'inventory.new_items', { items: items.map((i) => ({ id: String(i.id) })) });
  pushInventoryBalance(userId);
}

/**
 * Sends an event to every socket belonging to one user.
 *
 * Withdrawal events carry item names and trade-offer links, so they must never
 * go out on the global broadcast - that would leak one player's trades to every
 * connected browser. Sockets are tagged with their user id at handshake time.
 */
function wsSendToUser(userId, event, data) {
  if (!userId) return;
  const payload = JSON.stringify({ event, data });
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (client.userId !== String(userId)) continue;
    try { client.send(payload); } catch (e) { /* ignore */ }
  }
}

/**
 * The header shows two separate figures side by side: the value of the items
 * you own (blue, "header-inventory-balance-desktop") and your coin balance
 * (green, "header-coin-balance-desktop"). This used to send the coin balance
 * for both, which made the header print the same number twice.
 */
const inventoryBalancePayload = (amount) => {
  const value = safeMoney(amount);
  // `amount` MUST stay a string here. The client reads it in two places and
  // both are type-sensitive:
  //   useInventoryBalanceQuery -> { amount: e.data.amount }
  //   users.update_inventory_balance -> `typeof e.amount === 'string'` guard
  // Sending a number makes the widget ignore the live update entirely.
  // The string must also be plain decimal with no separators, or the client's
  // formatAmount renders it as "0.00" - see moneyString() above.
  const formatted = moneyString(value);
  const payload = { amount: formatted, balance: formatted, defuses: value };
  // The api client exposes the raw body as `res.data`, and the client reads
  // `res.data.amount` -> the value must sit at the TOP level of the response.
  return { ...payload, success: true, data: payload };
};

const handleInventory = async (req, res) => {
  const user = await resolveUser(req);
  const q = req.query || {};
  const limit = Math.min(200, Math.max(1, parseInt(q.limit) || 28));
  const offset = Math.max(0, parseInt(q.offset) || 0);
  const status = q.status === 'available' ? 'available' : null;

  const total = await store.countInventory(user.id, status);
  let page = await store.listInventory(user.id, { limit, offset, status });

  const dir = String(q.sortDirection || 'DESC').toUpperCase() === 'ASC' ? 1 : -1;
  if (String(q.sortBy || 'created_at') === 'price') {
    page = [...page].sort((a, b) => dir * ((parseFloat(a.price) || 0) - (parseFloat(b.price) || 0)));
  }

  res.json({
    items: page,
    total,
    hasMore: offset + page.length < total,
    nextOffset: offset + page.length
  });
};
app.get('/api/items/inventory', handleInventory);
app.get('/items/inventory', handleInventory);

const handleInventoryBalance = async (req, res) => {
  const user = await resolveUser(req);
  res.json(inventoryBalancePayload(await store.totalInventoryValue(user.id)));
};
app.get('/api/items/inventory/balance', handleInventoryBalance);
app.get('/items/inventory/balance', handleInventoryBalance);

// Preview for the "sell all" confirmation modal
const handleSellAllPreview = async (req, res) => {
  const user = await resolveUser(req);
  const payload = {
    itemsCount: await store.countInventory(user.id, 'available'),
    totalAmount: await store.totalInventoryValue(user.id)
  };
  res.json({ ...payload, success: true, data: payload });
};
app.get('/api/items/inventory/sell-all/preview', handleSellAllPreview);
app.get('/items/inventory/sell-all/preview', handleSellAllPreview);

// Deletes the entries from the database and credits the wallet
async function sellInventoryEntries(user, entries) {
  if (!entries.length) return { totalAmount: 0, balance: user.balance };

  const totalAmount = Number(
    entries.reduce((acc, e) => acc + (parseFloat(e.price) || 0), 0).toFixed(2)
  );
  await store.removeInventoryItems(user.id, entries.map((e) => e.id));
  const balance = await store.addBalance(user.id, totalAmount, 'sell', {
    items: entries.map((e) => e.item && e.item.marketName).filter(Boolean)
  });

  return { totalAmount, balance: balance ?? user.balance };
}

// Sell the given items (or everything when no ids are supplied)
const handleSell = async (req, res) => {
  const user = await resolveUser(req);
  const body = req.body || {};
  const ids = Array.isArray(body.inventoryItemIds) ? body.inventoryItemIds.map(String) : [];

  let entries;
  if (body.all === true || ids.length === 0) {
    entries = await store.listInventory(user.id, { limit: 500, status: 'available' });
  } else {
    const found = await Promise.all(ids.map((id) => store.getInventoryEntry(user.id, id)));
    entries = found.filter((e) => e && e.status === 'available');
  }

  const { totalAmount, balance } = await sellInventoryEntries(user, entries);
  pushBalance({ ...user, balance });
  pushInventoryBalance(user.id);

  const payload = {
    totalAmount,
    itemsCount: entries.length,
    soldIds: entries.map((i) => String(i.id)),
    balance
  };
  // `totalAmount` must be top level: the client reads `res.data.totalAmount`
  res.json({ ...payload, success: true, data: payload });
};
app.post('/api/items/inventory/sell', handleSell);
app.post('/items/inventory/sell', handleSell);

// "Sell everything" button on the inventory page
const handleSellAll = async (req, res) => {
  const user = await resolveUser(req);
  const entries = await store.listInventory(user.id, { limit: 500, status: 'available' });
  const { totalAmount, balance } = await sellInventoryEntries(user, entries);

  pushBalance({ ...user, balance });
  pushInventoryBalance(user.id);

  const payload = {
    totalAmount,
    itemsCount: entries.length,
    soldIds: entries.map((i) => String(i.id)),
    balance
  };
  res.json({ ...payload, success: true, data: payload });
};
app.post('/api/items/inventory/sell-all', handleSellAll);
app.post('/items/inventory/sell-all', handleSellAll);

// Balance history (the header already has a modal for it)
app.get('/api/users/balance/history', async (req, res) => {
  const user = await resolveUser(req);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  const tx = await store.listTransactions(user.id, limit, offset);
  const rows = tx.map((t) => ({
    id: String(t.id),
    type: t.type,
    delta: Number(t.delta || 0),
    balanceAfter: Number(t.balance_after || 0),
    createdAt: t.created_at
  }));
  res.json({ items: rows, total: rows.length, hasMore: rows.length === limit });
});

// Cryptographically-seeded uniform float in [0, 1)
function randomUnit() {
  return crypto.randomInt(0, 1e9) / 1e9;
}

// ---------------------------------------------------------------------------
// House edge (RTP)
// ---------------------------------------------------------------------------
// Return to player = share of wagered money that comes back as winnings.
// RTP 0.80 -> the house keeps 20%. Override with the RTP env var.
const RTP = Math.min(0.99, Math.max(0.01, parseFloat(process.env.RTP) || 0.8));

// ---------------------------------------------------------------------------
// Case drop shape.
//
// The width of the outcome band around the case price, in log space.
//   DROP_SIGMA small -> outcomes bunch near the price, rare items very rare
//   DROP_SIGMA large -> a thin, frequent band and a fat tail of big wins
// DROP_BLEND is the uniform floor mixed in so every item keeps some chance of
// appearing at all. Both are tuned by _tune_odds.js and overridable per deploy.
const DROP_SIGMA = Math.min(3, Math.max(0.05, parseFloat(process.env.DROP_SIGMA) || 0.9));
const DROP_BLEND = Math.min(0.5, Math.max(0, parseFloat(process.env.DROP_BLEND) || 0.02));

// ---------------------------------------------------------------------------
// Upgrade wheel odds.
//
// The real caser.one computes its chance in the client bundle (2mwsxxmwyqhg9.js):
//
//   chancePercent = clamp(stake / targetPrice * 103, 1, 80)
//   superDrop     = rawChance < 1 || rawChance >= 80
//   no chance is displayed when targetPrice <= sum(selected item prices)
//   chance is 50 when the stake is 0
//
// UPGRADE_MULTIPLIER is that `103`. It defaults to RTP * 100 so the clone
// keeps the same formula but stays house-favourable. Set it to 103 to get the
// original numbers back - note that 103 is a *player* edge (RTP 103%), which is
// what the live site runs on the wheel as a loss-leader.
// ---------------------------------------------------------------------------
const UPGRADE_MULTIPLIER = Math.min(
  200,
  Math.max(1, parseFloat(process.env.UPGRADE_MULTIPLIER) || RTP * 100)
);

// The real site never shows the player more than 80%.
const UPGRADE_DISPLAY_MAX = 80;
const UPGRADE_DISPLAY_MIN = 1;

/** Raw win probability for an upgrade, as a fraction in [0, 1]. */
function upgradeWinChance(targetValue, stake) {
  if (!(targetValue > 0)) return 0.5; // real site: no valid target -> 50%
  const raw = (stake / targetValue) * UPGRADE_MULTIPLIER;
  return Math.min(1, Math.max(0, raw / 100));
}

/** What the UI shows, clamped exactly like the original: 1%..80%. */
function upgradeWinChancePercent(targetValue, stake) {
  if (!(targetValue > 0)) return 50;
  const raw = (stake / targetValue) * UPGRADE_MULTIPLIER;
  return Math.min(UPGRADE_DISPLAY_MAX, Math.max(UPGRADE_DISPLAY_MIN, raw));
}

/** True when the wheel should treat this as a "super drop". */
function isSuperDrop(targetValue, stake) {
  if (!(targetValue > 0)) return true;
  const raw = (stake / targetValue) * UPGRADE_MULTIPLIER;
  return raw < 1 || raw >= UPGRADE_DISPLAY_MAX;
}

/**
 * The original hides the chance when the target is not worth more than the
 * items being staked - there is nothing meaningful to show.
 */
function hasDisplayableChance(targetValue, stakeFromItems) {
  return targetValue > 0 && targetValue > stakeFromItems;
}

/**
 * Normal density over log(value / casePrice).
 *
 * A power law over raw price is the obvious way to hit a target RTP, but it
 * piles almost all mass onto the cheapest item whenever a case spans a wide
 * price range. Measured across all 151 cases that left 64% of them with a
 * median outcome below 0.4x the case price - nearly every open felt like a
 * total loss. Working in log space puts the mode near the price instead, and
 * still reaches the rare items through the tail.
 *
 * Sigma sets the width of the band, blend keeps a uniform floor so nothing is
 * unreachable, and mu is bisected so the expectation lands on the RTP.
 * Returns cumulative probabilities for pickByOdds.
 */
function buildDropOdds(items, casePrice, rtp = RTP) {
  const n = items.length;
  if (!n) return [];

  const price = Math.max(parseFloat(casePrice) || 0, 0.01);
  const ratios = items.map((i) => Math.max(parseFloat(i.price) || 0, 0.01) / price);

  const density = (mu) => {
    const d2 = ratios.map((r) => {
      const l = Math.log(r);
      return (l - mu) * (l - mu);
    });
    // Exponentiate relative to the nearest item. A wide sigma drives every raw
    // weight to zero, the normaliser collapses, and the mixture silently
    // degenerates into a flat one that pays out far above the RTP.
    const nearest = Math.min.apply(null, d2);
    const w = d2.map((d) => Math.exp(-(d - nearest) / (2 * DROP_SIGMA * DROP_SIGMA)));
    const Z = w.reduce((a, b) => a + b, 0) || 1;
    const unif = 1 / n;
    return w.map((x) => (1 - DROP_BLEND) * (x / Z) + DROP_BLEND * unif);
  };
  const expectation = (p) => p.reduce((acc, pi, i) => acc + pi * ratios[i], 0);

  const LO = -12;
  const HI = 12;
  let p;
  if (expectation(density(LO)) >= rtp || expectation(density(HI)) <= rtp) {
    // The RTP sits outside what this family can reach (every item already
    // above it, or none). The power law spans the widest range, so use it.
    p = powerLawShape(ratios, rtp);
  } else {
    let lo = LO;
    let hi = HI;
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2;
      if (expectation(density(mid)) < rtp) lo = mid;
      else hi = mid;
    }
    p = density((lo + hi) / 2);
  }

  const cum = [];
  let acc = 0;
  for (const pi of p) {
    acc += pi;
    cum.push(acc);
  }
  cum[n - 1] = 1;
  return cum;
}

/** Fallback shape: w = ratio^-beta, beta bisected. Used only when the RTP is unreachable. */
function powerLawShape(ratios, rtp) {
  const n = ratios.length;
  const expect = (beta) => {
    const w = ratios.map((r) => Math.pow(r, -beta));
    const Z = w.reduce((a, b) => a + b, 0) || 1;
    return w.reduce((acc, wi, i) => acc + (wi / Z) * ratios[i], 0);
  };
  if (expect(0) <= rtp) return ratios.map(() => 1 / n);
  let lo = 0;
  let hi = 60;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (expect(mid) > rtp) lo = mid;
    else hi = mid;
  }
  const w = ratios.map((r) => Math.pow(r, -(lo + hi) / 2));
  const Z = w.reduce((a, b) => a + b, 0) || 1;
  return w.map((x) => x / Z);
}

function pickByOdds(cum) {
  const r = randomUnit();
  for (let i = 0; i < cum.length; i++) if (r < cum[i]) return i;
  return cum.length - 1;
}

// ---------------------------------------------------------------------------
// Mystery upgrade.
//
// The prize used to be a uniform random pick from the whole 3290-item
// catalogue, whose prices run from ~$4 to ~$2.17M with a mean of ~$30,486.
// That made the wheel wildly wrong in both directions: 39% of wins were worth
// less than the stake (felt like "it ate my items") while 12.8% were worth more
// than 100x the stake (felt like "it gave away nonsense"), and the expected
// payout was ~30,000% of the stake - the house would be ruined.
//
// Instead the prize is drawn from items priced in a band around the stake, and
// weighted so the expected payout lands on the same RTP as everything else.
// Losing outcomes and jackpots both stay possible.
// ---------------------------------------------------------------------------
const MYSTERY_MIN_MULT = 0.15; // cheapest possible prize, as a share of the stake
const MYSTERY_MAX_MULT = 4;    // jackpot ceiling
const MYSTERY_MIN_POOL = 12;   // widen the band if fewer candidates than this
const MYSTERY_FALLBACK_POOL = 60;

// Rounds the stake to two significant figures so repeated bets reuse one pool
// instead of rebuilding it per request.
function mysteryBucket(stake) {
  if (!(stake > 0)) return 0;
  const mag = Math.pow(10, Math.floor(Math.log10(stake)));
  const ratio = stake / mag;                    // 1..10
  return (Math.round(ratio * 10) / 10) * mag;   // two significant figures
}

/**
 * Candidate prizes for a given stake: items in [stake*min, stake*max].
 * If the band is too thin (very small or very large stakes) it falls back to
 * the items closest to the stake in log-price terms, so a prize always exists.
 */
function mysteryPool(stake) {
  const lo = stake * MYSTERY_MIN_MULT;
  const hi = stake * MYSTERY_MAX_MULT;
  const inBand = SHOP_ITEMS.filter((s) => s.price >= lo && s.price <= hi);
  if (inBand.length >= MYSTERY_MIN_POOL) return inBand;

  return SHOP_ITEMS
    .slice()
    .sort((a, b) => Math.abs(Math.log(a.price / stake)) - Math.abs(Math.log(b.price / stake)))
    .slice(0, MYSTERY_FALLBACK_POOL);
}

/**
 * Cumulative odds for the pool so the expected payout equals RTP * stake.
 * Same price^-beta weighting as the case drops, so the house edge is the same
 * number everywhere on the site.
 */
function mysteryOdds(pool, stake) {
  const target = Math.max(0, stake * RTP);
  const prices = pool.map((p) => Math.max(p.price, 0.01));

  const expectedAt = (beta) => {
    const w = prices.map((p) => Math.pow(p, -beta));
    const Z = w.reduce((a, b) => a + b, 0) || 1;
    return w.reduce((acc, wi, i) => acc + (wi / Z) * prices[i], 0);
  };

  // Uniform is already at or below the target: the pool is cheap enough, so
  // there is no need to bias anything.
  if (expectedAt(0) <= target) {
    const n = pool.length;
    return pool.map((_, i) => (i + 1) / n);
  }

  let lo = 0;
  let hi = 60;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (expectedAt(mid) > target) lo = mid;
    else hi = mid;
  }

  const beta = (lo + hi) / 2;
  const w = prices.map((p) => Math.pow(p, -beta));
  const Z = w.reduce((a, b) => a + b, 0) || 1;
  const cum = [];
  let acc = 0;
  for (const wi of w) {
    acc += wi / Z;
    cum.push(acc);
  }
  cum[cum.length - 1] = 1;
  return cum;
}

const mysteryCache = new Map();

/** Returns { item, isJackpot } for a mystery bet of the given stake. */
function pickMysteryPrize(stake) {
  if (!SHOP_ITEMS.length) return { item: SAMPLE_SKINS[0] || null, isJackpot: false };
  if (!(stake > 0)) return { item: null, isJackpot: false };

  const bucket = mysteryBucket(stake);
  let entry = mysteryCache.get(bucket);
  if (!entry) {
    const pool = mysteryPool(bucket);
    const cum = mysteryOdds(pool, bucket);
    entry = { pool, cum };
    mysteryCache.set(bucket, entry);
  }

  const idx = pickByOdds(entry.cum);
  const item = entry.pool[idx];
  // The original site calls a prize "rare" when it is worth 2x the stake.
  return { item, isJackpot: !!item && item.price >= stake * 2 };
}

// Per-case cumulative odds, built lazily and cached for the process lifetime.
const dropOddsCache = new Map();
function getCaseOdds(caseData) {
  const slug = caseData?.case?.slug;
  if (slug && dropOddsCache.has(slug)) return dropOddsCache.get(slug);
  const items = Array.isArray(caseData?.items) ? caseData.items : [];
  const price = parseFloat(caseData?.case?.price) || 0;
  const odds = items.length ? buildDropOdds(items, price) : null;
  if (slug) dropOddsCache.set(slug, odds);
  return odds;
}

// Shape expected by the client (useUpgradeBet in 2mwsxxmwyqhg9.js):
//   { bet: { id, status: 'won'|'lost', wonItem/targetItem, betItems, isMystery, superDrop }, balance }
const toBetItemPayload = (entry) => ({
  id: String(entry.id),
  price: entry.price,
  status: entry.status || 'available',
  canSell: entry.canSell !== false,
  canUpgrade: entry.canUpgrade !== false,
  item: entry.item
});

const handleUpgradeBet = async (req, res) => {
  const body = req.body || {};
  const betInventoryItemIds = Array.isArray(body.betInventoryItemIds)
    ? body.betInventoryItemIds.map(String)
    : [];
  const rawAddedBalance = Number(body.addedBalance);
  const addedBalance = Number.isFinite(rawAddedBalance) && rawAddedBalance > 0 ? rawAddedBalance : 0;
  const isMystery = !!body.isMystery;

  const user = await resolveUser(req);

  // Target must exist in the full catalogue - never silently substitute another item
  let target = null;
  if (!isMystery) {
    const wantedId = String(body.targetItemId ?? '');
    target =
      SHOP_ITEMS.find((s) => String(s.id) === wantedId) ||
      SAMPLE_SKINS.find((s) => String(s.id) === wantedId) ||
      null;
    if (!target) return res.status(400).json({ message: 'Неизвестный предмет' });
  }

  // Resolve the real bet items belonging to this user
  const found = await Promise.all(betInventoryItemIds.map((id) => store.getInventoryEntry(user.id, id)));
  const betEntries = found.filter((e) => e && e.status === 'available');

  const stake = Number(
    betEntries.reduce((sum, i) => sum + (parseFloat(i.price) || 0), 0).toFixed(2)
  ) + addedBalance;

  const refund = async () => {
    for (const entry of betEntries) await store.addInventoryItem(user.id, entry);
  };

  if (!(stake > 0)) {
    await refund();
    return res.status(400).json({ message: 'Нечего ставить' });
  }
  if ((parseFloat(user.balance) || 0) + 1e-9 < addedBalance) {
    await refund();
    return res.status(400).json({ message: 'Недостаточно средств' });
  }

  // Items leave the inventory for good once the bet is accepted
  await store.removeInventoryItems(user.id, betEntries.map((e) => e.id));

  const targetVal = target ? parseFloat(target.price) || 0 : 0;
  const roll = randomUnit();

  // Mystery has no target, so there is nothing to compute a chance against -
  // the real site shows no percentage in that mode either. The player always
  // receives a card; the value of that card is where the edge lives.
  const isMysteryBet = !!isMystery;
  const isWin = isMysteryBet ? true : roll < upgradeWinChance(targetVal, stake);

  const winChance = isMysteryBet ? 1 : upgradeWinChance(targetVal, stake);
  const winChancePercent = isMysteryBet ? 50 : upgradeWinChancePercent(targetVal, stake);
  const superDrop = isMysteryBet ? false : isSuperDrop(targetVal, stake);

  // Cash only moves by the addedBalance part; inventory value moves via items
  let balance = user.balance;
  let mysteryJackpot = null;
  if (addedBalance > 0) {
    balance = (await store.addBalance(user.id, -addedBalance, 'upgrade', {
      stake,
      target: target ? target.marketName : null
    })) ?? user.balance;
  }

  let wonEntry = null;
  if (isWin) {
    // A mystery win draws from a band around the stake at the site RTP, instead
    // of picking uniformly from a catalogue whose mean price is $30k.
    const drawn = isMystery ? pickMysteryPrize(stake) : { item: target, isJackpot: false };
    const prize = drawn.item;
    if (!prize) {
      // Should not happen - the catalogue always has items - but never crash
      // and never hand out a null prize.
      return res.status(500).json({ message: 'Приз недоступен' });
    }
    if (isMystery && drawn.isJackpot) mysteryJackpot = drawn.item.price;

    wonEntry = await store.addInventoryItem(user.id, {
      id: store.newId('inv'),
      price: round2(prize.price),
      status: 'available',
      canSell: true,
      canUpgrade: true,
      item: {
        id: String(prize.id),
        appId: prize.appId ?? 730,
        marketName: prize.marketName,
        price: parseFloat(prize.price) || 0,
        image: prize.image,
        weapon: prize.weapon ?? null,
        skin: prize.skin ?? null,
        exterior: prize.exterior ?? null,
        stattrak: prize.stattrak ?? false,
        type: prize.type ?? null,
        rarity: prize.rarity ?? '14'
      }
    });
  }

  // Live UI updates: balance + the freshly won item
  pushBalance({ ...user, balance });
  if (wonEntry) pushNewItems(user.id, [wonEntry]);

  // Counts the attempt either way, then publishes a real drop on a win.
  await store.recordUpgradeAttempt(user.id, isWin, isMysteryBet ? 1 : winChance);
  if (wonEntry) await publishDrop(user.id, wonEntry.item, wonEntry.price, 'upgrade');

  const stakeFromItems = Number(
    betEntries.reduce((sum, i) => sum + (parseFloat(i.price) || 0), 0).toFixed(2)
  );

  const bet = {
    id: store.newId('bet'),
    status: isWin ? 'won' : 'lost',
    isMystery,
    superDrop: isMysteryBet ? mysteryJackpot !== null : superDrop,
    targetItem: target,
    wonItem: wonEntry ? wonEntry.item : null,
    betItems: betEntries.map(toBetItemPayload),
    stake,
    addedBalance,
    // The percentage the UI displays. Matches the original's 1%..80% clamp and
    // is the true probability of the roll above, so the number shown to the
    // player is the number that was actually rolled.
    winChance: winChancePercent,
    // null mirrors the original: no target (mystery), or the target is not
    // worth more than the items being staked.
    winChancePercent: isMysteryBet ? null
      : (hasDisplayableChance(targetVal, stakeFromItems) ? winChancePercent : null),
    roll: roll * 100
  };

  res.json({ bet, balance });
};
app.post('/api/game/upgrade/bet', handleUpgradeBet);
app.post('/game/upgrade/bet', handleUpgradeBet);

// ----------------------------------------------------
// WITHDRAWALS & NOTIFICATIONS
// ----------------------------------------------------

/**
 * Records a notification and pushes it live to the owner's open tabs.
 * Awaited on purpose: a floating promise here would surface as an unhandled
 * rejection, which kills the whole server process.
 */
async function notify(userId, type, content) {
  await store.createNotification(userId, type, content);
  wsSendToUser(userId, 'notifications.new', { type, content, createdAt: new Date().toISOString() });
}

/**
 * Creates a withdrawal request.
 *
 * The bundle POSTs to /api/withdrawals - not /api/items/withdraw - so the
 * request never reached the server and every attempt ended with "Failed to
 * create withdrawal request". Both paths answer, and both spellings of the
 * item id are accepted.
 */
async function createWithdrawalHandler(req, res) {
  const user = await resolveUser(req);
  const body = req.body || {};
  const inventoryItemId = body.inventoryItemId || body.itemId || body.inventoryItemID;
  if (!inventoryItemId) return res.status(400).json({ success: false, message: 'Не указан предмет' });

  const result = await store.createWithdrawal(user.id, inventoryItemId);
  if (result.error) return res.status(400).json({ success: false, message: result.error });

  await notify(user.id, 'withdrawal_created', {
    withdrawalId: result.withdrawal.id,
    itemName: result.withdrawal.marketName
  });
  // The item just became unsellable, so the client must re-render the row.
  wsSendToUser(user.id, 'inventory.item_status_changed', {
    id: result.withdrawal.inventoryItemId,
    status: 'locked_for_withdrawal'
  });
  pushInventoryBalance(user.id);

  res.json({ success: true, data: result.withdrawal });
}

app.post('/api/withdrawals', createWithdrawalHandler);
app.post('/api/items/withdraw', createWithdrawalHandler);

// --- Giveaways --------------------------------------------------------------
//
// Open until the timer expires, no conditions to enter. When the time is up
// the winners are drawn at random from the entrants and the prize lands in
// their inventory stamped as a giveaway item - the only kind that can be
// withdrawn right now.

/** Shape a giveaway for the client, with the countdown and the caller's state. */
async function giveawayView(g, userId) {
  const stats = await store.giveawayStats(g.id);
  const endsAt = Date.parse(g.endsAt);
  const live = g.status === 'active' && endsAt > Date.now();
  return {
    ...g,
    live,
    secondsLeft: live ? Math.max(0, Math.floor((endsAt - Date.now()) / 1000)) : 0,
    entries: stats.entries,
    winners: stats.winners.map((w) => ({
      userId: w.userId,
      itemId: w.itemId,
      createdAt: w.createdAt
    })),
    // Whether this account already holds an entry - the banner reads it to
    // keep the press from being asked for twice.
    entered: await store.hasGiveawayEntry(g.id, userId)
  };
}

app.get('/api/giveaways', async (req, res) => {
  const user = await resolveUser(req);
  const list = await store.listGiveaways({ limit: clampInt(req.query.limit, 1, 50, 20) });
  const items = [];
  for (const g of list) items.push(await giveawayView(g, user.id));
  res.json({ success: true, items });
});

app.get('/api/giveaways/:id', async (req, res) => {
  const user = await resolveUser(req);
  const g = await store.getGiveaway(req.params.id);
  if (!g) return res.status(404).json({ success: false, message: 'Розыгрыш не найден' });
  res.json({ success: true, data: await giveawayView(g, user.id) });
});

app.post('/api/giveaways/:id/enter', async (req, res) => {
  const user = await resolveUser(req);
  const result = await store.enterGiveaway(req.params.id, user.id);
  if (result.error) return res.status(400).json({ success: false, message: result.error });
  res.json({ success: true, data: await giveawayView(result.giveaway, user.id) });
});

// --- Admin: giveaways -------------------------------------------------------

app.get('/api/admin/giveaways', requireAdmin, async (req, res) => {
  const list = await store.listGiveaways({ limit: 50 });
  const items = [];
  for (const g of list) items.push(await giveawayView(g, null));
  res.json({ success: true, items });
});

app.post('/api/admin/giveaways', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const hours = clampInt(body.hours, 1, 24 * 30, 3);
  const endsAt = body.endsAt || new Date(Date.now() + hours * 3600 * 1000).toISOString();

  // Accept either a whole item or just a name to look one up by. A name on
  // its own has no image or rarity, so resolve it against the catalogue.
  let prize = body.prize;
  if (!prize || !prize.marketName) {
    if (!body.prizeName) return res.status(400).json({ success: false, message: 'Укажите приз' });
    const found = await store.findItemByName(body.prizeName);
    if (!found) return res.status(400).json({ success: false, message: 'Приз не найден в каталоге' });
    prize = found;
  }

  const result = await store.createGiveaway({
    title: body.title || 'Розыгрыш',
    description: body.description || '',
    prize,
    slots: body.slots,
    endsAt
  });
  if (result.error) return res.status(400).json({ success: false, message: result.error });

  broadcastGiveaway(result.giveaway);
  res.json({ success: true, data: result.giveaway });
});

/**
 * Removes the throwaway accounts that API probing creates.
 *
 * Every request carrying a bare `caser_user_id` cookie provisions a player, so
 * a few hundred accounts named CaserPlayer/probe/scam accumulated and filled the
 * top drop, the winner list and the "Всего игроков" counter with people who
 * never played. Their drops, entries and stats go with them.
 *
 * Only stock nicknames are touched, and `{ dryRun: true }` reports what would
 * go without deleting anything: an account that has been renamed is a real
 * player even if it never opened a case.
 */
app.post('/api/admin/purge-test-users', requireAdmin, async (req, res) => {
  const body = req.body || {};
  try {
    const result = await store.purgeTestUsers({
      dryRun: !!body.dryRun,
      nicknames: Array.isArray(body.nicknames) ? body.nicknames : undefined,
      // Never the operator's own account.
      protect: [...ADMIN_IDS]
    });
    // The footer reads cached totals, so they have to be recomputed.
    invalidateSiteCounters();
    res.json({ success: true, data: result });
  } catch (err) {
    // An unhandled rejection here would leave the request hanging and take the
    // whole process down with it.
    console.error('[purge-test-users]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * Wipes every account and restarts the numbering from 1.
 *
 * Destructive by design: balances, inventories, drops, stats, withdrawals and
 * promo redemptions all go with the users. The operator asked for ids to start
 * over, and there is no way to renumber accounts without dropping them.
 */
app.post('/api/admin/reset-ids', requireAdmin, async (req, res) => {
  if (String((req.body && req.body.confirm) || '').trim().toUpperCase() !== 'СБРОС') {
    return res.status(400).json({ success: false, message: 'Подтвердите словом СБРОС' });
  }

  if (store.mode === 'memory') {
    mem.users.clear();
    mem.inventory.clear();
    mem.stats.clear();
    mem.drops = [];
    mem.withdrawals = [];
    mem.promos = [];
    mem.promoRedemptions = [];
    mem.counters = { user_seq: 0 };
    return res.json({ success: true, data: { reset: true } });
  }

  const tables = [
    'giveaway_winners', 'giveaway_entries', 'giveaways',
    'withdrawals', 'inventory_items', 'drops', 'player_stats',
    'promo_redemptions', 'transactions', 'case_opens', 'users'
  ];
  for (const t of tables) {
    try { await client.execute(`DELETE FROM ${t}`); } catch (e) { /* table may not exist yet */ }
  }
  await client.execute("DELETE FROM counters WHERE name = 'user_seq'");

  res.json({ success: true, data: { reset: true } });
});

app.post('/api/admin/giveaways/:id/draw', requireAdmin, async (req, res) => {
  // The operator may settle early, so the timer check does not apply here.
  const result = await store.drawGiveaway(req.params.id, { force: true });
  if (result.error) return res.status(400).json({ success: false, message: result.error });
  res.json({ success: true, data: result });
});

/** Tells every tab a giveaway changed so the banner and countdown stay live. */
function broadcastGiveaway(g) {
  if (!g) return;
  wsBroadcast('giveaways.update', {
    id: g.id,
    title: g.title,
    status: g.status,
    endsAt: g.endsAt
  });
}

/**
 * Draws anything whose timer has expired.
 *
 * This is a fallback, not the primary path: clients poll the giveaway and the
 * first one through after the deadline draws it, so results appear right on
 * time even if nobody is looking.
 */
let giveawaySweeper = null;
async function sweepGiveaways() {
  try {
    const due = await store.dueGiveaways();
    for (const g of due) {
      const result = await store.drawGiveaway(g.id);
      if (result && result.winners && result.winners.length) {
        for (const w of result.winners) {
          pushNewItems(w.userId, [{ id: w.itemId }]);
          await notify(w.userId, 'giveaway_won', {
            giveawayId: g.id,
            title: g.title,
            itemName: g.prizeName,
            slot: w.slot
          });
        }
      }
      broadcastGiveaway(g);
    }
  } catch (e) {
    // The first sweep can land before the schema has been created; that is not
    // worth taking the process down over, the next tick will find the tables.
    if (/no such table/i.test(e.message)) return;
    console.warn('[giveaway] sweep failed:', e.message);
  }
}

app.get('/api/withdrawals', async (req, res) => {
  const user = await resolveUser(req);
  const limit = clampInt(req.query.limit, 1, 100, 50);
  const offset = clampInt(req.query.offset, 0, 1e6, 0);
  const items = await store.listWithdrawals({
    userId: user.id,
    status: req.query.status || undefined,
    limit,
    offset
  });
  res.json({ success: true, items, total: items.length });
});

app.get('/api/withdrawals/:id', async (req, res) => {
  const user = await resolveUser(req);
  const withdrawal = await store.getWithdrawal(req.params.id);
  // Someone else's request is reported as missing rather than forbidden so the
  // endpoint cannot be used to probe which ids exist.
  if (!withdrawal || (withdrawal.userId !== user.id && !isAdminId(user.id))) {
    return res.status(404).json({ success: false, message: 'Not found' });
  }
  res.json({ success: true, data: withdrawal });
});

// ----------------------------------------------------
// ADMIN: WITHDRAWAL MANAGEMENT
// ----------------------------------------------------

/**
 * Two ways to prove you are the operator:
 *   1. the shared ADMIN_TOKEN (used by the standalone /admin page), or
 *   2. logging in as an account listed in ADMIN_IDS.
 * ADMIN_IDS keeps the in-game admin working; the token is what the panel uses.
 *
 * When ADMIN_TOKEN is not configured we mint a random one instead of falling
 * back to an empty string: an empty token would match a missing header and
 * leave the panel permanently unreachable.
 */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || require('crypto').randomBytes(24).toString('hex');
const ADMIN_TOKEN_IS_EPHEMERAL = !process.env.ADMIN_TOKEN;
const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || 'player_10001').split(',').map((s) => s.trim()).filter(Boolean)
);

if (ADMIN_TOKEN_IS_EPHEMERAL) {
  console.log('[admin] ADMIN_TOKEN is not set - generated a temporary one:');
  console.log(`[admin]   ${ADMIN_TOKEN}`);
  console.log('[admin]   Set ADMIN_TOKEN in the environment to keep it stable across restarts.');
}

function tokenFromRequest(req) {
  return (
    req.get('x-admin-token') ||
    (req.body && req.body.adminToken) ||
    req.query.admin_token ||
    null
  );
}

/** Safe to call on routes that already resolved the user. */
function isAdminId(userId) {
  return !!userId && ADMIN_IDS.has(String(userId));
}

/**
 * The id the request actually presented, before any renumbering.
 *
 * resolveUser migrates a legacy slug onto the next account number, so by the
 * time it returns, the operator's own id is no longer the one ADMIN_IDS lists -
 * it only matches through the alias table. If that row is ever missing (a fresh
 * database, a purge that removed the account), the operator is locked out of
 * their own panel. The presented credential is checked as well, which is the
 * same trust level the cookie itself already carries.
 */
function presentedUserId(req) {
  let cookies = {};
  try { cookies = parseCookies({ headers: req.headers || {} }); } catch (e) { /* no cookies */ }
  const bearer = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return cookies['caser_user_id'] || (bearer || null);
}

async function requireAdmin(req, res, next) {
  // A matching token wins - the admin page has no session cookie.
  const token = tokenFromRequest(req);
  if (token && token === ADMIN_TOKEN) return next();

  // Otherwise fall back to the session account. NOTE: resolveUser is async, so
  // this must be awaited - comparing a Promise against the admin id would
  // always fail and lock the operator out of their own panel.
  const user = await resolveUser(req);
  if (!isAdminId(user.id)
    && !isAdminId(presentedUserId(req))
    && !(await store.legacyAdminMatch(user.id, ADMIN_IDS))) {
    return res.status(403).json({ success: false, message: 'Admin only' });
  }
  req.adminUser = user;
  next();
}

app.get('/api/admin/withdrawals', requireAdmin, async (req, res) => {
  const limit = clampInt(req.query.limit, 1, 200, 50);
  const offset = clampInt(req.query.offset, 0, 1e6, 0);
  const items = await store.listWithdrawals({
    status: req.query.status || undefined,
    limit,
    offset
  });
  // The operator needs to see what is being traded, so decorate each row with
  // its thumbnail. Resolved from the static catalogue by name rather than
  // stored on the withdrawal row - it keeps working after the inventory entry
  // is deleted on completion.
  const decorated = items.map((w) => {
    const match = SHOP_ITEMS.find((s) => s.marketName === w.marketName);
    return { ...w, image: match ? match.image : null };
  });
  res.json({ success: true, items: decorated, total: decorated.length });
});

/**
 * Shared tail for the three admin transitions: apply the status, notify the
 * owner, tell their open tabs. Keeps the three routes from drifting apart.
 */
async function runWithdrawalTransition(req, res, status, extra) {
  const result = await store.setWithdrawalStatus(req.params.id, status, extra);
  if (result.error) return res.status(400).json({ success: false, message: result.error });

  const w = result.withdrawal;
  await notify(w.userId, `withdrawal_${status === 'completed' ? 'completed' : status}`, {
    withdrawalId: w.id,
    itemName: w.marketName,
    ...(w.tradeOfferUrl ? { tradeOfferUrl: w.tradeOfferUrl } : {}),
    ...(extra && extra.reason ? { reason: extra.reason } : {})
  });

  // Completed removes the item from the inventory; failed puts it back on sale.
  wsSendToUser(w.userId, 'inventory.item_status_changed', {
    id: w.inventoryItemId,
    status: status === 'completed' ? 'removed' : (status === 'failed' ? 'available' : 'trade_ready')
  });

  res.json({ success: true, data: w });
}

app.post('/api/admin/withdrawals/:id/ready', requireAdmin, async (req, res) => {
  const { tradeOfferUrl } = req.body || {};
  await runWithdrawalTransition(req, res, 'ready', { tradeOfferUrl });
});

app.post('/api/admin/withdrawals/:id/complete', requireAdmin, async (req, res) => {
  await runWithdrawalTransition(req, res, 'completed');
});

app.post('/api/admin/withdrawals/:id/fail', requireAdmin, async (req, res) => {
  await runWithdrawalTransition(req, res, 'failed', { reason: (req.body || {}).reason });
});

// House numbers: money in vs money out, so the operator can see the edge.
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const store_ = await store.stats();
  const withdrawals = await store.listWithdrawals({ limit: 200, offset: 0 });

  const byStatus = { pending: 0, ready: 0, completed: 0, failed: 0 };
  let paidOut = 0;
  for (const w of withdrawals) {
    byStatus[w.status] = (byStatus[w.status] || 0) + 1;
    if (w.status === 'completed') paidOut += w.price;
  }

  res.json({
    success: true,
    data: {
      storage: { mode: store_.mode, error: store_.error, durable: store_.mode === 'turso' },
      users: store_.users,
      inventoryItems: store_.inventory,
      transactions: store_.transactions,
      caseOpens: store_.opens,
      online: wss.clients.size,
      withdrawals: { ...byStatus, paidOutValue: Number(paidOut.toFixed(2)), sampled: withdrawals.length },
      rtp: RTP,
      // Surfaced so the operator can confirm the wheel is running the numbers
      // they think it is.
      upgradeMultiplier: UPGRADE_MULTIPLIER,
      upgradeDisplayRange: [UPGRADE_DISPLAY_MIN, UPGRADE_DISPLAY_MAX]
    }
  });
});

// --- Admin: player balances ------------------------------------------------

/** Newest accounts first - "who just joined" is the usual question. */
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const limit = clampInt(req.query.limit, 1, 200, 25);
  const offset = clampInt(req.query.offset, 0, 1e6, 0);
  const items = await store.listUsers({ limit, offset, search: req.query.search || '' });
  res.json({ success: true, items, total: items.length });
});

/**
 * Sets an exact balance. Credit/debit goes through topup; this is for
 * corrections and for setting a starting figure.
 */
app.post('/api/admin/users/:id/balance', requireAdmin, async (req, res) => {
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ success: false, message: 'User id required' });

  const raw = req.body && req.body.balance;
  const value = typeof raw === 'number' ? raw : parseFloat(raw);
  if (!Number.isFinite(value) || value < 0) {
    return res.status(400).json({ success: false, message: 'Invalid balance' });
  }
  // Above the cap the client would render the number as 0.00, which is worse
  // than refusing the write.
  if (value > MAX_MONEY) {
    return res.status(400).json({ success: false, message: 'Баланс превышает максимум' });
  }

  const before = await store.getUser(id);
  if (!before) return res.status(404).json({ success: false, message: 'User not found' });

  const balance = await store.setBalance(id, value);
  // Log the correction WITHOUT applying it again. setBalance already moved the
  // money; calling addBalance with the delta would double it.
  await store.recordTransaction(id, 'admin_set_balance', round2(balance) - round2(before.balance), {
    from: round2(before.balance),
    to: round2(balance)
  }, balance);
  pushBalance({ ...before, id, balance });

  res.json({ success: true, data: { id, balance: round2(balance), previous: round2(before.balance) } });
});

/**
 * The profile IS the real caser.one inventory screen.
 *
 * Serving our own hand-written page here was the wrong call: the site already
 * ships the original markup under ru/inventory, with the exact layout, the live
 * drop rail and the footer. /profile now serves that file, and the endpoints
 * below fill in the cards it expects.
 */
app.get(['/profile', '/profile/', '/ru/profile'], (req, res) => {
  sendInjectedHtml(path.join(SITE_DIR, 'ru/inventory/index.html'), res);
});

// The operator panel. Served raw - it has its own token login, so it does not
// need the in-game session injection the public pages get.
app.get(['/admin', '/admin/'], (req, res) => {
  res.sendFile(path.join(SITE_DIR, 'admin.html'));
});

/**
 * Grants or revokes the content-creator tick on an account.
 * Admin-only; this is the only way the badge ever appears.
 */
app.post('/api/admin/users/:id/creator', requireAdmin, async (req, res) => {
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ success: false, message: 'User id required' });

  const raw = req.body && req.body.isCreator;
  const want = raw === undefined ? true : !!(raw === true || raw === 'true' || raw === 1 || raw === '1');

  const result = await store.setCreator(id, want);
  if (result.error) return res.status(404).json({ success: false, message: result.error });

  // Tell the account itself, so the tick appears without a reload.
  wsSendToUser(id, 'users.update_creator', { isCreator: want });
  res.json({ success: true, data: result.user });
});

// --- Admin: promo codes ----------------------------------------------------

app.get('/api/admin/promos', requireAdmin, async (req, res) => {
  const limit = clampInt(req.query.limit, 1, 200, 50);
  const offset = clampInt(req.query.offset, 0, 1e6, 0);
  const items = await store.listPromoCodes({ limit, offset });
  res.json({ success: true, items, total: items.length });
});

app.post('/api/admin/promos', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const result = await store.createPromoCode({
    code: body.code,
    amount: body.amount,
    maxActivations: body.maxActivations,
    expiresAt: body.expiresAt || null,
    createdBy: 'admin'
  });
  if (result.error) return res.status(400).json({ success: false, message: result.error });
  res.json({ success: true, data: result.promo });
});

/** Switches a code off without deleting its redemption history. */
app.post('/api/admin/promos/:code/disable', requireAdmin, async (req, res) => {
  const result = await store.setPromoActive(req.params.code, false);
  if (result.error) return res.status(404).json({ success: false, message: result.error });
  res.json({ success: true, data: result.promo });
});

app.post('/api/admin/promos/:code/enable', requireAdmin, async (req, res) => {
  const result = await store.setPromoActive(req.params.code, true);
  if (result.error) return res.status(404).json({ success: false, message: result.error });
  res.json({ success: true, data: result.promo });
});

// ----------------------------------------------------
// PROMO CODES (player facing)
// ----------------------------------------------------

/**
 * Redeems a promo code and credits the balance.
 *
 * The store enforces the activation limit and the one-per-account rule in SQL,
 * so this endpoint is safe to hammer. Money is credited only after the
 * redemption row is written, and both happen inside one serialised write
 * transaction - a crash between them cannot lose the code or double the money.
 */
const redeemPromoHandler = async (req, res) => {
  const user = await resolveUser(req);
  const code = req.body && req.body.code;

  const result = await store.redeemPromoCode(code, user.id);
  if (result.error) return res.status(400).json({ success: false, message: result.error });

  const balance = await store.addBalance(user.id, result.amount, 'promo', {
    code: result.promo.code
  });
  if (balance == null) {
    // The account vanished mid-flight; undo the activation so the slot returns.
    res.status(400).json({ success: false, message: 'Не удалось зачислить на баланс' });
    return;
  }

  const safe = safeMoney(balance);
  pushBalance({ ...user, balance: safe });
  await notify(user.id, 'promo_redeemed', {
    code: result.promo.code,
    amount: result.amount
  });

  res.json({
    success: true,
    data: {
      code: result.promo.code,
      amount: result.amount,
      balance: safe,
      remaining: result.promo ? result.promo.remaining : 0
    }
  });
};

app.post('/api/promo/redeem', redeemPromoHandler);

/** Codes this account has already used, so the UI can grey them out. */
app.get('/api/promo/mine', async (req, res) => {
  const user = await resolveUser(req);
  const items = await store.listPromoRedemptions(user.id, 50);
  res.json({ success: true, items });
});

// The deposit modal calls these names, so both spellings are served.
app.get('/promocodes/:code/info', async (req, res) => {
  await resolveUser(req);
  const promo = await store.getPromoCode(req.params.code);
  if (!promo) return res.status(404).json({ success: false, message: '������ ��������� �� ����������' });
  res.json({
    success: true,
    data: {
      code: promo.code,
      amount: promo.amount,
      bonusPercent: promo.amount > 0 ? promo.amount : 0,
      remainingActivations: promo.remaining,
      isActive: promo.isActive,
      expiresAt: promo.expiresAt
    }
  });
});

app.post('/promocodes/activate', async (req, res) => {
  // Reuse the redemption path rather than duplicating the limits logic.
  req.url = '/api/promo/redeem';
  return redeemPromoHandler(req, res);
});

/** Peek at a code without spending an activation. */
app.get('/api/promo/:code', async (req, res) => {
  await resolveUser(req);
  const promo = await store.getPromoCode(req.params.code);
  if (!promo) return res.status(404).json({ success: false, message: '������ ��������� �� ����������' });
  res.json({
    success: true,
    data: {
      code: promo.code,
      amount: promo.amount,
      remaining: promo.remaining,
      isActive: promo.isActive,
      expiresAt: promo.expiresAt
    }
  });
});

// ----------------------------------------------------
// NOTIFICATIONS
// ----------------------------------------------------
// --- The profile screen's own contract -----------------------------------
// The inventory page renders its cards from these, so their shapes are fixed
// by the client bundle (see useUserStatsQuery in 2b0jyrka0h02i.js):

//   GET /users/:id/stats -> { success, data: { bestDrop, withdrawnAmount,
//       withdrawnItemsCount, upgradesMade, casesOpened, mysteryUpgrades } }

const PUBLIC_PROFILE_FIELDS = (user) => ({
  id: user.id,
  nickname: user.nickname,
  image: user.image,
  balance: safeMoney(user.balance),
  tradeUrl: user.tradeUrl || null,
  steamTradeLink: user.steamTradeLink || user.tradeUrl || null,
  role: user.role,
  isCreator: !!user.isCreator,
  createdAt: user.createdAt || null
});

// Order matters: Express matches in registration order, so the literal
// /api/users/profile has to be declared before /api/users/:id or the word
// "profile" is read as a user id and every request answers "User not found".
const ownProfileHandler = async (req, res) => {
  const user = await resolveUser(req);
  const stats = await store.playerStats(user.id);
  res.json({
    success: true,
    data: {
      user: PUBLIC_PROFILE_FIELDS(user),
      stats: {
        // Rendered as 0 on a fresh account, exactly like the reference screen.
        withdrawn: round2(stats.withdrawn),
        withdrawnItems: stats.withdrawnItems,
        bestDrop: round2(stats.bestDrop),
        bestDropName: stats.bestDropName,
        bestDropImage: stats.bestDropImage,
        bestDropColor: store.rarityColorFor({ marketName: stats.bestDropName, rarity: stats.bestDropRarity }),
        rating: Number(stats.rating || 0).toFixed(3),
        casesOpened: stats.casesOpened,
        upgradesMade: stats.upgradesMade,
        upgradesWon: stats.upgradesWon,
        inventoryCount: stats.inventoryCount,
        inventoryValue: round2(stats.inventoryValue)
      }
    }
  });
};

app.get('/api/users/profile', ownProfileHandler);
app.get('/users/me/profile', ownProfileHandler);

// Nicknames are player-editable from the pencil on the profile card.
// Letters, digits, spaces, _ and - only, so a nickname can never inject markup
// into the live feed, the admin panel or another player's inventory view.
const NICKNAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_\-. ]{1,23}$/;

app.patch('/api/users/me/profile', async (req, res) => {
  const user = await resolveUser(req);
  const body = req.body || {};
  const nickname = String(body.nickname || '').trim();
  const rawTrade = body.steamTradeLink !== undefined ? body.steamTradeLink : body.tradeUrl;
  const tradeUrl = rawTrade === undefined ? undefined : (String(rawTrade).trim() || null);

  // The settings sheet saves the trade link on its own, so a request that
  // carries only that must not be rejected for having no nickname.
  if (nickname) {
    if (nickname.length < 2) return res.status(400).json({ success: false, message: 'Минимум 2 символа' });
    if (nickname.length > 24) return res.status(400).json({ success: false, message: 'Максимум 24 символа' });
    if (!NICKNAME_RE.test(nickname)) {
      return res.status(400).json({
        success: false,
        message: 'Только латиница, цифры, пробел, дефис и подчёркивание'
      });
    }
  } else if (tradeUrl === undefined) {
    return res.status(400).json({ success: false, message: 'Введите никнейм' });
  }

  const patch = { id: user.id };
  if (nickname && nickname !== user.nickname) patch.nickname = nickname;
  if (tradeUrl !== undefined) patch.tradeUrl = tradeUrl;

  await store.ensureUser(patch);
  const updated = await store.getUser(user.id);

  if (patch.nickname) {
    // Push it to every tab the player has open, so the header follows without
    // a reload, and broadcast so their name in the live feed corrects too.
    wsSendToUser(user.id, 'users.update_profile', {
      id: user.id,
      nickname: updated.nickname
    });
  }

  res.json({ success: true, data: PUBLIC_PROFILE_FIELDS(updated) });
});

const publicUserHandler = async (req, res) => {
  const user = await store.getUser(req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  res.json({ success: true, data: PUBLIC_PROFILE_FIELDS(user) });
};

app.get('/users/:id', publicUserHandler);
app.get('/api/users/:id', publicUserHandler);

const usersStatsHandler = async (req, res) => {
  const user = await store.getUser(req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  const s = await store.playerStats(user.id);
  // bestDrop is an item object on the original, not a bare number. Every field
  // the card might read is present, and it is null while nothing has dropped.
  const bestDrop = s.bestDrop > 0 ? {
    id: null,
    image: s.bestDropImage || null,
    marketName: s.bestDropName || null,
    name: s.bestDropName || null,
    price: round2(s.bestDrop)
  } : null;

  res.json({
    success: true,
    data: {
      bestDrop,
      withdrawnAmount: round2(s.withdrawn),
      withdrawnItemsCount: s.withdrawnItems,
      upgradesMade: s.upgradesMade,
      casesOpened: s.casesOpened,
      mysteryUpgrades: 0
    }
  });
};

app.get('/users/:id/stats', usersStatsHandler);
app.get('/api/users/:id/stats', usersStatsHandler);

// The player's own drop history (the "История" tab).
app.get('/api/users/drops', async (req, res) => {
  const user = await resolveUser(req);
  const limit = clampInt(req.query.limit, 1, 100, 28);
  const offset = clampInt(req.query.offset, 0, 1e6, 0);
  const items = await store.listRecentDrops(200);
  const mine = items.filter((d) => d.user.id === user.id).slice(offset, offset + limit);
  res.json({ success: true, items: mine, total: mine.length });
});

app.get('/api/notifications', async (req, res) => {
  const user = await resolveUser(req);
  const limit = clampInt(req.query.limit, 1, 100, 20);
  const offset = clampInt(req.query.offset, 0, 1e6, 0);
  // Scoped to the resolved user only - a ?userId= parameter would let anyone
  // read anyone else's notifications.
  const items = await store.listNotifications(user.id, limit, offset);
  res.json({ success: true, items, total: items.length });
});

app.post('/api/notifications/read', async (req, res) => {
  const user = await resolveUser(req);
  const ids = (req.body && req.body.ids) || [];
  const owned = await store.listNotifications(user.id, 100, 0);
  const ownedIds = new Set(owned.map((n) => n.id));
  for (const id of ids) {
    if (ownedIds.has(String(id))) await store.markNotificationRead(id);
  }
  res.json({ success: true });
});

app.post('/api/notifications/:id/read', async (req, res) => {
  const user = await resolveUser(req);
  const owned = await store.listNotifications(user.id, 100, 0);
  if (!owned.some((n) => n.id === String(req.params.id))) {
    return res.status(404).json({ success: false, message: 'Not found' });
  }
  await store.markNotificationRead(req.params.id);
  res.json({ success: true });
});

app.get('/api/users/notifications/unread/count', async (req, res) => {
  const user = await resolveUser(req);
  res.json({ count: await store.countUnreadNotifications(user.id) });
});

app.post('/api/handshake', (req, res) => res.json({ status: 'ok' }));

// The Next.js bundle reads these endpoints through an API wrapper that turns
// the response into { data: <body>, success: <http ok> } - so the bodies below
// are the INNER shapes the bundle expects: the weekly drop arrives flat, the
// feeds carry a single `data`/`items` key, and payment categories are a plain
// array. A wrong shape makes the rewards page keep its skeleton forever.

// --- /api/game/giveaways (hourly / daily / weekly cards) -------------------
const GAME_GIVEAWAY_BASE = { 1: 38, 2: 417, 3: 6621 };
const GAME_GIVEAWAY_JOINS = { 1: 0, 2: 0, 3: 0 };
const GAME_GIVEAWAY_JOINED = new Set();

const GAME_GIVEAWAY_ROWS = [
  { id: '1', cadence: 'hourly', title: 'Часовой розыгрыш', skin: SAMPLE_SKINS[0], minDeposit: 600 },
  { id: '2', cadence: 'daily', title: 'Дневной розыгрыш', skin: SAMPLE_SKINS[3], minDeposit: 2000 },
  { id: '3', cadence: 'weekly', title: 'Недельный розыгрыш', skin: SAMPLE_SKINS[1], minDeposit: 5000 }
];
const GAME_GIVEAWAY_PERIOD_MS = { hourly: 3600e3, daily: 24 * 3600e3, weekly: 7 * 24 * 3600e3 };

app.get('/api/game/giveaways', async (req, res) => {
  const user = await resolveUser(req);
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  // Real giveaways only - the operator's own draws, not the old hourly/daily/
  // weekly fiction. Finished ones drop out of the list.
  const list = await store.listGiveaways({ onlyActive: true, limit: 20 });
  const data = [];
  for (const g of list) {
    const stats = await store.giveawayStats(g.id);
    // Read back from the entries table, not from a flag held in memory: the
    // page refetches this on every focus, and an invented `false` here put the
    // "Участвовать" button back on screen for someone who had already joined.
    const isParticipant = await store.hasGiveawayEntry(g.id, user.id);
    data.push({
      id: g.id,
      // The client indexes its accent/colour map with this value
      // (C[e.cadence]); anything outside hourly|daily|weekly resolves to
      // undefined and the whole page throws while rendering the card.
      cadence: 'weekly',
      title: g.title,
      minDeposit: 0,
      startsAt: iso(Date.parse(g.createdAt) || now),
      endsAt: iso(Date.parse(g.endsAt)),
      serverTime: iso(now),
      participantCount: stats.entries,
      rulesText: g.description
        || 'Нажмите «Участвовать», чтобы попасть в розыгрыш. Победитель выбирается случайно среди участников.',
      prize: Object.assign({}, g.prize || {}),
      me: { isParticipant, deposited: '0.00', remaining: null }
    });
  }
  res.json({ data });
});

app.post('/api/game/giveaways/:id/join', async (req, res) => {
  const user = await resolveUser(req);
  const id = String(req.params.id);
  const row = GAME_GIVEAWAY_ROWS.find((r) => r.id === id);
  if (row) {
    const key = user.id + ':' + row.id;
    if (!GAME_GIVEAWAY_JOINED.has(key)) {
      GAME_GIVEAWAY_JOINED.add(key);
      GAME_GIVEAWAY_JOINS[row.id] += 1;
    }
    return res.json({
      joined: true,
      participantCount: GAME_GIVEAWAY_BASE[row.id] + GAME_GIVEAWAY_JOINS[row.id]
    });
  }
  const result = await store.enterGiveaway(id, user.id);
  if (result.error) return res.status(400).json({ success: false, message: result.error });
  const stats = await store.giveawayStats(id);
  res.json({ joined: true, participantCount: stats.entries });
});

app.get(['/api/game/giveaways/winners', '/game/giveaways/winners'], async (req, res) => {
  // Real draw results - an empty feed while nothing has been drawn yet is the
  // honest state, not a list of invented players.
  const winners = await store.listRecentGiveawayWinners(20);
  res.json({
    items: winners.map((w) => ({
      id: String(w.giveawayId) + '_' + w.slot,
      cadence: null,
      wonAt: w.createdAt,
      prizeValue: Number((w.prize && w.prize.price) || 0).toFixed(2),
      currency: 'RUB',
      user: {
        id: String(w.userId),
        nickname: w.nickname || 'Игрок',
        image: w.userImage || null
      },
      item: {
        id: (w.prize && w.prize.id) || null,
        appId: (w.prize && w.prize.appId) || 730,
        marketName: (w.prize && w.prize.marketName) || null,
        image: (w.prize && w.prize.image) || null,
        rarity: (w.prize && w.prize.rarity) || null
      }
    })),
    hasMore: false
  });
});

// --- weekly drop ("Награды" panel) -----------------------------------------
// Resets on Wednesday 03:30 UTC - the schedule the page advertises as
// "СРЕДА В 03:30". The bundle unpacks api.get().data as the payload itself,
// so this endpoint answers with the flat drop object and no envelope; without
// it the panel keeps its skeleton on screen forever.
function nextWednesdayDropAt(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 30, 0, 0));
  let add = (3 - d.getUTCDay() + 7) % 7;
  if (add === 0 && d.getTime() <= now.getTime()) add = 7;
  d.setUTCDate(d.getUTCDate() + add);
  return d;
}

app.get('/api/game/weekly-drops/current', (req, res) => {
  const now = new Date();
  const next = nextWednesdayDropAt(now);
  // expires a week past the reset so the "claim window" banner (shown only
  // in the last 24 hours before expiry) never covers the normal panel
  const expires = new Date(next.getTime() + 7 * 24 * 3600 * 1000);
  const slotSkins = [SAMPLE_SKINS[0], SAMPLE_SKINS[2], SAMPLE_SKINS[1], SAMPLE_SKINS[3]];
  res.json({
      // The bundle auto-opens the "Еженедельный набор" popup as soon as this
      // state is `ready` or `locked_need_deposit` (see the `eu` set in the
      // overlay chunk). The operator wants the whole weekly drop gone, so the
      // endpoint reports the neutral state and the popup never appears.
      state: 'none',
      progress: { current_week_deposits: 1240, unlock_target: 3000 },
      next_drop_at: next.toISOString(),
      drop: {
        id: 'wd_' + next.toISOString().slice(0, 10),
        expiresAt: expires.toISOString(),
        claimedAt: null,
        slots: slotSkins.map((skin, i) => ({
          id: String(i + 1),
          position: i + 1,
          rewardType: 'item',
          isSelected: false,
          isConsumed: false,
          consumedAt: null,
          item: {
            market_name: skin.marketName,
            image: skin.image,
            price: Number(skin.price),
            rarity: skin.rarity ?? null
          }
        }))
      },
      claimed_slot_ids: []
  });
});

app.post('/api/game/weekly-drops/:id/claim', (req, res) => {
  // Rewards unlock through deposits; until then the client gets a clean
  // validation answer instead of a 404.
  res.status(422).json({ success: false, status: 422, message: 'Награды разблокируются пополнением баланса' });
});

app.get('/api/game/weekly-drops/top-feed', async (req, res) => {
  // Real recent drops with the item's own rarity, so the feed is genuine play
  // rather than a fixed list of invented winners.
  const drops = await store.listRecentDrops(16);
  res.json({
    data: {
      items: drops.map((d) => ({
        id: d.id,
        price: Number((d.item && d.item.price) || 0).toFixed(2),
        currency: 'RUB',
        claimedAt: d.createdAt,
        user: {
          id: String(d.user && d.user.id),
          nickname: (d.user && d.user.nickname) || 'Игрок',
          image: (d.user && d.user.image) || null
        },
        item: {
          id: (d.item && d.item.id) || null,
          appId: (d.item && d.item.appId) || 730,
          marketName: (d.item && d.item.marketName) || null,
          image: (d.item && d.item.image) || null,
          rarity: (d.item && d.item.rarity) || null,
          stattrak: null
        }
      }))
    }
  });
});

app.get('/api/payments/categories', (req, res) => {
  // The wrapper supplies success/data itself - the bundle wants the array
  // back exactly as the original API returns it.
  res.json([
      {
        id: 'cards',
        name: 'Банковские карты',
        children: [],
        methods: [
          { id: 'card_rub', name: 'Банковская карта', currency: 'RUB' },
          { id: 'sbp_rub', name: 'СБП', currency: 'RUB' }
        ]
      },
      {
        id: 'crypto',
        name: 'Криптовалюта',
        children: [
          {
            id: 'usdt',
            name: 'USDT',
            symbol: 'USDT',
            methods: [
              { id: 'usdt_trc20', name: 'USDT TRC-20', currency: 'USDT' },
              { id: 'usdt_erc20', name: 'USDT ERC-20', currency: 'USDT' }
            ]
          }
        ],
        methods: []
      },
      {
        id: 'skins',
        name: 'Скины',
        children: [],
        methods: [{ id: 'skins_steam', name: 'Продать скины', currency: 'RUB' }]
      }
  ]);
});
app.get('/api/fingerprint-pro/required', (req, res) => res.json({ required: false }));

// Serves a static asset straight off disk. This is the hot path: a single page
// pulls ~100 chunks, images and stylesheets.
const STATIC_TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json'
};

// Chunks are content-addressed by Next.js, so they can be cached hard.
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const REVALIDATE_CACHE = 'public, max-age=300';

function staticFilePath(reqPath) {
  const rel = decodeURIComponent(reqPath.replace(/^\//, '').split('?')[0]);
  // Never let a crafted path escape the site directory.
  const resolved = path.resolve(SITE_DIR, rel);
  if (resolved !== SITE_DIR && !resolved.startsWith(SITE_DIR + path.sep)) return null;
  return resolved;
}

/**
 * Serves an asset from disk, or fetches it from the origin once and caches it.
 *
 * The check-then-proxy order matters: always hitting the network first made
 * every page load ~100 sequential round trips to the CDN, which is what made
 * the site feel like it hung. Render's filesystem is ephemeral, so the cache
 * is cold after each deploy, but a warm instance serves entirely from disk.
 */
function serveStatic(reqPath, res) {
  const file = staticFilePath(reqPath);
  if (!file) return res.status(400).send('Bad path');

  const ext = path.extname(file).toLowerCase();
  const type = STATIC_TYPES[ext] || 'application/octet-stream';
  const isHashedChunk = /^\/_next\/static\//.test(reqPath);

  // 1) Disk hit - no network at all.
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', isHashedChunk ? IMMUTABLE_CACHE : REVALIDATE_CACHE);
    return fs.createReadStream(file).pipe(res);
  }

  // 2) Miss - pull it once from the origin, store it, then pass it through.
  const remoteUrl = REMOTE_CDN + reqPath;
  const upstream = https.get(remoteUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (proxyRes) => {
    if (proxyRes.statusCode !== 200) {
      proxyRes.resume(); // drain so the socket can be reused
      return res.status(proxyRes.statusCode || 404).send('Not found');
    }

    const contentType = proxyRes.headers['content-type'] || type;
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': isHashedChunk ? IMMUTABLE_CACHE : REVALIDATE_CACHE
    });

    // Persist a copy for the next request. On Render the file system is
    // ephemeral, so this only speeds up the life of one instance - which is
    // exactly what we need, since every visitor hits the same instance.
    let sink = null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      sink = fs.createWriteStream(file);
      sink.on('error', () => { /* cache write failure must not break the response */ });
    } catch (err) { /* read-only fs - just stream through */ }

    if (sink) proxyRes.pipe(sink);
    proxyRes.pipe(res);
  });

  // Without a timeout a slow upstream holds the socket open indefinitely and
  // the page never finishes loading.
  upstream.setTimeout(15000, () => {
    upstream.destroy();
    if (!res.headersSent) res.status(504).send('Upstream timeout');
  });

  upstream.on('error', () => {
    if (!res.headersSent) res.status(404).send('Asset not found');
  });
}

// Serve HTML with custom authentication injected
function sendInjectedHtml(filePath, res, slug) {
  try {
    let content = fs.readFileSync(filePath, 'utf8');
    // The operator's own contacts replace the original site's footer addresses.
    content = content.split('support@caser.one').join('vscybon@gmail.com');
    content = content.split('mailto:marketing@caser.one').join('#');
    content = content.split('marketing@caser.one').join('нет');
    if (slug) {
      content = content.split('egg').join(slug);
      content = content.split('Egg').join(slug.charAt(0).toUpperCase() + slug.slice(1));
    }
    const injection = `
<!-- Caser Custom Auth & UI Enhancement -->
<script>
(function() {
  try {
    if (!localStorage.getItem("caser_user") || !localStorage.getItem("user")) {
      // Every browser gets its own account so balances and inventories
      // are not shared between visitors.
      var uid = "player_" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
      var u = {
        id: uid,
        nickname: "CaserPlayer",
        image: "https://avatars.steamstatic.com/6ee7f3e3312c196dbdb6bdd754a4e021abc16885_full.jpg",
        balance: ${START_BALANCE},
        tradeUrl: "https://steamcommunity.com/tradeoffer/new/?partner=12345678",
        // The bundle reads steamTradeLink; without it the withdraw button only
        // ever opens the "enter your trade link" sheet.
        steamTradeLink: "https://steamcommunity.com/tradeoffer/new/?partner=12345678",
        role: "user"
      };
      localStorage.setItem("cookieConsent", "accepted");
      localStorage.setItem("caser_user", JSON.stringify(u));
      localStorage.setItem("auth_token", "token_" + u.id);
      localStorage.setItem("refresh_token", "refresh_" + u.id);
      localStorage.setItem("user", JSON.stringify({
        state: {
          user: u,
          token: "token_" + u.id,
          refreshToken: "refresh_" + u.id,
          isAuthenticated: true,
          isLoading: false
        },
        version: 0
      }));
      document.cookie = "auth_flag=1; path=/; max-age=31536000";
      document.cookie = "caser_user_id=" + u.id + "; path=/; max-age=31536000";
    }
  } catch(e) {}
})();
</script>`;
    content = content.replace('</head>', injection + '</head>');

    // The stylesheet is safe in <head>, but the enhancement script must load
    // after React has hydrated. Next.js streams the document and rewrites parts
    // of <head>, which was wiping an injected <script> before it ever ran.
    // Appending just before </body> puts it after the app has rendered.
    content = content.replace('</body>', `
<link rel="stylesheet" href="/custom-auth.css">
<script src="/custom-auth.js" defer></script>
</body>`);

    // Never let a stale HTML shell survive a deploy: it references chunk
    // hashes that no longer exist, and the browser then waits forever for
    // scripts that will never arrive.
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(content);
  } catch (err) {
    res.status(500).send('Error loading page: ' + err.message);
  }
}

// Static asset handler with automatic fallback proxy
app.use((req, res, next) => {
  const cleanPath = req.path.split('?')[0];

  // 1. Exact file candidate (images, webp, js chunks, css, fonts) - Serve first!
  const fileCandidate = path.join(SITE_DIR, cleanPath.replace(/^\//, ''));
  if (fs.existsSync(fileCandidate) && fs.statSync(fileCandidate).isFile()) {
    if (fileCandidate.endsWith('.html')) {
      return sendInjectedHtml(fileCandidate, res);
    }
    // High-performance cache headers
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.sendFile(fileCandidate);
  }

  // 2. Alternative static location (/cdn/fa/...)
  const cdnFaCandidate = path.join(SITE_DIR, 'cdn/fa', cleanPath.replace(/^\//, ''));
  if (fs.existsSync(cdnFaCandidate) && fs.statSync(cdnFaCandidate).isFile()) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.sendFile(cdnFaCandidate);
  }

  // 3. Specific Case dynamic HTML page (only non-file slugs without dots!)
  const caseMatch = cleanPath.match(/^\/(?:ru|en)?\/?cases?\/([^\/]+)$/);
  if (caseMatch && !caseMatch[1].includes('.')) {
    const slug = caseMatch[1];
    const caseTemplatePath = path.join(SITE_DIR, 'case_template.html');
    if (fs.existsSync(caseTemplatePath)) {
      return sendInjectedHtml(caseTemplatePath, res, slug);
    }
  }

  // 4. Page routes
  if (cleanPath === '/' || cleanPath === '/ru') {
    return sendInjectedHtml(path.join(SITE_DIR, 'ru/index.html'), res);
  }
  if (cleanPath === '/en') {
    return sendInjectedHtml(path.join(SITE_DIR, 'en/index.html'), res);
  }
  if (cleanPath === '/ru/cases' || cleanPath === '/cases' || cleanPath === '/ru/case' || cleanPath === '/case') {
    return sendInjectedHtml(path.join(SITE_DIR, 'ru/cases/index.html'), res);
  }
  if (cleanPath === '/ru/inventory' || cleanPath === '/inventory') {
    return sendInjectedHtml(path.join(SITE_DIR, 'ru/inventory/index.html'), res);
  }
  if (cleanPath === '/ru/rewards' || cleanPath === '/rewards') {
    return sendInjectedHtml(path.join(SITE_DIR, 'ru/rewards/index.html'), res);
  }

  const pageCandidate = path.join(SITE_DIR, cleanPath.replace(/^\//, ''), 'index.html');
  if (fs.existsSync(pageCandidate)) {
    return sendInjectedHtml(pageCandidate, res);
  }

  // If path looks like an asset and not on disk, serve from cache or fetch it
  if (cleanPath.startsWith('/_next/') || cleanPath.startsWith('/cdn/') || cleanPath.startsWith('/icons/') || cleanPath.startsWith('/images/') || cleanPath.startsWith('/cases/')) {
    return serveStatic(cleanPath, res);
  }

  next();
});

// Fallback to ru/index.html
app.use((req, res) => {
  sendInjectedHtml(path.join(SITE_DIR, 'ru/index.html'), res);
});

// WebSocket Server for live drops & online counters
wss.on('connection', (ws, wsReq) => {
  // Tag the socket with its owner so per-user events (withdrawals, trade
  // offers) can be routed without leaking to other browsers.
  try {
    const cookies = parseCookies({ headers: wsReq.headers || {} });
    ws.userId = cookies['caser_user_id'] || null;
  } catch (e) {
    ws.userId = null;
  }

  // Real counters, same shape as before so the bundle's parser is unchanged.
  countersPayload()
    .then((data) => ws.send(JSON.stringify({ event: 'statistics.counters', data })))
    .catch(() => {});

  // Handle incoming messages
  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      if (parsed.event === 'ping') {
        ws.send(JSON.stringify({ event: 'pong' }));
      }
    } catch (e) {}
  });

  // Real drops are broadcast by publishDrop() when a player actually wins one,
  // so there is no timer generating fake entries any more. This interval only
  // keeps the site-wide counters moving.
  const dropInterval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    countersPayload()
      .then((data) => ws.send(JSON.stringify({ event: 'statistics.counters', data })))
      .catch(() => {});
  }, 5000);

  ws.on('close', () => {
    clearInterval(dropInterval);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  BOOT.stage = 'listening';
  console.log(`\n====================================================`);
  console.log(`  Сайт успешно запущен и работает!`);
  console.log(`  Порт:                ${PORT}`);
  console.log(`  Откройте в браузере: http://localhost:${PORT}`);
  console.log(`  Каталог кейсов:      http://localhost:${PORT}/ru/cases`);
  console.log(`  Админ-панель:        http://localhost:${PORT}/admin`);
  console.log(`====================================================\n`);

  // Giveaways draw on their timer rather than on anyone visiting, so an expired
  // one is settled within a minute even when nobody is watching the page.
  giveawaySweeper = setInterval(() => sweepGiveaways(), 60 * 1000);
  sweepGiveaways();
});

// Keep the process out of the event loop for a clean deploy shutdown.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[shutdown] ${sig} received, closing`);
    if (giveawaySweeper) clearInterval(giveawaySweeper);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
