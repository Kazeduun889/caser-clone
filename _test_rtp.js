/**
 * Verifies the house edge actually holds.
 *
 * RTP = 0.80 means: for every $1 wagered, the player gets $0.80 back in
 * winnings, so the house keeps $0.20. This checks both the analytic number and
 * a Monte-Carlo run against the real case catalogue.
 */
const fs = require('fs');
const path = require('path');

const RTP = 0.8;
const CACHE = path.join(__dirname, 'cases_cache');

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : `\n        got      ${JSON.stringify(actual)}\n        expected ${JSON.stringify(expected)}`));
}
function near(label, actual, expected, tol) {
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (${Number(actual).toFixed(4)} vs ${Number(expected).toFixed(4)}, tol ${tol})`);
}

// ---- the same maths the server uses -------------------------------------
function buildDropOdds(items, casePrice, rtp = RTP) {
  const target = Math.max(0, casePrice * rtp);
  const prices = items.map((i) => Math.max(parseFloat(i.price) || 0, 0.01));
  const expected = (beta) => {
    const w = prices.map((p) => Math.pow(p, -beta));
    const Z = w.reduce((a, b) => a + b, 0) || 1;
    return w.reduce((acc, wi, i) => acc + (wi / Z) * prices[i], 0);
  };
  if (target <= 0 || expected(0) <= target) {
    const n = items.length;
    return items.map((_, i) => (i + 1) / n);
  }
  let lo = 0, hi = 60;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (expected(mid) > target) lo = mid; else hi = mid;
  }
  const w = prices.map((p) => Math.pow(p, -(lo + hi) / 2));
  const Z = w.reduce((a, b) => a + b, 0) || 1;
  const cum = [];
  let acc = 0;
  for (const wi of w) { acc += wi / Z; cum.push(acc); }
  cum[cum.length - 1] = 1;
  return cum;
}

function pickByOdds(cum, rnd) {
  const r = rnd();
  for (let i = 0; i < cum.length; i++) if (r < cum[i]) return i;
  return cum.length - 1;
}

// deterministic RNG so a failure is reproducible
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

// ---- load the real catalogue --------------------------------------------
const cases = [];
for (const f of fs.readdirSync(CACHE)) {
  if (!f.endsWith('.json')) continue;
  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8')); } catch (e) { continue; }
  const items = (d.items || []).filter((i) => Number.isFinite(parseFloat(i.price)));
  const price = parseFloat((d.case || {}).price);
  if (items.length && Number.isFinite(price) && price > 0) {
    cases.push({ slug: (d.case || {}).slug || f, price, items });
  }
}

console.log(`loaded ${cases.length} cases\n`);

// ---- 1. analytic RTP per case -------------------------------------------
const analytic = cases.map((c) => {
  const cum = buildDropOdds(c.items, c.price);
  // expected payout = sum over i of P(i) * price(i)
  let prev = 0, ev = 0;
  for (let i = 0; i < cum.length; i++) {
    const p = cum[i] - prev;
    ev += p * Math.max(parseFloat(c.items[i].price) || 0, 0.01);
    prev = cum[i];
  }
  return { slug: c.slug, price: c.price, ev, rtp: ev / c.price };
});

const exactly80 = analytic.filter((a) => Math.abs(a.rtp - RTP) < 0.0005);
console.log(`cases whose analytic RTP is exactly 80%: ${exactly80.length}/${analytic.length}`);

// Cases where even uniform odds pay less than 80% are legitimately *below* -
// the maths cannot invent value. Those are the house's best cases.
const below = analytic.filter((a) => a.rtp < RTP - 0.0005);
const above = analytic.filter((a) => a.rtp > RTP + 0.0005);
check('no case pays out more than 80%', above.length, 0);
console.log(`  below 80% (uniform already too generous): ${below.length}`);

if (below.length) {
  const worst = below.slice().sort((a, b) => a.rtp - b.rtp)[0];
  console.log(`  worst case ${worst.slug}: RTP ${(worst.rtp * 100).toFixed(1)}%`);
}

// Weighted-by-volume view: what the player experiences on average.
const meanRtp = analytic.reduce((a, c) => a + c.rtp, 0) / analytic.length;
near('mean analytic RTP across the catalogue', meanRtp, RTP, 0.02);
console.log(`  (mean across cases: ${(meanRtp * 100).toFixed(1)}%)\n`);

// ---- 2. Monte-Carlo over real opens -------------------------------------
const OPENS_PER_CASE = 4000;
let wagered = 0, returnedValue = 0;

for (const c of cases) {
  const cum = buildDropOdds(c.items, c.price);
  for (let k = 0; k < OPENS_PER_CASE; k++) {
    const idx = pickByOdds(cum, rnd);
    wagered += c.price;
    returnedValue += Math.max(parseFloat(c.items[idx].price) || 0, 0.01);
  }
}

const mcRtp = returnedValue / wagered;
console.log(`simulated ${(cases.length * OPENS_PER_CASE).toLocaleString('ru-RU')} opens`);
console.log(`wagered   $${wagered.toLocaleString('ru-RU', { maximumFractionDigits: 0 })}`);
console.log(`returned  $${returnedValue.toLocaleString('ru-RU', { maximumFractionDigits: 0 })}`);
console.log(`house profit $${(wagered - returnedValue).toLocaleString('ru-RU', { maximumFractionDigits: 0 })}\n`);
near('simulated RTP', mcRtp, RTP, 0.01);

// ---- 3. the player ends up in the red -----------------------------------
check('the house is profitable', wagered > returnedValue, true);
const edge = 1 - mcRtp;
console.log(`\nhouse edge: ${(edge * 100).toFixed(1)}% of every dollar wagered`);

// ---- 4. upgrade bets are also edge-positive -------------------------------
// winChance = (stake / targetValue) * RTP, payout = targetValue on a win.
console.log('');
for (const [stakeRatio, label] of [[0.2, 'stake = 20% of target'], [0.5, 'stake = 50% of target'], [1, 'stake = 100% of target']]) {
  const targetValue = 1000;
  const stake = targetValue * stakeRatio;
  const winChance = Math.min(0.8, Math.max(0.01, (stake / targetValue) * RTP));
  const ev = winChance * targetValue - stake; // net cash effect
  const rtp = (winChance * targetValue) / stake;
  check(`upgrade ${label} returns less than the stake`, ev < 0, true);
  console.log(`  ${label}: win chance ${(winChance * 100).toFixed(1)}%, payout RTP ${(rtp * 100).toFixed(1)}%, net ${ev.toFixed(2)}`);
}

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);