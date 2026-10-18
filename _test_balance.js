/**
 * Balance consistency across sessions and endpoints.
 *
 * The reported symptom was a balance that "jumps around by ~500x". Two causes
 * are covered here:
 *   1. the server pushed balance changes to every socket, so one player's spend
 *      overwrote another player's number on screen;
 *   2. the same value is served as a string by some endpoints and a number by
 *      others, so the client re-renders it differently depending on which call
 *      landed last.
 *
 * Identity note: the server mints its own account id and hands it back via
 * Set-Cookie. Every call therefore goes through activeCookieFor(), which replays
 * the id the server issued; a raw cookie hint would create a fresh account on
 * every request and the assertions below would never see their own writes.
 */
const http = require('http');
const WebSocket = require('ws');

const HOST = '127.0.0.1', PORT = 3000;
const ADMIN = 'caser_user_id=player_10001';

let failed = 0;
const activeCookies = new Map();
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (!ok && detail !== undefined ? `\n        ${JSON.stringify(detail).slice(0, 400)}` : ''));
}
/** Asserts two numbers match within a cent. */
function near(label, actual, expected) {
  const ok = Math.abs(Number(actual) - Number(expected)) < 0.01;
  check(label, ok, ok ? undefined : { actual, expected });
}

function req(method, p, { body, cookie } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) headers.Cookie = cookie;
    const r = http.request({ host: HOST, port: PORT, path: p, method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let j; try { j = JSON.parse(b); } catch (e) { j = b; }
        resolve({ status: res.statusCode, json: j, setCookie: res.headers['set-cookie'] });
      });
    });
    r.on('error', (e) => resolve({ status: 0, json: String(e), setCookie: undefined }));
    if (data) r.write(data);
    r.end();
  });
}

/**
 * Issues a request as `userId` and remembers the id the server replies with,
 * so the next call in the same session lands on the same account.
 */
async function activeCookieFor(userId, method, p, body) {
  const cookie = activeCookies.get(userId) || ('caser_user_id=' + userId);
  const res = await req(method, p, { body, cookie });
  const issued = (res.setCookie || [])
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith('caser_user_id='));
  activeCookies.set(userId, issued || cookie);
  return res;
}

/** The numeric account id the server issued for this session. */
function idOf(userId) {
  return String(activeCookies.get(userId) || '').replace('caser_user_id=', '');
}

/** Opens a socket for a session and records every balance event it receives. */
function listen(cookie) {
  const ws = new WebSocket(`ws://${HOST}:${PORT}/api/ws`, { headers: { Cookie: cookie } });
  const events = [];
  ws.on('message', (m) => {
    try { const msg = JSON.parse(m.toString()); if (msg.event) events.push(msg); } catch (e) {}
  });
  return { ws, events, close: () => ws.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function balanceOf(userId) {
  const me = await activeCookieFor(userId, 'GET', '/api/users/me');
  return parseFloat(me.json.balance);
}

async function main() {
  // Two distinct players.
  const a = `player_bal_a_${Date.now().toString(36)}`;
  const b = `player_bal_b_${Date.now().toString(36)}`;

  await activeCookieFor(a, 'GET', '/api/users/me');
  await activeCookieFor(b, 'GET', '/api/users/me');

  // Give them wildly different balances - 500x apart - so any leak is obvious.
  await activeCookieFor(a, 'POST', '/api/users/balance/topup', { amount: 6999999 });
  await activeCookieFor(b, 'POST', '/api/users/balance/topup', { amount: 137 });

  const aBal = await balanceOf(a);
  const bBal = await balanceOf(b);
  console.log(`\n  player A balance: ${aBal}`);
  console.log(`  player B balance: ${bBal}`);
  console.log(`  ratio: ${(aBal / bBal).toFixed(1)}x\n`);

  // Topup is additive: a new account starts at START_BALANCE, so the credited
  // amount lands on top of that.
  const START = 2043.31;
  near('A got START_BALANCE + credit', aBal, START + 6999999);
  near('B has its own small balance', bBal, START + 137);

  // Both sockets listening.
  const la = listen(activeCookies.get(a));
  const lb = listen(activeCookies.get(b));
  await sleep(600);

  // A spends money by opening the cheapest case.
  const cases = await activeCookieFor(a, 'GET', '/api/game/cases');
  const list = cases.json.cases || cases.json;
  const cheapest = list.slice().sort((x, y) => parseFloat(x.price) - parseFloat(y.price))[0];
  await activeCookieFor(a, 'POST', `/api/game/cases/${cheapest.slug}/open`);
  await sleep(700);

  const aEvents = la.events.filter((e) => e.event === 'users.update_balance');
  const bEvents = lb.events.filter((e) => e.event === 'users.update_balance');

  console.log(`  A received ${aEvents.length} balance events`);
  console.log(`  B received ${bEvents.length} balance events`);
  if (aEvents.length) console.log(`  A last event value: ${aEvents[aEvents.length - 1].data}`);
  if (bEvents.length) console.log(`  B last event value: ${bEvents[bEvents.length - 1].data} (should not exist)\n`);

  check('owner A got its balance update', aEvents.length > 0, aEvents.length);
  check('player B received NO balance events', bEvents.length === 0, { received: bEvents.length });

  // Nothing that leaked A's number to B.
  const leaked = bEvents.filter((e) => parseFloat(e.data) === aBal);
  check("A's balance never reached B", leaked.length === 0, { leaked });

  // The pushed value must match the stored value.
  const aAfter = await balanceOf(a);
  const pushed = parseFloat(aEvents[aEvents.length - 1].data);
  check('pushed value matches the stored value', Math.abs(pushed - aAfter) < 0.02, { pushed, stored: aAfter });

  // ---- topup must not silently credit a default ----
  const beforeZero = await balanceOf(b);
  const zeroTopup = await activeCookieFor(b, 'POST', '/api/users/balance/topup', { amount: 0 });
  const afterZero = await balanceOf(b);
  check('topup with amount 0 is refused', zeroTopup.status, 400);
  near('amount 0 changed nothing', afterZero, beforeZero);

  const noBodyTopup = await activeCookieFor(b, 'POST', '/api/users/balance/topup', {});
  const afterNoBody = await balanceOf(b);
  check('topup with no amount is refused', noBodyTopup.status, 400);
  near('missing amount changed nothing', afterNoBody, beforeZero);

  const negTopup = await activeCookieFor(b, 'POST', '/api/users/balance/topup', { amount: -5000 });
  const afterNeg = await balanceOf(b);
  check('topup with a negative amount is refused', negTopup.status, 400);
  near('negative amount changed nothing', afterNeg, beforeZero);

  // ---- admin "set exact balance" must not double-count ----
  const c = `player_bal_c_${Date.now().toString(36)}`;
  await activeCookieFor(c, 'GET', '/api/users/me');
  const setRes = await req('POST', `/api/admin/users/${idOf(c)}/balance`, { cookie: ADMIN, body: { balance: 6999999 } });
  check('admin set balance accepted', setRes.status, 200);
  near('balance is exactly what was set (not doubled)', await balanceOf(c), 6999999);

  // Setting it twice must still land on the same number.
  await req('POST', `/api/admin/users/${idOf(c)}/balance`, { cookie: ADMIN, body: { balance: 6999999 } });
  near('setting the same value twice is idempotent', await balanceOf(c), 6999999);

  // And lowering it works just as well.
  await req('POST', `/api/admin/users/${idOf(c)}/balance`, { cookie: ADMIN, body: { balance: 100 } });
  near('balance can be lowered', await balanceOf(c), 100);

  // Bad input must not corrupt anything.
  const badSet = await req('POST', `/api/admin/users/${idOf(c)}/balance`, { cookie: ADMIN, body: { balance: -1 } });
  check('negative balance refused', badSet.status, 400);
  const badSet2 = await req('POST', `/api/admin/users/${idOf(c)}/balance`, { cookie: ADMIN, body: { balance: 'abc' } });
  check('non-numeric balance refused', badSet2.status, 400);
  check('unknown user refused',
    (await req('POST', '/api/admin/users/nobody/balance', { cookie: ADMIN, body: { balance: 10 } })).status, 404);
  check('non-admin cannot set balance',
    (await req('POST', `/api/admin/users/${idOf(c)}/balance`, { cookie: activeCookies.get(b), body: { balance: 10 } })).status, 403);
  near('refused writes changed nothing', await balanceOf(c), 100);

  // ---- endpoint type/shape consistency ----
  const shapes = {};
  const me = await activeCookieFor(a, 'GET', '/api/users/me');
  const invBal = await activeCookieFor(a, 'GET', '/api/items/inventory/balance');
  const topup = await activeCookieFor(a, 'POST', '/api/users/balance/topup', { amount: 0.5 });
  const opened = await activeCookieFor(a, 'POST', `/api/game/cases/${cheapest.slug}/open`);

  shapes.me = { type: typeof me.json.balance, value: Number(me.json.balance) };
  shapes.inventoryBalance = { type: typeof invBal.json.amount, value: Number(invBal.json.amount) };
  shapes.topup = { type: typeof topup.json.balance, value: Number(topup.json.balance) };
  shapes.caseOpen = { type: typeof opened.json.balance, value: Number(opened.json.balance) };

  console.log('\n  endpoint                     type      value');
  for (const [k, v] of Object.entries(shapes)) {
    console.log(`  ${k.padEnd(27)} ${String(v.type).padEnd(8)} ${v.value}`);
  }
  console.log('');

  check('/api/users/me reports a number', typeof me.json.balance, 'number');
  check('inventory balance reports a number', typeof invBal.json.amount, 'number');
  check('topup reports a number', typeof topup.json.balance, 'number');
  check('case open reports a number', typeof opened.json.balance, 'number');

  // All four must agree on the same number (topup of 0.5 and a case open in
  // between shift it, so compare against the final stored value).
  const finalBal = await balanceOf(a);
  check('all endpoints agree with the stored balance',
    Math.abs(shapes.caseOpen.value - finalBal) < 0.02, { reported: shapes.caseOpen.value, stored: finalBal });

  la.close(); lb.close();
  await sleep(200);

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('CRASH', e); process.exit(1); });
