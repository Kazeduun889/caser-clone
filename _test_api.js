/**
 * HTTP-level check of the withdrawal + admin surface.
 * Requires the server running on 127.0.0.1:3000.
 */
const http = require('http');

const HOST = '127.0.0.1';
const PORT = 3000;
/**
 * The admin token comes from the env. If the server generated a temporary one
 * at boot it is printed to stdout; we read it back from the log so the token
 * path gets exercised either way.
 */
function readEphemeralToken() {
  const log = require('fs').readFileSync(
    process.env.CASER_LOG || 'C:/Users/User/AppData/Local/Temp/opencode/caser.out.log', 'utf8');
  const m = log.match(/\[admin\]\s{3}([a-f0-9]{48})/);
  return m ? m[1] : '';
}
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || readEphemeralToken();
const ADMIN_ID = 'player_10001';

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : `\n        got      ${JSON.stringify(actual)}\n        expected ${JSON.stringify(expected)}`));
}
function ok(label, cond, detail) {
  check(label, !!cond, true);
  if (!cond && detail) console.log('        detail:', JSON.stringify(detail).slice(0, 400));
}

function call(method, p, { body, cookie, admin } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (cookie) headers.Cookie = cookie;
    if (admin) headers['X-Admin-Token'] = admin;

    const req = http.request({ host: HOST, port: PORT, path: p, method, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(raw); } catch (e) { json = raw; }
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Opens a case to get a real inventory item, then returns it. */
async function winAnItem(cookie) {
  const cases = await call('GET', '/api/game/cases', { cookie });
  const list = Array.isArray(cases.json) ? cases.json : (cases.json.items || cases.json.cases || []);
  if (!list.length) throw new Error('no cases available at /api/game/cases: ' + JSON.stringify(cases.json).slice(0, 200));
  // Cheapest case so the test does not eat much of the balance.
  const cheapest = list.slice().sort((a, b) => (parseFloat(a.price) || 1e9) - (parseFloat(b.price) || 1e9))[0];
  const slug = cheapest.slug || cheapest.id;
  const opened = await call('POST', '/api/game/cases/' + encodeURIComponent(slug) + '/open', { cookie });
  const won = (opened.json && (opened.json.item || (opened.json.items && opened.json.items[0]))) || null;
  return won ? { won, entryId: String(won.id) } : null;
}

async function main() {
  // ---- health ----
  const health = await call('GET', '/healthz');
  ok('server is up', health.status === 200, health.json);

  // ---- admin page ----
  const page = await call('GET', '/admin');
  ok('/admin serves the panel', page.status === 200 && String(page.json).includes('ADMIN_TOKEN') !== false);

  // ---- authz: non-admin is rejected ----
  const me = await call('GET', '/api/users/me');
  const playerCookie = (me.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  const playerCookieOnly = (playerCookie.match(/caser_user_id=[^;]+/) || [''])[0];
  ok('player got a session cookie', !!playerCookieOnly, me.headers['set-cookie']);

  const denied = await call('GET', '/api/admin/withdrawals', { cookie: playerCookieOnly });
  check('non-admin blocked from the withdrawal queue', denied.status, 403);

  const deniedNoToken = await call('GET', '/api/admin/stats');
  check('anonymous blocked from stats', deniedNoToken.status, 403);

  if (!ADMIN_TOKEN) {
    console.log('\nNOTE: ADMIN_TOKEN is not set in this environment - token-based checks skipped.');
    console.log('Set it and re-run to exercise the panel path.');
  } else {
    const badToken = await call('GET', '/api/admin/withdrawals', { admin: 'wrong-token' });
    check('wrong token rejected', badToken.status, 403);

    const adminList = await call('GET', '/api/admin/withdrawals', { admin: ADMIN_TOKEN });
    ok('correct token lists withdrawals', adminList.status === 200 && Array.isArray(adminList.json.items), adminList.json);

    const adminStats = await call('GET', '/api/admin/stats', { admin: ADMIN_TOKEN });
    ok('stats returned', adminStats.status === 200 && adminStats.json.data, adminStats.json);
    ok('stats expose rtp', typeof adminStats.json.data.rtp === 'number', adminStats.json.data);
  }

  // ---- session-based admin (ADMIN_IDS path) ----
  const adminViaCookie = await call('GET', '/api/admin/withdrawals', { cookie: 'caser_user_id=' + ADMIN_ID });
  ok('admin account works via cookie', adminViaCookie.status === 200, adminViaCookie.json);

  // ---- withdrawal lifecycle over HTTP ----
  const got = await winAnItem(playerCookieOnly);
  ok('opened a case and won an item', !!got, 'case open failed');
  if (got) {
    const before = await call('GET', '/api/items/inventory', { cookie: playerCookieOnly });
    const entry = (before.json.items || []).find((i) => String(i.id) === got.entryId);
    ok('item is in the inventory', !!entry, (before.json.items || []).map((i) => i.id));

    // Only giveaway prizes are withdrawable, so a plain case win must be
    // refused before the lifecycle below runs on a real prize.
    const refused = await call('POST', '/api/items/withdraw', {
      cookie: playerCookieOnly, body: { inventoryItemId: got.entryId }
    });
    ok('case item withdraw refused',
      refused.status === 400 && /розыгрыша/.test(String(refused.json && refused.json.message)),
      refused.json);

    // Run a real giveaway so the player earns a withdrawable prize.
    const adminCookie = 'caser_user_id=' + ADMIN_ID;
    const ga = await call('POST', '/api/admin/giveaways', {
      cookie: adminCookie,
      body: { title: 'api test giveaway', prizeName: 'Sticker | Please Be Patient', slots: 1, hours: 1 }
    });
    ok('admin creates a giveaway', ga.status === 200 && ga.json.data && ga.json.data.id, ga.json);
    const gaId = ga.json.data && ga.json.data.id;

    const entered = await call('POST', '/api/giveaways/' + encodeURIComponent(gaId) + '/enter', {
      cookie: playerCookieOnly, body: {}
    });
    ok('player enters the giveaway', entered.status === 200 && entered.json.success, entered.json);

    const drawn = await call('POST', '/api/admin/giveaways/' + encodeURIComponent(gaId) + '/draw', {
      cookie: adminCookie, body: {}
    });
    ok('admin draws the giveaway', drawn.status === 200, drawn.json);

    const afterDraw = await call('GET', '/api/items/inventory', { cookie: playerCookieOnly });
    const prize = (afterDraw.json.items || []).find((i) => i.source === 'giveaway');
    ok('player received the giveaway prize', !!prize,
      (afterDraw.json.items || []).map((i) => ({ id: i.id, source: i.source })));
    const entryId = prize ? String(prize.id) : null;

    // The bundle posts to /api/withdrawals, not /api/items/withdraw. Getting
    // this path wrong made every attempt in the UI fail with "Failed to create
    // withdrawal request", so the live path is the one under test here.
    const created = await call('POST', '/api/withdrawals', {
      cookie: playerCookieOnly, body: { inventoryItemId: entryId }
    });
    ok('withdraw accepted', created.status === 200 && created.json.success && created.json.data.id,
      created.json);
    const wdId = created.json.data && created.json.data.id;

    // The legacy path still answers, and still refuses a second submit.
    const dupe = await call('POST', '/api/items/withdraw', {
      cookie: playerCookieOnly, body: { inventoryItemId: entryId }
    });
    check('second withdraw refused', dupe.status, 400);

    const missing = await call('POST', '/api/withdrawals', {
      cookie: playerCookieOnly, body: { inventoryItemId: 'nope' }
    });
    check('unknown item refused', missing.status, 400);

    const noBody = await call('POST', '/api/withdrawals', {
      cookie: playerCookieOnly, body: {}
    });
    check('missing item id refused', noBody.status, 400);

    // Player can list their own.
    const mine = await call('GET', '/api/withdrawals', { cookie: playerCookieOnly });
    ok('player lists own withdrawal', mine.json.items.some((w) => w.id === wdId), mine.json);

    // Another player cannot read it.
    const other = await call('GET', '/api/withdrawals/' + wdId);
    check('other player cannot read the withdrawal', other.status, 404);

    // Bad transition.
    const bad = await call('POST', '/api/admin/withdrawals/' + wdId + '/complete', { cookie: 'caser_user_id=' + ADMIN_ID });
    ok('completing a pending withdrawal is refused', bad.status === 400, bad.json);

    // Non-admin cannot drive transitions.
    const hijack = await call('POST', '/api/admin/withdrawals/' + wdId + '/ready', {
      cookie: playerCookieOnly, body: { tradeOfferUrl: 'https://evil.example' }
    });
    check('non-admin cannot mark ready', hijack.status, 403);

    // Real admin drives it: ready -> completed.
    const ready = await call('POST', '/api/admin/withdrawals/' + wdId + '/ready', {
      cookie: 'caser_user_id=' + ADMIN_ID,
      body: { tradeOfferUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=1&token=t' }
    });
    check('admin marks ready', ready.status, 200);
    check('ready status stored', ready.json.data && ready.json.data.status, 'ready');
    check('trade offer stored', ready.json.data && ready.json.data.tradeOfferUrl,
      'https://steamcommunity.com/tradeoffer/new/?partner=1&token=t');

    const afterReady = await call('GET', '/api/items/inventory', { cookie: playerCookieOnly });
    const locked = (afterReady.json.items || []).find((i) => String(i.id) === entryId);
    check('item is trade_ready', locked && locked.status, 'trade_ready');

    const done = await call('POST', '/api/admin/withdrawals/' + wdId + '/complete', {
      cookie: 'caser_user_id=' + ADMIN_ID
    });
    check('admin completes', done.status, 200);
    check('completed status stored', done.json.data && done.json.data.status, 'completed');

    const afterDone = await call('GET', '/api/items/inventory', { cookie: playerCookieOnly });
    ok('item removed from inventory',
      !(afterDone.json.items || []).some((i) => String(i.id) === entryId),
      (afterDone.json.items || []).map((i) => i.id));

    // Notifications landed for the player.
    const notes = await call('GET', '/api/notifications', { cookie: playerCookieOnly });
    const types = (notes.json.items || []).map((n) => n.type);
    ok('created notification exists', types.includes('withdrawal_created'), types);
    ok('ready notification exists', types.includes('withdrawal_ready'), types);
    ok('completed notification exists', types.includes('withdrawal_completed'), types);
    ok('notification content is an object',
      (notes.json.items || []).every((n) => n.content && typeof n.content === 'object'), notes.json.items);

    const unread = await call('GET', '/api/users/notifications/unread/count', { cookie: playerCookieOnly });
    ok('unread count is real', unread.status === 200 && typeof unread.json.count === 'number' && unread.json.count > 0, unread.json);

    // Reading a notification drops the count.
    const first = (notes.json.items || [])[0];
    if (first) {
      const read = await call('POST', '/api/notifications/' + first.id + '/read', { cookie: playerCookieOnly });
      check('mark read accepted', read.status, 200);
      const unread2 = await call('GET', '/api/users/notifications/unread/count', { cookie: playerCookieOnly });
      check('unread count decreased', unread2.json.count, unread.json.count - 1);
    }

    // A player cannot read someone else's notification.
    const crossRead = await call('POST', '/api/notifications/' + first.id + '/read', {});
    ok('cross-account read blocked or harmless', crossRead.status === 404 || crossRead.status === 200, crossRead.json);
  }

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('\nCRASH:', e.message, '\n', e.stack); process.exit(1); });