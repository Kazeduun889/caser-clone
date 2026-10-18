/**
 * End-to-end giveaway check, repeatable from any state:
 *  1. the admin creates a fresh giveaway with two slots
 *  2. two players enter
 *  3. the admin draws (the route settles early on purpose)
 *  4. each winner holds an item stamped source='giveaway'
 *  5. that item can be withdrawn; a case-won item cannot
 *
 * The test builds its own giveaway rather than reusing whatever row happens to
 * be first in the table - a leftover finished giveaway made it fail on reruns.
 */
const path = require('path');
const http = require('http');
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
        // The server mints account ids; follow Set-Cookie so a session stays one player.
        const setCookie = res.headers['set-cookie'];
        const issued = (setCookie || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('caser_user_id='));
        resolve({ status: res.statusCode, json, cookie: issued });
      });
    });
    req.on('error', (e) => resolve({ status: 0, json: String(e), cookie: undefined }));
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  // --- 1. fresh giveaway --------------------------------------------------
  const ga = await call('POST', '/api/admin/giveaways', {
    title: 'E2E розыгрыш',
    prizeName: 'Sticker | Please Be Patient',
    slots: 2,
    hours: 1
  });
  check('admin creates a giveaway', ga.status === 200 && ga.json.data && ga.json.data.id, ga.json);
  const gaId = ga.json.data && ga.json.data.id;
  if (!gaId) throw new Error('no giveaway to test with');

  // --- 2. two players enter ----------------------------------------------
  const p1 = await call('GET', '/api/users/me', undefined, 'caser_user_id=ga_e2e_p1_' + Date.now().toString(36));
  const p2 = await call('GET', '/api/users/me', undefined, 'caser_user_id=ga_e2e_p2_' + Date.now().toString(36));
  check('both players got sessions', !!p1.cookie && !!p2.cookie, { p1: p1.cookie, p2: p2.cookie });

  const e1 = await call('POST', `/api/giveaways/${gaId}/enter`, {}, p1.cookie);
  const e2 = await call('POST', `/api/giveaways/${gaId}/enter`, {}, p2.cookie);
  check('first player entered', e1.status === 200 && e1.json.success, e1.json);
  check('second player entered', e2.status === 200 && e2.json.success, e2.json);

  // Re-entry must not double-count.
  const again = await call('POST', `/api/giveaways/${gaId}/enter`, {}, p1.cookie);
  const count = await call('GET', `/api/giveaways/${gaId}`);
  const shown = (count.json.data && count.json.data.entries);
  check('re-entry stays idempotent', shown === 2, { entries: shown });

  // --- 3. draw -------------------------------------------------------------
  const drawn = await call('POST', `/api/admin/giveaways/${gaId}/draw`);
  const winners = (drawn.json.data && drawn.json.data.winners) || [];
  check('admin draws the giveaway', drawn.status === 200, drawn.json);
  check('two winners picked', winners.length === 2, winners);

  // --- 4. winners hold a giveaway-stamped item ----------------------------
  const sessions = { [p1.cookie]: 'игрок 1', [p2.cookie]: 'игрок 2' };
  const won = {};
  for (const w of winners) {
    const inv = await db.execute(
      "SELECT id, source FROM inventory_items WHERE user_id = ? AND source = 'giveaway'",
      [String(w.userId)]
    );
    check(`winner ${w.userId} holds a giveaway item`, inv.rows.length > 0, { rows: inv.rows.length });
    if (inv.rows.length) won[w.userId] = String(inv.rows[0].id);
  }

  // --- 5. the prize can be withdrawn, a case item cannot ------------------
  const winnerCookies = [p1.cookie, p2.cookie].filter(Boolean);
  let withdrawn = 0;
  for (const cookie of winnerCookies) {
    const me = await call('GET', '/api/users/me', undefined, cookie);
    const itemId = won[String(me.json.id)];
    if (!itemId) continue;
    const wd = await call('POST', '/api/items/withdraw', { inventoryItemId: itemId }, cookie);
    if (wd.status === 200 && wd.json.success) withdrawn++;
    else console.log(`        вывод для ${me.json.id}: ${wd.status} ${JSON.stringify(wd.json).slice(0, 160)}`);
  }
  check('a giveaway item was withdrawn', withdrawn > 0, { withdrawn });

  // A case-won item must be refused even when the player may withdraw prizes.
  // Only an untouched ('available') item reaches the source check - a locked or
  // sold one trips the earlier guard and would mask what is being asserted.
  const caseItem = await db.execute(
    "SELECT id, user_id FROM inventory_items WHERE source = 'case' AND status = 'available' LIMIT 1"
  );
  if (caseItem.rows.length) {
    const refused = await call('POST', '/api/items/withdraw',
      { inventoryItemId: caseItem.rows[0].id }, `caser_user_id=${caseItem.rows[0].user_id}`);
    check('case item withdrawal refused',
      refused.status === 400 && /розыгрыша/.test(String(refused.json && refused.json.message)), refused.json);
  } else {
    check('case item withdrawal refused', false, 'no case item in the store to try with');
  }

  // Leave the catalogue clean: the finished test giveaway is not for the site.
  await db.execute("DELETE FROM giveaway_winners WHERE giveaway_id = ?", [gaId]);
  await db.execute("DELETE FROM giveaway_entries WHERE giveaway_id = ?", [gaId]);
  await db.execute("DELETE FROM giveaways WHERE id = ?", [gaId]);

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
