/**
 * "Will I ever drop a rare one?"
 *
 * Groups every drop by how many times the case price it is worth, which is
 * what actually decides whether a skin looks rare on screen. Answers the
 * complaint that nobody has seen a gold-tier drop.
 */
const fs = require('fs');
const path = require('path');

const RTP = parseFloat(process.env.RTP) || 0.8;

const cases = [];
for (const f of fs.readdirSync(path.join(__dirname, 'cases_cache'))) {
  if (!f.endsWith('.json')) continue;
  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases_cache', f), 'utf8')); } catch (e) { continue; }
  const items = (d.items || []).filter((i) => Number.isFinite(parseFloat(i.price)) && i.image);
  const price = parseFloat((d.case || {}).price);
  if (items.length && price > 0) cases.push({ slug: (d.case || {}).slug || f, price, items });
}

function buildDropOdds(items, casePrice, rtp = RTP) {
  const target = Math.max(0, casePrice * rtp);
  const prices = items.map((i) => Math.max(parseFloat(i.price) || 0, 0.01));
  const expected = (beta) => {
    const w = prices.map((p) => Math.pow(p, -beta));
    const Z = w.reduce((a, b) => a + b, 0) || 1;
    return w.reduce((acc, wi, i) => acc + (wi / Z) * prices[i], 0);
  };
  if (target <= 0 || expected(0) <= target) return items.map((_, i) => (i + 1) / items.length);
  let lo = 0, hi = 60;
  for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (expected(mid) > target) lo = mid; else hi = mid; }
  const w = prices.map((p) => Math.pow(p, -(lo + hi) / 2));
  const Z = w.reduce((a, b) => a + b, 0) || 1;
  const cum = []; let acc = 0;
  for (const wi of w) { acc += wi / Z; cum.push(acc); }
  cum[cum.length - 1] = 1;
  return cum;
}

function probs(cum) {
  const out = []; let prev = 0;
  for (let i = 0; i < cum.length; i++) { out.push(cum[i] - prev); prev = cum[i]; }
  return out;
}

const BANDS = [
  { label: '>= 20x case price', min: 20 },
  { label: '>= 10x', min: 10 },
  { label: '>= 5x', min: 5 },
  { label: '>= 2x', min: 2 },
  { label: '>= 1x (a profit)', min: 1 },
  { label: '>= 0.5x', min: 0.5 }
];

console.log(`RTP target ${(RTP * 100).toFixed(0)}%  |  ${cases.length} cases\n`);
console.log('band                 cases with it   avg P(drop)   1 in N opens   opens for 50%');
console.log('-------------------- --------------- ------------- ------------- ---------------');

for (const band of BANDS) {
  let sumP = 0, withIt = 0;
  const perCase = [];
  for (const c of cases) {
    const pr = probs(buildDropOdds(c.items, c.price));
    const p = c.items.reduce((a, it, i) => a + (parseFloat(it.price) >= c.price * band.min ? pr[i] : 0), 0);
    if (p > 0) { sumP += p; withIt++; perCase.push(p); }
  }
  const avg = withIt ? sumP / withIt : 0;
  const avgAll = sumP / cases.length;
  const inv = avgAll > 0 ? 1 / avgAll : Infinity;
  const to50 = avgAll > 0 ? Math.log(0.5) / Math.log(1 - avgAll) : Infinity;
  const fmt = (n) => !isFinite(n) ? 'n/a' : n > 100000 ? '>100k' : Math.round(n).toLocaleString('ru-RU');
  console.log(
    band.label.padEnd(20) +
    String(withIt).padStart(9) + '   ' +
    (avgAll * 100).toFixed(3).padStart(9) + '%  ' +
    fmt(inv).padStart(11) + '   ' +
    fmt(to50).padStart(13)
  );
}

// What a player actually sees over a realistic session.
console.log('\n--- realistic session: 50 opens ---');
for (const band of BANDS.slice(0, 4)) {
  let sumP = 0;
  for (const c of cases) {
    const pr = probs(buildDropOdds(c.items, c.price));
    sumP += c.items.reduce((a, it, i) => a + (parseFloat(it.price) >= c.price * band.min ? pr[i] : 0), 0);
  }
  const p = sumP / cases.length;
  const chance = 1 - Math.pow(1 - p, 50);
  console.log(`  at least one ${band.label.padEnd(20)}: ${(chance * 100).toFixed(1)}%`);
}

// The headline: how rare is the top of each case.
console.log('\n--- per case: rarest item ---');
const rows = cases.map((c) => {
  const pr = probs(buildDropOdds(c.items, c.price));
  const maxPrice = Math.max(...c.items.map((i) => parseFloat(i.price)));
  const p = c.items.reduce((a, it, i) => a + (parseFloat(it.price) === maxPrice ? pr[i] : 0), 0);
  return { slug: c.slug, casePrice: c.price, top: maxPrice, mult: maxPrice / c.price, p };
}).sort((a, b) => a.p - b.p);

console.log('case                      price   best item      x case   P(drop best)   1 in N');
for (const r of rows.slice(0, 8)) {
  const inv = r.p > 0 ? Math.round(1 / r.p) : Infinity;
  console.log(
    r.slug.padEnd(26) +
    ('$' + Math.round(r.casePrice)).padStart(7) +
    ('$' + Math.round(r.top)).padStart(13) +
    (r.mult.toFixed(1) + 'x').padStart(9) +
    ((r.p * 100).toFixed(4) + '%').padStart(14) +
    (isFinite(inv) ? inv.toLocaleString('ru-RU') : 'n/a').padStart(10)
  );
}
const best = rows[0];
console.log(`\nrarest single item in the whole site: ${best.slug}, ` +
  `1 in ${isFinite(1 / best.p) ? Math.round(1 / best.p).toLocaleString('ru-RU') : 'n/a'} opens`);
const medianRow = rows[Math.floor(rows.length / 2)];
console.log(`median case's best item: 1 in ${Math.round(1 / medianRow.p).toLocaleString('ru-RU')} opens`);