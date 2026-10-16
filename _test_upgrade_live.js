/**
 * Live check that /api/game/upgrade/bet reports the same chance it rolled,
 * using the formula extracted from the real caser.one.
 */
const http = require('http');
const HOST = '127.0.0.1', PORT = 3000;

function call(method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ host: HOST, port: PORT, path: p, method, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => { let j; try { j = JSON.parse(raw); } catch (e) { j = raw; } resolve({ status: res.statusCode, json: j, headers: res.headers }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : `\n        got      ${JSON.stringify(actual)}\n        expected ${JSON.stringify(expected)}`));
}
const truthy = (l, c, d) => check(l, !!c, true) || (!c && d ? console.log('        ', JSON.stringify(d).slice(0, 300)) : 0);

async function main() {
  const me = await call('GET', '/api/users/me');
  const cookie = ((me.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ') || '').match(/caser_user_id=[^;]+/)?.[0];
  if (!cookie) throw new Error('no session');

  // Earn an item by opening the cheapest case.
  const cases = await call('GET', '/api/game/cases', { cookie });
  const list = Array.isArray(cases.json) ? cases.json : (cases.json.cases || cases.json.items || []);
  const cheapest = list.slice().sort((a, b) => parseFloat(a.price) - parseFloat(b.price))[0];
  const opened = await call('POST', `/api/game/cases/${cheapest.slug}/open`, { cookie });
  // The open response carries either a single `item` or an `items` array.
  const won = opened.json.item || (opened.json.items && opened.json.items[0]) || null;
  truthy('won an item to bet', !!won, opened.json);
  if (!won) throw new Error('no item');

  // Target worth more than the stake, so a chance is displayed.
  // Ask for a bigger page and filter server-side by price, so we get a target
// that is meaningfully worth more than the stake.
  const stakeValue = parseFloat(won.price) || 0;
  const minTarget = stakeValue * 3;
  const shop = await call('GET', `/api/upgrade/shop?priceFrom=${minTarget}&sortBy=price&sortDirection=ASC&limit=200`, { cookie });
  const shopItems = Array.isArray(shop.json) ? shop.json : (shop.json.items || []);
  const target = shopItems
    .map((s) => ({ ...s, priceNum: parseFloat(s.price) || 0 }))
    .filter((s) => s.priceNum > stakeValue * 3)
    .sort((a, b) => a.priceNum - b.priceNum)[0];
  truthy('found an upgrade target', !!target, { shopCount: shopItems.length, stakeValue });
  if (!target) throw new Error('no target');

  const bet = await call('POST', '/api/game/upgrade/bet', {
    cookie,
    body: { betInventoryItemIds: [String(won.id)], targetItemId: String(target.id), addedBalance: 0 }
  });
  check('bet accepted', bet.status, 200);
  const b = bet.json.bet;
  truthy('bet has a status', !!b, bet.json);
  if (!b) throw new Error('no bet payload');

  console.log(`\n  stake            ${b.stake}`);
  console.log(`  target price     ${parseFloat(target.price)}`);
  console.log(`  stake/target     ${(b.stake / parseFloat(target.price) * 100).toFixed(2)}%`);
  console.log(`  reported chance  ${b.winChance}%`);
  console.log(`  roll             ${b.roll}`);
  console.log(`  result           ${b.status}\n`);

  // The reported chance must equal stake/target * multiplier, and must be the
  // real probability of winning.
  const raw = (b.stake / parseFloat(target.price)) * (await multiplier());
  check('chance matches the real formula', Math.abs(b.winChance - Math.min(80, Math.max(1, raw))) < 0.001, true);
  check('chance is inside 1..80', b.winChance >= 1 && b.winChance <= 80, true);
  check('winChancePercent mirrors winChance', b.winChancePercent, b.winChance);
  check('superDrop is a boolean', typeof b.superDrop, 'boolean');

  // The roll must agree with the outcome at the reported probability.
  const p = b.winChance / 100;
  if (b.status === 'won') check('a win rolled below the chance', b.roll / 100 < p, true);
  else check('a loss rolled at or above the chance', b.roll / 100 >= p, true);

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
}

async function multiplier() {
  // Read the effective multiplier from the stats endpoint when available.
  try {
    const s = await call('GET', '/api/admin/stats', { cookie: 'caser_user_id=player_10001' });
    return s.json?.data?.upgradeMultiplier ?? 80;
  } catch (e) { return 80; }
}

main().catch((e) => { console.error('\nCRASH:', e.message, '\n', e.stack); process.exit(1); });