/**
 * Mystery upgrade economics.
 *
 * Verifies the prize pool is bounded by the stake and that the expected payout
 * lands on the site RTP. The old implementation drew uniformly from the whole
 * catalogue (mean price ~$30,486) which produced a ~30,000% RTP.
 */
const fs = require('fs');
const path = require('path');

const RTP = parseFloat(process.env.RTP) || 0.8;
const MYSTERY_MIN_MULT = 0.15;
const MYSTERY_MAX_MULT = 4;
const MYSTERY_MIN_POOL = 12;
const MYSTERY_FALLBACK_POOL = 60;

// ---- catalogue (same source the server uses) ----
const byName = new Map();
for (const f of fs.readdirSync(path.join(__dirname, 'cases_cache'))) {
  if (!f.endsWith('.json')) continue;
  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases_cache', f), 'utf8')); } catch (e) { continue; }
  for (const it of d.items || []) {
    const mn = it.marketName || it.name;
    const p = parseFloat(it.price);
    if (!mn || !it.image || !Number.isFinite(p)) continue;
    if (!byName.has(mn) || byName.get(mn) < p) byName.set(mn, p);
  }
}
const SHOP = [...byName.entries()].map(([name, price]) => ({ name, price }));

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (!ok && detail !== undefined ? `\n        ${JSON.stringify(detail).slice(0, 300)}` : ''));
}

// ---- mirrors of the server functions ----
function bucket(stake) {
  if (!(stake > 0)) return 0;
  const mag = Math.pow(10, Math.floor(Math.log10(stake)));
  const ratio = stake / mag;
  return (Math.round(ratio * 10) / 10) * mag;
}
function pool(stake) {
  const inBand = SHOP.filter((s) => s.price >= stake * MYSTERY_MIN_MULT && s.price <= stake * MYSTERY_MAX_MULT);
  if (inBand.length >= MYSTERY_MIN_POOL) return inBand;
  return SHOP.slice()
    .sort((a, b) => Math.abs(Math.log(a.price / stake)) - Math.abs(Math.log(b.price / stake)))
    .slice(0, MYSTERY_FALLBACK_POOL);
}
function odds(p, stake) {
  const target = Math.max(0, stake * RTP);
  const prices = p.map((x) => Math.max(x.price, 0.01));
  const ev = (beta) => {
    const w = prices.map((x) => Math.pow(x, -beta));
    const Z = w.reduce((a, b) => a + b, 0) || 1;
    return w.reduce((acc, wi, i) => acc + (wi / Z) * prices[i], 0);
  };
  if (ev(0) <= target) return p.map((_, i) => (i + 1) / p.length);
  let lo = 0, hi = 60;
  for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (ev(m) > target) lo = m; else hi = m; }
  const beta = (lo + hi) / 2;
  const w = prices.map((x) => Math.pow(x, -beta));
  const Z = w.reduce((a, b) => a + b, 0) || 1;
  const cum = []; let acc = 0;
  for (const wi of w) { acc += wi / Z; cum.push(acc); }
  cum[cum.length - 1] = 1;
  return cum;
}
function expectedPayout(p, cum) {
  let prev = 0, ev = 0;
  for (let i = 0; i < p.length; i++) { ev += (cum[i] - prev) * p[i].price; prev = cum[i]; }
  return ev;
}

let seed = 987654321;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
function pick(cum) { const r = rnd(); for (let i = 0; i < cum.length; i++) if (r < cum[i]) return i; return cum.length - 1; }

console.log(`catalogue: ${SHOP.length} items, RTP target ${RTP}\n`);

const stakes = [5, 10, 50, 100, 500, 1000, 5000, 20000, 100000];

console.log('--- analytic ---');
console.log('stake    pool   min prize    max prize     EV        RTP      jackpots');
for (const s of stakes) {
  const p = pool(bucket(s));
  const c = odds(p, bucket(s));
  const ev = expectedPayout(p, c);
  const prices = p.map((x) => x.price);
  const jackpotPct = (c.length ? (c[c.length - 1] - c[c.length - 2]) : 0);
  console.log(
    `$${String(s).padStart(6)} ${String(p.length).padStart(5)}` +
    `  $${Math.min(...prices).toFixed(0).padStart(8)}  $${Math.max(...prices).toFixed(0).padStart(9)}` +
    `  $${ev.toFixed(2).padStart(9)}  ${(ev / s * 100).toFixed(1).padStart(6)}%` +
    `  ${((p.filter((x) => x.price >= s * 2).length / p.length) * 100).toFixed(1)}%`
  );
}

console.log('\n--- checks ---');
// The catalogue's cheapest item is ~$4.36, so a stake below ~$5.45 has no
// prize cheap enough to hit the target, and a stake near the top of the
// catalogue has no expensive-enough pool to bias toward. Both fall back to a
// uniform draw. That is a property of the item list, not a bug: the guarantee
// we can hold everywhere is "never pays out more than it takes".
const CHEAPEST = Math.min(...SHOP.map((x) => x.price));
for (const s of stakes) {
  const b = bucket(s);
  const p = pool(b);
  const c = odds(p, b);
  const ev = expectedPayout(p, c);
  const rtp = ev / s;

  const target = s * RTP;
  // Beta weighting can only ever push the expected payout DOWN, so the target
  // is only reachable when it sits between the cheapest item and the uniform
  // mean of the pool.
  const prices = p.map((x) => Math.max(x.price, 0.01));
  const uniformEv = prices.reduce((a, b) => a + b, 0) / prices.length;
  const reachable = target >= CHEAPEST && target <= uniformEv;

  if (reachable) {
    check(`stake $${s}: RTP on target (${(RTP * 100).toFixed(0)}%)`,
      Math.abs(rtp - RTP) < 0.02, { stake: s, rtp });
  } else {
    // Documented fallback, and the deviation always favours the house.
    check(`stake $${s}: fallback stays under 100% RTP`, rtp <= 1, { stake: s, rtp, cheapest: CHEAPEST });
    const why = target < CHEAPEST
      ? `target $${target.toFixed(2)} is below the cheapest item $${CHEAPEST.toFixed(2)}`
      : `pool's uniform mean $${uniformEv.toFixed(2)} is already below target $${target.toFixed(2)}`;
    console.log(`      (${why}; uniform fallback gives ${(rtp * 100).toFixed(1)}%)`);
  }

  // The pool must never contain something absurd relative to the stake.
  const maxPrice = Math.max(...p.map((x) => x.price));
  const minPrice = Math.min(...p.map((x) => x.price));
  check(`stake $${s}: no prize beyond ${MYSTERY_MAX_MULT}x stake`, maxPrice <= s * MYSTERY_MAX_MULT * 1.0001,
    { maxPrice, ceiling: s * MYSTERY_MAX_MULT });
  check(`stake $${s}: no prize below ${MYSTERY_MIN_MULT}x stake`, minPrice >= s * MYSTERY_MIN_MULT * 0.999,
    { minPrice, floor: s * MYSTERY_MIN_MULT });
}

// The headline bug: a $100 stake must not be able to return $30k on average.
const p100 = pool(100);
const c100 = odds(p100, 100);
const ev100 = expectedPayout(p100, c100);
check('$100 stake no longer pays ~$30,000 on average', ev100 < 200, { expected: ev100 });
check('$100 stake no longer pays over 2x back', ev100 / 100 < 2, { rtp: ev100 / 100 });

// Monte-Carlo: the empirical payout must match the analytic RTP.
console.log('\n--- Monte-Carlo (30 000 spins per stake) ---');
console.log('stake    played        returned        empirical RTP');
for (const s of [10, 100, 1000, 10000]) {
  const b = bucket(s);
  const p = pool(b);
  const c = odds(p, b);
  let returned = 0;
  const N = 30000;
  for (let k = 0; k < N; k++) returned += p[pick(c)].price;
  const r = returned / (N * s);
  console.log(`$${String(s).padStart(6)} ${String(N).padStart(8)}  $${returned.toFixed(0).padStart(12)}  ${(r * 100).toFixed(2).padStart(8)}%`);
  check(`simulated stake $${s}: RTP near ${(RTP * 100).toFixed(0)}%`, Math.abs(r - RTP) < 0.03, { r });
}

// No stake size may ever pay out more than it takes.
console.log('\n--- never pays more than it takes ---');
for (const s of stakes) {
  const b = bucket(s);
  const p = pool(b);
  const rtp = expectedPayout(p, odds(p, b)) / s;
  check(`stake $${s}: RTP <= 100%`, rtp <= 1.0001, { rtp });
}

// Jackpots must still be reachable - otherwise the mode is boring.
console.log('\n--- jackpot reachability ---');
for (const s of [100, 1000]) {
  const b = bucket(s);
  const p = pool(b);
  const c = odds(p, b);
  let jackpots = 0;
  const N = 20000;
  for (let k = 0; k < N; k++) if (p[pick(c)].price >= s * 2) jackpots++;
  const pct = (jackpots / N) * 100;
  console.log(`  stake $${s}: 2x+ prize in ${pct.toFixed(2)}% of spins`);
  check(`stake $${s}: jackpots still reachable (0.05%..20%)`, pct > 0.05 && pct < 20, { pct });
}

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failed ? 1 : 0);