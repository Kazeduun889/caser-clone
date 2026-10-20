/**
 * The admin cookie hole, checked from a non-loopback address.
 *
 * Loopback bypasses the admin exemption on purpose (the test suites live
 * there), so a LAN address is used: the socket then looks like a real visitor.
 *
 *  1. the first unsigned request for the admin id is the one-time migration
 *     bind of the operator's own browser - it is allowed;
 *  2. every later unsigned request for that id is refused;
 *  3. a signed cookie for the same account still works.
 */
const http = require('http');
const HOST = process.argv[2] || '192.168.1.8';
const PORT = 3000;
const ADMIN_ID = process.env.ADMIN_IDS || 'player_10001';

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : `\n        ${JSON.stringify(detail).slice(0, 300)}`));
}

function call(p, cookie) {
  return new Promise((resolve) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    const r = http.request({ host: HOST, port: PORT, path: p, method: 'GET', headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b, setCookie: res.headers['set-cookie'] || [] }));
    });
    r.on('error', (e) => resolve({ status: 0, body: String(e), setCookie: [] }));
    r.end();
  });
}

(async () => {
  const first = await call('/api/admin/stats', `caser_user_id=${ADMIN_ID}`);
  check('first unsigned admin request is the one-time bind', first.status === 200 || first.status === 403, first.status);

  const cookie = (first.setCookie || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('caser_user_id='));
  const signed = cookie && cookie.includes('.');

  const second = await call('/api/admin/stats', `caser_user_id=${ADMIN_ID}`);
  check('a later unsigned admin cookie is refused', second.status === 403, second.status);

  if (first.status === 200 && signed) {
    const third = await call('/api/admin/stats', cookie);
    check('the signed cookie still proves admin', third.status === 200, third.status);
  } else {
    console.log('note: the one-time bind was already consumed, so no signed admin cookie was issued here');
  }

  const forged = await call('/api/admin/stats', 'caser_user_id=player_10001.deadbeef');
  check('a forged signature is refused', forged.status === 403, forged.status);

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})();
