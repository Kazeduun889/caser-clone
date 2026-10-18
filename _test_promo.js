/**
 * Promo codes and the creator tick.
 *
 * The risky part is the activation limit: the code must pay out exactly
 * maxActivations times overall, and exactly once per account, even when many
 * people redeem it at the same instant.
 */
const http = require('http');
const HOST = '127.0.0.1', PORT = 3000;
const TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token-123';
const ADMIN = 'caser_user_id=player_10001';
const START = 2043.31;

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (!ok && detail !== undefined ? `\n        ${JSON.stringify(detail).slice(0, 300)}` : ''));
}
const near = (label, a, b) => check(label, Math.abs(Number(a) - Number(b)) < 0.01, { actual: a, expected: b });
/** Equality assertion - needed because `false` and `0` are legitimate values. */
function is(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : `\n        got      ${JSON.stringify(actual)}\n        expected ${JSON.stringify(expected)}`));
}

function call(method, p, { body, cookie, token } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) headers.Cookie = cookie;
    if (token) headers['X-Admin-Token'] = token;
    const r = http.request({ host: HOST, port: PORT, path: p, method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let j; try { j = JSON.parse(b); } catch (e) { j = b; }
        // Capture the cookie the server issues so callers can keep one identity.
        const setCookie = res.headers['set-cookie'];
        resolve({ status: res.statusCode, json: j, setCookie: setCookie && setCookie.map((c) => c.split(';')[0]).join('; ') });
      });
    });
    r.on('error', (e) => resolve({ status: 0, json: String(e) }));
    if (data) r.write(data);
    r.end();
  });
}

/**
 * Creates a visitor and reports the id the server actually issued.
 *
 * The cookie name is only a hint: an unknown identity is minted a fresh
 * sequential number, so the id has to be read back from the account rather
 * than assumed to match the cookie.
 */
async function newPlayer(tag) {
  const cookie = `caser_user_id=player_promo_${tag}_${Math.random().toString(36).slice(2, 8)}`;
  const res = await call('GET', '/api/users/me', { cookie });
  // The server mints its own id and tells the browser what it is via Set-Cookie.
  // Replaying the original hint would mint a fresh account on every request.
  return { id: res.json && res.json.id, cookie: res.setCookie || cookie };
}
const balanceOf = async (cookie) => parseFloat((await call('GET', '/api/users/me', { cookie })).json.balance);
const uniqueCode = (t) => `TEST${t}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

async function main() {
  // ---------- creator tick ----------
  const c1 = await newPlayer('creator');
  const before = await call('GET', '/api/users/me', { cookie: c1.cookie });
  is('new account has no creator tick', before.json.isCreator, false);

  const denied = await call('POST', `/api/admin/users/${c1.id}/creator`, { body: { isCreator: true }, cookie: c1.cookie });
  check('a player cannot grant themselves the tick', denied.status, 403);

  const granted = await call('POST', `/api/admin/users/${c1.id}/creator`, { body: { isCreator: true }, token: TOKEN });
  check('admin can grant the tick', granted.status, 200);
  is('grant reports the new state', granted.json.data && granted.json.data.isCreator, true);

  const after = await call('GET', '/api/users/me', { cookie: c1.cookie });
  is('the account sees the tick', after.json.isCreator, true);
  check('role mirrors the tick', after.json.role, 'creator');

  const revoked = await call('POST', `/api/admin/users/${c1.id}/creator`, { body: { isCreator: false }, token: TOKEN });
  is('admin can revoke the tick', revoked.json.data.isCreator, false);
  is('account no longer sees it', (await call('GET', '/api/users/me', { cookie: c1.cookie })).json.isCreator, false);
  check('role restored to user', (await call('GET', '/api/users/me', { cookie: c1.cookie })).json.role, 'user');

  const ghost = await call('POST', '/api/admin/users/nobody_here/creator', { body: {}, token: TOKEN });
  check('unknown account refuses the tick', ghost.status, 404);

  // ---------- promo creation ----------
  const badCodes = ['', 'ab', 'has space', 'x'.repeat(40), 'bad!chars'];
  let badRejected = 0;
  for (const code of badCodes) {
    const r = await call('POST', '/api/admin/promos', { body: { code, amount: 100, maxActivations: 1 }, token: TOKEN });
    if (r.status === 400) badRejected++;
  }
  check('malformed codes are refused', badRejected, badCodes.length);

  const badAmounts = [0, -5, 'abc', null, 1e21];
  let amountRejected = 0;
  for (const amount of badAmounts) {
    const r = await call('POST', '/api/admin/promos', { body: { code: uniqueCode('A'), amount, maxActivations: 1 }, token: TOKEN });
    if (r.status === 400) amountRejected++;
  }
  check('invalid amounts are refused', amountRejected, badAmounts.length);

  const dupCode = uniqueCode('D');
  const first = await call('POST', '/api/admin/promos', { body: { code: dupCode, amount: 50, maxActivations: 1 }, token: TOKEN });
  check('valid code created', first.status, 200);
  const second = await call('POST', '/api/admin/promos', { body: { code: dupCode, amount: 50, maxActivations: 1 }, token: TOKEN });
  check('duplicate code refused', second.status, 400);

  const noAuth = await call('POST', '/api/admin/promos', { body: { code: uniqueCode('N'), amount: 1, maxActivations: 1 } });
  check('promo creation needs admin', noAuth.status, 403);

  // ---------- redeeming ----------
  const code1 = uniqueCode('R1');
  await call('POST', '/api/admin/promos', { body: { code: code1, amount: 1234.56, maxActivations: 3 }, token: TOKEN });

  const p1 = await newPlayer('p1');
  const b0 = await balanceOf(p1.cookie);
  const r1 = await call('POST', '/api/promo/redeem', { body: { code: code1 }, cookie: p1.cookie });
  check('redeem accepted', r1.status, 200);
  check('amount reported', r1.json.data.amount, 1234.56);
  near('balance credited', await balanceOf(p1.cookie), b0 + 1234.56);
  is('remaining reported', r1.json.data.remaining, 2);

  const again = await call('POST', '/api/promo/redeem', { body: { code: code1 }, cookie: p1.cookie });
  check('same account cannot redeem twice', again.status, 400);
  check('second attempt explains why', /уже использовали/i.test(again.json.message), true);
  near('balance unchanged after the refused second try', await balanceOf(p1.cookie), b0 + 1234.56);

  // Case-insensitive.
  const p1b = await newPlayer('p1b');
  const lower = await call('POST', '/api/promo/redeem', { body: { code: code1.toLowerCase() }, cookie: p1b.cookie });
  check('codes are case-insensitive', lower.status, 200);

  // Third and fourth: the limit is 3.
  const p1c = await newPlayer('p1c');
  const third = await call('POST', '/api/promo/redeem', { body: { code: code1 }, cookie: p1c.cookie });
  check('third activation allowed', third.status, 200);
  is('now exhausted', third.json.data.remaining, 0);

  const p1d = await newPlayer('p1d');
  const fourth = await call('POST', '/api/promo/redeem', { body: { code: code1 }, cookie: p1d.cookie });
  check('fourth activation refused', fourth.status, 400);
  check('refusal says it is used up', /больше не активируется/i.test(fourth.json.message), true);
  near('refused player was not paid', await balanceOf(p1d.cookie), START);

  const unknown = await call('POST', '/api/promo/redeem', { body: { code: 'NOPE123' }, cookie: p1d.cookie });
  check('unknown code refused', unknown.status, 404 === unknown.status ? 404 : unknown.status);
  check('unknown code message', /не существует/i.test(unknown.json.message), true);

  // ---------- concurrency: the limit must hold ----------
  const hot = uniqueCode('HOT');
  const LIMIT = 10;
  await call('POST', '/api/admin/promos', { body: { code: hot, amount: 100, maxActivations: LIMIT }, token: TOKEN });

  const racers = await Promise.all(Array.from({ length: 40 }, async () => {
    const p = await newPlayer('race');
    const before = await balanceOf(p.cookie);
    const res = await call('POST', '/api/promo/redeem', { body: { code: hot }, cookie: p.cookie });
    const after = await balanceOf(p.cookie);
    return { status: res.status, cookie: p.cookie, before, after };
  }));
  const won = racers.filter((r) => r.status === 200).length;
  console.log(`\n  40 simultaneous redemptions -> ${won} succeeded, limit was ${LIMIT}`);
  check(`exactly ${LIMIT} redemptions succeeded`, won, LIMIT);

  const listing = await call('GET', '/api/admin/promos?limit=200', { token: TOKEN });
  const entry = (listing.json.items || []).find((p) => p.code === hot);
  check('activation counter matches', entry && entry.activations, LIMIT);
  check('counter never exceeded the limit', entry && entry.activations <= LIMIT, true);

  // Every winner gained exactly the code amount, and every loser gained nothing.
  const wrongAmount = racers.filter((r) => {
    const delta = Number((r.after - r.before).toFixed(2));
    return r.status === 200 ? delta !== 100 : delta !== 0;
  });
  is('every winner paid exactly once, every loser paid nothing', wrongAmount.length, 0);
  if (wrongAmount.length) console.log('        ', JSON.stringify(wrongAmount.slice(0, 3)));

  // ---------- history ----------
  const mine = await call('GET', '/api/promo/mine', { cookie: p1.cookie });
  check('history lists the used code', (mine.json.items || []).some((i) => i.code === code1), true);
  const mineOther = await call('GET', '/api/promo/mine', { cookie: p1d.cookie });
  is('history is per account', (mineOther.json.items || []).length, 0);

  // ---------- disabling ----------
  const offCode = uniqueCode('OFF');
  await call('POST', '/api/admin/promos', { body: { code: offCode, amount: 500, maxActivations: 5 }, token: TOKEN });
  const pOff = await newPlayer('off');
  await call('POST', `/api/admin/promos/${offCode}/disable`, { token: TOKEN });
  const offRes = await call('POST', '/api/promo/redeem', { body: { code: offCode }, cookie: pOff.cookie });
  check('disabled code is refused', offRes.status, 400);
  check('disabled message', /больше не активен/i.test(offRes.json.message), true);
  await call('POST', `/api/admin/promos/${offCode}/enable`, { token: TOKEN });
  check('re-enabled code works again', (await call('POST', '/api/promo/redeem', { body: { code: offCode }, cookie: pOff.cookie })).status, 200);

  // ---------- peek without spending ----------
  const peekCode = uniqueCode('PEEK');
  await call('POST', '/api/admin/promos', { body: { code: peekCode, amount: 777, maxActivations: 4 }, token: TOKEN });
  const pPeek = await newPlayer('peek');
  const beforePeek = await balanceOf(pPeek.cookie);
  const peek = await call('GET', `/api/promo/${peekCode}`, { cookie: pPeek.cookie });
  check('peek reveals the amount', peek.json.data.amount, 777);
  check('peek reveals remaining', peek.json.data.remaining, 4);
  near('peek did not spend an activation', await balanceOf(pPeek.cookie), beforePeek);

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('CRASH', e); process.exit(1); });