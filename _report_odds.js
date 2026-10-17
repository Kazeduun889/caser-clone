/**
 * Reports the clone's real drop distribution from the live case cache, so the
 * odds can be judged as numbers rather than asserted to match the original.
 */
const fs = require('fs');
const path = require('path');

const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8')).data.cases;
const cacheDir = path.join(__dirname, 'cases_cache');

const loaded = [];
for (const c of catalog) {
  const f = path.join(cacheDir, (c.slug || '') + '.json');
  if (!fs.existsSync(f)) continue;
  let d;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
  const items = Array.isArray(d.items) ? d.items : [];
  if (!items.length) continue;
  loaded.push({
    name: c.name || c.title || c.slug,
    slug: c.slug,
    price: parseFloat((d.case && d.case.price) || c.price) || 0,
    items
  });
}

console.log('cases in catalog :', catalog.length);
console.log('cases with items :', loaded.length);
console.log('item fields      :', Object.keys(loaded[0].items[0]).join(', '), '\n');

const RTP = 0.8;

function weightsFor(items, casePrice, rtp = RTP) {
  const prices = items.map((i) => Math.max(parseFloat(i.price) || 0, 0.01));
  const target = casePrice * rtp;
  const expected = (b) => {
    const w = prices.map((p) => Math.pow(p, -b));
    const Z = w.reduce((a, x) => a + x, 0) || 1;
    return w.reduce((acc, wi, i) => acc + (wi / Z) * prices[i], 0);
  };
  let b = 0;
  if (expected(0) > target) {
    let lo = 0, hi = 60;
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2;
      if (expected(mid) > target) lo = mid; else hi = mid;
    }
    b = (lo + hi) / 2;
  }
  const w = prices.map((p) => Math.pow(p, -b));
  const Z = w.reduce((a, x) => a + x, 0);
  return { prices, p: w.map((x) => x / Z), beta: b };
}

console.log('case'.padEnd(26), 'price'.padStart(9), 'n'.padStart(4), 'beta'.padStart(7),
  'RTP'.padStart(7), 'p(>=2x)'.padStart(10), 'p(>=5x)'.padStart(10), 'top%');
for (const c of loaded.slice(0, 8)) {
  const { prices, p, beta } = weightsFor(c.items, c.price);
  const ev = p.reduce((a, pi, i) => a + pi * prices[i], 0) / c.price;
  const atLeast = (m) => p.reduce((a, pi, i) => a + (prices[i] >= m * c.price ? pi : 0), 0);
  const top = p.reduce((m, pi, i) => (pi > p[m] ? i : m), 0);
  console.log(
    c.name.slice(0, 25).padEnd(26),
    c.price.toFixed(2).padStart(9),
    String(c.items.length).padStart(4),
    beta.toFixed(3).padStart(7),
    (ev * 100).toFixed(1) + '%',
    (atLeast(2) * 100).toFixed(2) + '%',
    (atLeast(5) * 100).toFixed(3) + '%',
    (p[top] * 100).toFixed(2) + '%'
  );
}

console.log('\n=== Monte-Carlo, 300k opens across all cases ===');
let staked = 0, won = 0;
const j = { x2: 0, x5: 0, x10: 0, x20: 0 };
const N = 300000;
for (let n = 0; n < N; n++) {
  const c = loaded[Math.floor(Math.random() * loaded.length)];
  const { prices, p } = weightsFor(c.items, c.price);
  const cum = [];
  let acc = 0;
  for (const x of p) { acc += x; cum.push(acc); }
  const r = Math.random();
  let pick = prices.length - 1;
  for (let i = 0; i < cum.length; i++) if (r < cum[i]) { pick = i; break; }
  staked += c.price;
  won += prices[pick];
  const ratio = prices[pick] / c.price;
  if (ratio >= 2) j.x2++;
  if (ratio >= 5) j.x5++;
  if (ratio >= 10) j.x10++;
  if (ratio >= 20) j.x20++;
}
console.log('staked  :', staked.toFixed(2));
console.log('won     :', won.toFixed(2));
console.log('RTP     :', (won / staked * 100).toFixed(2) + '%');
console.log('1x odds :', '1 in ' + (N / j.x2).toFixed(0));
console.log('5x odds :', '1 in ' + (N / j.x5).toFixed(0));
console.log('10x odds:', '1 in ' + (N / j.x10).toFixed(0));
console.log('20x odds:', '1 in ' + (N / j.x20).toFixed(0));