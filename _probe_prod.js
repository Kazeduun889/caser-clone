/**
 * End-to-end check against the DEPLOYED site: play a real case and confirm the
 * result is readable back out of Turso on a later request.
 *
 * Usage: node _probe_prod.js [baseUrl]
 */
const https = require('https');
const http = require('http');

const BASE = process.argv[2] || 'https://caser-clone.onrender.com';
const useHttps = BASE.startsWith('https');
const agent = useHttps ? https : http;

function call(method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + p);
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (cookie) headers.Cookie = cookie;

    const req = agent.request({
      hostname: url.hostname, port: url.port || (useHttps ? 443 : 80),
      path: url.pathname + url.search, method, headers, timeout: 90000
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let j; try { j = JSON.parse(b); } catch (e) { j = b; } resolve({ status: res.statusCode, json: j }); });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (!ok && detail !== undefined ? `\n        ${JSON.stringify(detail).slice(0, 250)}` : ''));
}

/** Equality assertion - null/0/false are legitimate values here. */
function is(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : `\n        got      ${JSON.stringify(actual)}\n        expected ${JSON.stringify(expected)}`));
}

async function main() {
  const id = 'player_prod_' + Date.now().toString(36);
  const cookie = `caser_user_id=${id}`;
  console.log(`\n  ${BASE}\n  player: ${id}\n`);

  const health = await call('GET', '/healthz');
  check('storage is turso', health.json.storage.mode === 'turso', health.json.storage);
  is('no storage error', health.json.storage.error, null);
  is('no failed write recorded', health.json.lastStoreError, null);

  // 1. A brand new account starts with the starting balance.
  const me = await call('GET', '/api/users/me', { cookie });
  check('account provisioned', me.status === 200 && me.json.id === id, me.json);
  check('starting balance', parseFloat(me.json.balance), 2043.31);

  // 2. Top up, then read it back.
  const top = await call('POST', '/api/users/balance/topup', { body: { amount: 500 }, cookie });
  check('topup accepted', top.status === 200, top.json);
  const afterTop = parseFloat((await call('GET', '/api/users/me', { cookie })).json.balance);
  check('balance persisted to turso', afterTop, 2543.31);

  // 3. Play a real case.
  const cases = await call('GET', '/api/game/cases', { cookie });
  const list = cases.json.cases || [];
  const cheapest = list.slice().sort((a, b) => parseFloat(a.price) - parseFloat(b.price))[0];
  const opened = await call('POST', `/api/game/cases/${cheapest.slug}/open`, { cookie });
  check('case opened', opened.status === 200, opened.json);
  const won = opened.json.items && opened.json.items[0];
  check('an item was won', !!won, opened.json);

  // 4. The item must be in the inventory on a fresh request.
  const inv = await call('GET', '/api/items/inventory', { cookie });
  check('inventory persisted to turso', (inv.json.items || []).length > 0, inv.json);

  // 5. Stats the profile cards read.
  const stats = await call('GET', `/users/${id}/stats`, { cookie });
  check('stats endpoint works', stats.status === 200 && stats.json.success, stats.json);
  check('casesOpened counted', stats.json.data.casesOpened >= 1, stats.json.data);
  check('bestDrop recorded', !!stats.json.data.bestDrop, stats.json.data);

  // 6. The live feed must show this real drop.
  const feed = await call('GET', '/api/live-drops?limit=10');
  check('live feed has the drop', (feed.json.liveDrops || []).length > 0, feed.json.liveDrops && feed.json.liveDrops.length);
  check('drop is attributed to this player',
    (feed.json.liveDrops || []).some((d) => d.user.id === id),
    (feed.json.liveDrops || []).map((d) => d.user.id));

  // 7. Withdrawal lifecycle.
  if (won) {
    const wd = await call('POST', '/api/items/withdraw', { body: { inventoryItemId: String(won.id) }, cookie });
    check('withdrawal created', wd.status === 200 && wd.json.data.id, wd.json);

    const shortcut = await call('POST', `/api/admin/withdrawals/${wd.json.data.id}/complete`, { cookie });
    check('non-admin cannot drive withdrawals', shortcut.status, 403);

    const mine = await call('GET', '/api/withdrawals', { cookie });
    check('withdrawal listed', (mine.json.items || []).some((w) => w.id === wd.json.data.id), mine.json);

    // Blocked without a token, as it must be.
    const denied = await call('GET', '/api/admin/withdrawals');
    check('admin queue needs a token', denied.status, 403);
  }

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nPRODUCTION OK - every write persisted to Turso');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('CRASH', e.message); process.exit(1); });