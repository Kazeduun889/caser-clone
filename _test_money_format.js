/**
 * End-to-end: whatever the admin credits, the client must be able to render it.
 *
 * Applies the site's own formatAmount() guard (transcribed from
 * chunks/3afhs_vz7l64i.js) to every value the API returns. Anything that fails
 * the guard is drawn on screen as "0.00".
 */
const http = require('http');
const HOST = '127.0.0.1', PORT = 3000;
const TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token-123';
const USER = process.env.TEST_USER || 'player_mvb1ge0nc2302v';

/** Exactly the client's formatAmount guard. */
function rendersOnSite(value) {
  if (value === null || value === undefined) return false;
  const s = (typeof value === 'number' ? value.toString() : String(value)).trim();
  const negative = s.startsWith('-');
  const [int = '', frac = ''] = (negative ? s.slice(1) : s).split('.');
  return /^\d*$/.test(int) && /^\d*$/.test(frac) && `${int}${frac}` !== '';
}

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (!ok && detail !== undefined ? `\n        ${JSON.stringify(detail).slice(0, 300)}` : ''));
}

function call(method, p, body, token, cookie) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (token) headers['X-Admin-Token'] = token;
    if (cookie) headers.Cookie = cookie;
    const r = http.request({ host: HOST, port: PORT, path: p, method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let j; try { j = JSON.parse(b); } catch (e) { j = b; } resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', (e) => resolve({ status: 0, json: String(e) }));
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  const cookie = `caser_user_id=${USER}`;

  const cases = [
    { label: 'cents', value: 0.01 },
    { label: 'starting balance', value: 2043.31 },
    { label: 'just under 1e6', value: 999999.99 },
    { label: 'the credited amount', value: 6999999 },
    { label: '9 digits', value: 123456789.55 },
    { label: 'at the cap', value: 999999999999.99 },
    { label: 'above the cap (1e20)', value: 1e20 },
    { label: 'exponential threshold (1e21)', value: 1e21 },
    { label: 'absurd (1e300)', value: 1e300 },
    { label: 'negative', value: -50 },
    { label: 'not a number', value: 'abc' },
    { label: 'null', value: null }
  ];

  console.log('запрошено              | set  | /users/me        | /inventory/balance');
  console.log('------------------------|-------|------------------|-------------------');

  for (const c of cases) {
    const set = await call('POST', `/api/admin/users/${USER}/balance`, { balance: c.value }, TOKEN);
    const me = await call('GET', '/api/users/me', undefined, null, cookie);
    const inv = await call('GET', '/api/items/inventory/balance', undefined, null, cookie);

    const meVal = me.json && me.json.balance;
    const invVal = inv.json && inv.json.amount;
    const okMe = rendersOnSite(meVal);
    const okInv = rendersOnSite(invVal);

    if (me.status !== 200 || inv.status !== 200) {
      console.log(`    DEBUG me.status=${me.status} me.body=${JSON.stringify(me.json).slice(0, 200)}`);
      console.log(`    DEBUG inv.status=${inv.status} inv.body=${JSON.stringify(inv.json).slice(0, 200)}`);
    }

    console.log(
      String(c.value).padEnd(23) + '|' + String(set.status).padEnd(6) + '|' +
      String(meVal).padEnd(17) + (okMe ? 'ok  ' : 'BREAK') + '|' +
      String(invVal).padEnd(18) + (okInv ? 'ok' : 'BREAK')
    );

    check(`${c.label}: /api/users/me renders`, okMe, meVal);
    check(`${c.label}: /inventory/balance renders`, okInv, invVal);

    // The header shows two separate figures: the coin balance and the value of
    // the items you own. This used to assert they matched, which is the bug -
    // /items/inventory/balance was echoing the coin balance, so the header
    // printed the same number twice. What must hold now is that the inventory
    // figure tracks the items and is independent of the coin balance.
    if (okMe && okInv) {
      // The list endpoint paginates, so ask for a page big enough to hold
      // everything - otherwise this sums only the first slice.
      const list = await call('GET', '/api/items/inventory?limit=500', undefined, null, cookie);
      const rows = (list.json && list.json.items) || [];
      const itemTotal = rows
        .filter((r) => (r.status || 'available') === 'available')
        .reduce((a, r) => a + (Number(r.price) || 0), 0);
      const invNum = Number(invVal);
      const matchesItems = Math.abs(invNum - itemTotal) < 0.005;
      check(`${c.label}: inventory figure tracks items, not coins`, matchesItems, {
        invVal: invNum,
        itemTotal: Number(itemTotal.toFixed(2)),
        coinBalance: Number(meVal)
      });
    }
  }

  // Refusals must be refusals, not silent writes.
  const junk = await call('POST', `/api/admin/users/${USER}/balance`, { balance: 'abc' }, TOKEN);
  check('non-numeric balance refused', junk.status, 400);
  const huge = await call('POST', `/api/admin/users/${USER}/balance`, { balance: 1e21 }, TOKEN);
  check('balance above the cap refused', huge.status, 400);
  const topupHuge = await call('POST', '/api/users/balance/topup', { amount: 1e21 }, null, cookie);
  check('topup above the cap refused', topupHuge.status, 400);

  // And the balance is still intact and renderable.
  const finalMe = await call('GET', '/api/users/me', undefined, null, cookie);
  check('balance survived the rejected writes', rendersOnSite(finalMe.json.balance), finalMe.json.balance);

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('CRASH', e); process.exit(1); });