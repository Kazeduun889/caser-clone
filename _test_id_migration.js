/**
 * Checks the legacy-slug renumbering end to end:
 *   1. a slug account with balance and an item is renumbered on first contact,
 *      with Set-Cookie pointing at the new number and all data carried over;
 *   2. a second visit through the alias lands on the same numbered account;
 *   3. the operator's ADMIN_IDS slug still proves admin after renumbering.
 */
const http = require('http');
const path = require('path');
const { createClient } = require('@libsql/client');

const TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token-123';
const db = createClient({ url: 'file:' + path.join(__dirname, 'data', 'caser.db') });

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (!ok && detail !== undefined ? `\n        ${JSON.stringify(detail).slice(0, 300)}` : ''));
}

function call(method, p, body, cookie) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { 'x-admin-token': TOKEN };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port: 3000, path: p, method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(b); } catch (e) { json = b; }
        const set = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]);
        resolve({ status: res.statusCode, json, setCookie: set });
      });
    });
    req.on('error', (e) => resolve({ status: 0, json: String(e), setCookie: [] }));
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const slug = 'player_migtest_' + Date.now().toString(36);

  // A realistic old account: balance, an item, stats.
  const nowIso = new Date().toISOString();
  await db.execute({
    sql: "INSERT INTO users (id, nickname, image, balance, trade_url, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    args: [slug, 'Старый Игрок', 'x.webp', 5000, null, 'user', nowIso, nowIso]
  });
  await db.execute({
    sql: "INSERT INTO inventory_items (id, user_id, market_name, price, status, can_sell, can_upgrade, item_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    args: ['legacyitem1', slug, 'AK | Test', 123.45, 'available', 1, 1, '{"marketName":"AK | Test"}', new Date().toISOString()]
  });
  await db.execute({
    sql: "INSERT INTO player_stats (user_id, cases_opened, upgrades_made, upgrades_won, best_drop, best_drop_name) VALUES (?, ?, ?, ?, ?, ?)",
    args: [slug, 42, 7, 3, 999.99, 'Legacy | Item']
  });

  // 1. first contact: renumbered, data intact.
  const me = await call('GET', '/api/users/me', undefined, 'caser_user_id=' + slug);
  const newCookie = (me.setCookie || []).find((c) => c.startsWith('caser_user_id='));
  // The cookie is "<id>.<signature>" now; the account is the part before the dot.
  const newId = newCookie ? newCookie.split('=')[1].split('.')[0] : null;
  check('cookie was rewritten to a number', !!newId && /^\d+$/.test(newId), me.setCookie);
  check('nickname survived', me.json.nickname === 'Старый Игрок', me.json.nickname);
  check('balance survived', Math.abs(Number(me.json.balance) - 5000) < 0.01, me.json.balance);

  const inv = await db.execute('SELECT user_id FROM inventory_items WHERE id = ?', ['legacyitem1']);
  check('inventory item moved to the new id', inv.rows.length && String(inv.rows[0].user_id) === newId, inv.rows);
  const stats = await db.execute('SELECT user_id, cases_opened FROM player_stats WHERE user_id = ?', [newId]);
  check('stats moved to the new id', stats.rows.length && Number(stats.rows[0].cases_opened) === 42, stats.rows);
  const gone = await db.execute('SELECT id FROM users WHERE id = ?', [slug]);
  check('old slug row is gone', gone.rows.length === 0, gone.rows);
  const alias = await db.execute('SELECT new_id FROM id_aliases WHERE old_id = ?', [slug]);
  check('alias recorded', alias.rows.length && String(alias.rows[0].new_id) === newId, alias.rows);

  // 2. second visit through the old cookie: same account, no renumbering.
  const again = await call('GET', '/api/users/me', undefined, 'caser_user_id=' + slug);
  const againCookie = (again.setCookie || []).find((c) => c.startsWith('caser_user_id='));
  check('alias lands on the same account', again.json.id === newId, { got: again.json.id, want: newId });
  check('cookie still points at the number', !againCookie || againCookie.split('=')[1].split('.')[0] === newId, again.setCookie);

  // 3. the operator slug keeps admin rights after renumbering.
  const admin = await call('GET', '/api/admin/stats', undefined, 'caser_user_id=player_10001');
  check('ADMIN_IDS slug still proves admin', admin.status === 200, admin.status);

  // cleanup of the fixture
  await db.execute('DELETE FROM inventory_items WHERE id = ?', ['legacyitem1']);
  await db.execute('DELETE FROM player_stats WHERE user_id = ?', [newId]);
  await db.execute('DELETE FROM id_aliases WHERE old_id = ?', [slug]);
  await db.execute('DELETE FROM users WHERE id = ?', [newId]);

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
