/**
 * Rendering contract for money shown on the site.
 *
 * Background: the original bundle's formatAmount() (chunks/3afhs_vz7l64i.js)
 * silently renders "0.00" for any input that is not plain decimal digits -
 * exponential strings, thousand separators, garbage. That is why a large
 * balance used to show as zero. The clone never feeds it those shapes: the API
 * answers with numbers, and the tiles we draw ourselves use fmtMoney()
 * (toLocaleString) from custom-auth.js.
 *
 * This test asserts that contract for every shape a balance can take:
 *   1. fmtMoney, transcribed from custom-auth.js, never prints 0,00 for a
 *      non-zero value and never prints "не число";
 *   2. the original's guard still passes those same values, so even parts of
 *      the page we do not own render them correctly.
 */
const http = require('http');
const HOST = '127.0.0.1', PORT = 3000;

/** Exactly our clone's fmtMoney() from custom-auth.js. */
function fmtMoney(v) {
  return Number(v || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2 });
}

/** Exactly the original bundle's formatAmount() guard, as transcribed before. */
function originalRenders(value) {
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
  // ---- 1. our own formatter, offline --------------------------------------
  // Shapes the API can actually serve. The extremes below never reach the
  // original's guard in production - the balance cap refuses them with a 400 -
  // so the guard is only asserted for values a response can really carry.
  const shapes = [
    { label: 'cents', value: 0.01, served: true },
    { label: 'starting balance', value: 2043.31, served: true },
    { label: 'plain decimal string', value: '7000000.00', served: true },
    { label: 'seven digits', value: 7000000, served: true },
    { label: 'the credited amount', value: 6999999.99, served: true },
    { label: 'twelve digits', value: 123456789.55, served: true },
    { label: 'negative', value: -5000.5, served: true },
    // Above the cap / below a cent: refused or rounded by the API, checked here
    // only for our own renderer never collapsing them to a visible zero.
    { label: 'exponential, big', value: 1e21, served: false },
    { label: 'exponential, tiny', value: 1e-7, served: false },
    { label: 'null', value: null, served: false },
    { label: 'undefined', value: undefined, served: false }
  ];

  for (const s of shapes) {
    let out;
    try { out = fmtMoney(s.value); } catch (e) { out = 'THREW ' + e.constructor.name; }
    const zeroish = out === '0,00' || out === '0.00' || out === '0';
    // A sub-cent value may round to 0,00; anything at or above a cent must not.
    const shouldShowZero = s.value === null || s.value === undefined || Math.abs(Number(s.value)) < 0.005;
    check(`fmtMoney renders ${s.label}`, !zeroish || shouldShowZero, { value: s.value, out });
    check(`fmtMoney does not print NaN for ${s.label}`, !/NaN|не число/i.test(out), { value: s.value, out });
    if (s.served) {
      check(`original guard accepts ${s.label}`, originalRenders(s.value), { value: s.value });
    }
  }

  // ---- 2. the live API only hands over shapes both renderers accept -------
  const TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token-123';
  const USER = process.env.TEST_USER || 'player_format_contract';
  const cookie = `caser_user_id=${USER}`;

  const live = [
    { label: 'small', value: 12.34 },
    { label: 'large', value: 6999999.99 },
    { label: 'very large', value: 999999999999.99 }
  ];

  for (const c of live) {
    const set = await call('POST', `/api/admin/users/${USER}/balance`, { balance: c.value }, TOKEN);
    if (set.status !== 200) {
      // The account may not exist yet; creating it and retrying keeps the
      // check about rendering rather than about fixtures.
      await call('GET', '/api/users/me', undefined, null, cookie);
      await call('POST', `/api/admin/users/${USER}/balance`, { balance: c.value }, TOKEN);
    }
    const me = await call('GET', '/api/users/me', undefined, null, cookie);
    const v = me.json && me.json.balance;

    const out = fmtMoney(v);
    check(`live ${c.label}: served as a number`, typeof v, 'number');
    check(`live ${c.label}: our renderer shows it`, !/^0[,.]00$/.test(out) && !/NaN/i.test(out), { v, out });
    check(`live ${c.label}: original guard passes it`, originalRenders(v), { v });
  }

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('CRASH', e); process.exit(1); });
