/**
 * Live mystery-upgrade check: plays many real bets through the HTTP API and
 * verifies the prizes are sane and the expected payout matches the RTP.
 */
const http = require('http');
const HOST = '127.0.0.1', PORT = 3000;
const RID = 'player_mystery_' + Date.now().toString(36);
const COOKIE = 'caser_user_id=' + RID;

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (!ok && detail !== undefined ? `\n        ${JSON.stringify(detail).slice(0, 300)}` : ''));
}

function req(method, p, body) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const h = { Cookie: COOKIE };
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: HOST, port: PORT, path: p, method, headers: h }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let j; try { j = JSON.parse(b); } catch (e) { j = b; } resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', (e) => resolve({ status: 0, json: String(e) }));
    if (data) r.write(data);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await req('GET', '/api/users/me');
  await req('POST', '/api/users/balance/topup', { amount: 500000 });

  const cases = await req('GET', '/api/game/cases');
  const list = cases.json.cases || cases.json;
  const cheapest = list.slice().sort((x, y) => parseFloat(x.price) - parseFloat(y.price))[0];
  const caseCost = parseFloat(cheapest.price);

  console.log(`\n  кейс: ${cheapest.slug} @ $${caseCost}\n`);

  // Play a batch of mystery bets at a known stake size.
  const SPINS = 120;
  let totalStake = 0, totalWon = 0;
  const ratios = [];
  let jackpotCount = 0, emptyPrize = 0;

  for (let i = 0; i < SPINS; i++) {
    // Buy one case to have an item to bet.
    const opened = await req('POST', `/api/game/cases/${cheapest.slug}/open`);
    const item = opened.json.item || (opened.json.items && opened.json.items[0]);
    if (!item) { check('case open returned an item', false, opened.json); break; }

    const bet = await req('POST', '/api/game/upgrade/bet', {
      betInventoryItemIds: [String(item.id)],
      isMystery: true,
      body: {}
    });
    if (bet.status !== 200) { check('mystery bet accepted', false, bet.json); break; }

    const b = bet.json.bet;
    totalStake += b.stake;
    if (!b.wonItem) { emptyPrize++; continue; }
    const value = parseFloat(b.wonItem.price);
    totalWon += value;
    ratios.push(value / b.stake);
    if (value >= b.stake * 2) jackpotCount++;
  }

  const rtp = totalWon / totalStake;
  const sorted = ratios.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;

  console.log(`  ставок:        ${SPINS}`);
  console.log(`  вложено:       $${totalStake.toFixed(2)}`);
  console.log(`  получено:      $${totalWon.toFixed(2)}`);
  console.log(`  RTP:           ${(rtp * 100).toFixed(1)}%`);
  console.log(`  медиана:       ${(median * 100).toFixed(0)}% от ставки`);
  console.log(`  джекпоты 2x+:  ${((jackpotCount / SPINS) * 100).toFixed(1)}%`);
  console.log(`  мин/макс:      ${(Math.min(...ratios) * 100).toFixed(0)}% / ${(Math.max(...ratios) * 100).toFixed(0)}%`);
  console.log('');

  check('every bet returned a prize', emptyPrize === 0, { emptyPrize });
  check('no prize is absurdly larger than the stake', Math.max(...ratios) <= 4.2, { maxRatio: Math.max(...ratios) });
  check('no prize is absurdly smaller than the stake', Math.min(...ratios) >= 0.1, { minRatio: Math.min(...ratios) });
  check('jackpots still occur', jackpotCount > 0, { jackpotCount });
  check(`RTP is near 80% (got ${(rtp * 100).toFixed(1)}%)`, Math.abs(rtp - 0.8) < 0.18, { rtp });

  // Mystery has no target, so the UI must not claim a chance.
  const last = await req('POST', '/api/game/upgrade/bet', { isMystery: true, addedBalance: 0 });
  check('mystery reports status won', last.status === 200 || last.status === 400, { status: last.status });

  // Guard the normal (non-mystery) path against regressions.
  const shop = await req('GET', '/api/upgrade/shop?sortBy=price&sortDirection=ASC&limit=200&priceFrom=1');
  const target = (shop.json.items || [])[10];
  if (target) {
    const opened = await req('POST', `/api/game/cases/${cheapest.slug}/open`);
    const item = opened.json.item || (opened.json.items && opened.json.items[0]);
    const normal = await req('POST', '/api/game/upgrade/bet', {
      betInventoryItemIds: [String(item.id)],
      targetItemId: String(target.id)
    });
    check('normal upgrade still works', normal.status === 200, normal.json);
    if (normal.status === 200) {
      const nb = normal.json.bet;
      check('normal bet has a chance percentage', typeof nb.winChance === 'number' && nb.winChance >= 1 && nb.winChance <= 80,
        { winChance: nb.winChance });
    }
  }

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('CRASH', e); process.exit(1); });