/**
 * Plays real bets so the live feed and the profile tiles have genuine data.
 * Everything here goes through the same HTTP API a player uses - nothing is
 * inserted behind the store's back.
 *
 * Usage: node _seed_live_drops.js [players] [rounds]
 */
const http = require('http');

const HOST = '127.0.0.1', PORT = 3000;
const PLAYERS = parseInt(process.argv[2], 10) || 8;
const ROUNDS = parseInt(process.argv[3], 10) || 12;

const NAMES = ['clipher', 's1mple_win', 'donk', 'm0NESY', 'sh1ro', 'ZywOo', 'huNter-', 'electroNic',
  'n0rb3r7', 'b1t', 'faveN', 'sdy', 'Ax1Le', 'KSCERATO', 'v1nny', 'perfecto', 'woxic', 'Jame'];

function call(method, p, body, cookie) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ host: HOST, port: PORT, path: p, method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let j; try { j = JSON.parse(b); } catch (e) { j = b; } resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', (e) => resolve({ status: 0, json: String(e) }));
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  // Fresh ids every run: /api/auth/session only honours the nickname for a
  // brand-new account, so reusing an id would leave "CaserPlayer" everywhere.
  const stamp = Date.now().toString(36);
  const cases = await call('GET', '/api/game/cases');
  const list = cases.json.cases || [];
  // A spread of price points so the feed looks like a real session.
  const picks = [];
  for (const q of [0.05, 0.35, 0.7, 1]) {
    const sorted = list.slice().sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
    picks.push(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]);
  }
  const slugs = [...new Set(picks.filter(Boolean).map((c) => c.slug))];
  console.log(`cases used: ${slugs.join(', ')}\n`);

  let opens = 0, upgrades = 0;

  for (let p = 0; p < PLAYERS; p++) {
    const id = 'player_live_' + stamp + '_' + p;
    const cookie = `caser_user_id=${id}`;
    await call('GET', '/api/users/me', undefined, cookie);

    // Give them a nickname + balance so the feed reads like real players.
    await call('POST', '/api/auth/session', {
      id, nickname: NAMES[p % NAMES.length],
      image: 'https://avatars.steamstatic.com/' + (p + 1).toString(16).padStart(2, '0') + 'ee7f3e3312c196dbdb6bdd754a4e021abc16885_full.jpg',
      balance: 2043.31
    });
    await call('POST', '/api/users/balance/topup', { amount: 60000 }, cookie);

    for (let r = 0; r < ROUNDS; r++) {
      const slug = slugs[r % slugs.length];

      // 60% case opens, 40% upgrades - roughly how people actually play.
      if (Math.random() < 0.6) {
        const res = await call('POST', `/api/game/cases/${slug}/open`, undefined, cookie);
        if (res.status === 200) opens++;
      } else {
        // Buy a cheap item to bet, then upgrade it into something pricier.
        const opened = await call('POST', `/api/game/cases/${slug}/open`, undefined, cookie);
        if (opened.status !== 200) continue;
        const item = opened.json.items && opened.json.items[0];
        if (!item) continue;

        const shop = await call('GET', `/api/upgrade/shop?priceFrom=${parseFloat(item.price) * 3}&sortBy=price&sortDirection=ASC&limit=5`, undefined, cookie);
        const target = (shop.json.items || [])[0];
        if (!target) continue;

        const bet = await call('POST', '/api/game/upgrade/bet', {
          betInventoryItemIds: [String(item.id)], targetItemId: String(target.id)
        }, cookie);
        if (bet.status === 200) { upgrades++; opens++; }
      }
    }
    process.stdout.write('.');
  }

  console.log('\n');
  const feed = await call('GET', '/api/live-drops?limit=10');
  console.log(`case opens:   ${opens}`);
  console.log(`upgrades:     ${upgrades}`);
  console.log(`drops in feed: ${feed.json.liveDrops.length}  (hot: ${feed.json.hotDrops.length})`);
  if (feed.json.liveDrops[0]) {
    const d = feed.json.liveDrops[0];
    console.log(`newest: ${d.user.nickname} -> ${d.item.marketName} @ $${d.item.price} (${d.item.rarity})`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });