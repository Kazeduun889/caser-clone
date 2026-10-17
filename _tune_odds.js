/**
 * Compares the current power-law odds against a log-normal-on-ratio shape.
 *
 * Power law over price forces enormous weight onto the cheapest item when a
 * case has a wide price spread, so the typical win is a tiny fraction of the
 * case price and almost every open feels like a full loss. Both families below
 * are pinned to the same RTP; what differs is where the median lands and how
 * often the price is beaten.
 */
const fs = require('fs');
const path = require('path');

const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8')).data.cases;
const cacheDir = path.join(__dirname, 'cases_cache');

const cases = [];
for (const c of catalog) {
  const f = path.join(cacheDir, (c.slug || '') + '.json');
  if (!fs.existsSync(f)) continue;
  let d;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
  const items = Array.isArray(d.items) ? d.items : [];
  if (items.length < 2) continue;
  const price = parseFloat((d.case && d.case.price) || c.price) || 0;
  if (!price) continue;
  cases.push({
    name: c.name || c.title || c.slug,
    price,
    ratios: items.map((i) => Math.max(parseFloat(i.price) || 0, 0.01) / price)
  });
}
console.log('cases:', cases.length);

const RTP = 0.8;
const minR = (r) => r.reduce((a, b) => Math.min(a, b), Infinity);
const maxR = (r) => r.reduce((a, b) => Math.max(a, b), 0);
const feasible = cases.filter((c) => minR(c.ratios) < RTP && maxR(c.ratios) > RTP);
console.log('cases where', RTP, 'is reachable:', feasible.length);

const unreachable = cases.filter((c) => minR(c.ratios) >= RTP);
console.log("cases whose CHEAPEST item is already >= " + RTP + "x the price:", unreachable.length);
unreachable.slice(0, 12).forEach((c) => {
  console.log('   ' + c.name.slice(0, 24).padEnd(26)
    + 'price ' + c.price.toFixed(0).padStart(8)
    + '  cheapest ' + (minR(c.ratios) * 100).toFixed(0) + '%'
    + '  dearest ' + maxR(c.ratios).toFixed(1) + 'x');
});

/** Current production model: w = price^-beta, beta bisected to hit the RTP. */
function powerLaw(ratios) {
  const expect = (b) => {
    const w = ratios.map((r) => Math.pow(r, -b));
    const Z = w.reduce((a, x) => a + x, 0) || 1;
    return w.reduce((acc, wi, i) => acc + (wi / Z) * ratios[i], 0);
  };
  if (expect(0) <= RTP) return ratios.map(() => 1 / ratios.length);
  let lo = 0, hi = 80;
  for (let k = 0; k < 80; k++) {
    const mid = (lo + hi) / 2;
    if (expect(mid) > RTP) lo = mid; else hi = mid;
  }
  const b = (lo + hi) / 2;
  const w = ratios.map((r) => Math.pow(r, -b));
  const Z = w.reduce((a, x) => a + x, 0);
  return w.map((x) => x / Z);
}

/**
 * Proposed: normal density on log(ratio), mu bisected; sigma sets the spread.
 *
 * Weights are exponentiated after subtracting the smallest squared distance,
 * otherwise a large sigma drives every raw weight to zero, the normaliser
 * collapses to 0 and the mixture silently degenerates into a flat one.
 */
function logNormal(ratios, sigma, blend) {
  const dist = (mu) => {
    const d2 = ratios.map((r) => (Math.log(r) - mu) * (Math.log(r) - mu));
    const m = Math.min.apply(null, d2);
    const w = d2.map((d) => Math.exp(-(d - m) / (2 * sigma * sigma)));
    const W = w.reduce((a, x) => a + x, 0);
    const unif = 1 / ratios.length;
    return w.map((x) => ((1 - blend) * (x / W) + blend * unif));
  };
  const expect = (mu) => dist(mu).reduce((acc, pi, i) => acc + pi * ratios[i], 0);

  let lo = -12, hi = 12;
  if (expect(lo) >= RTP) return powerLaw(ratios);
  if (expect(hi) <= RTP) return powerLaw(ratios);
  for (let k = 0; k < 80; k++) {
    const mid = (lo + hi) / 2;
    if (expect(mid) < RTP) lo = mid; else hi = mid;
  }
  return dist((lo + hi) / 2);
}

function stats(p, ratios) {
  const ev = p.reduce((a, pi, i) => a + pi * ratios[i], 0);
  const atLeast = (m) => p.reduce((a, pi, i) => a + (ratios[i] >= m ? pi : 0), 0);
  // median of the outcome distribution
  const pairs = ratios.map((r, i) => [r, p[i]]).sort((a, b) => a[0] - b[0]);
  let acc = 0, med = 0;
  for (const [r, pi] of pairs) { acc += pi; if (acc >= 0.5) { med = r; break; } }
  return { ev, med, p1: atLeast(1), p2: atLeast(2), p5: atLeast(5), p10: atLeast(10) };
}

function report(label, build) {
  let ev = 0, med = 0, p1 = 0, p2 = 0, p5 = 0, p10 = 0;
  const n = feasible.length;
  for (const c of feasible) {
    const s = stats(build(c.ratios), c.ratios);
    ev += s.ev; med += s.med; p1 += s.p1; p2 += s.p2; p5 += s.p5; p10 += s.p10;
  }
  const pc = (x) => (x / n * 100).toFixed(2) + '%';
  console.log(
    label.padEnd(26),
    'RTP ' + (ev / n * 100).toFixed(2).padStart(6) + '%',
    ' медиана ' + (med / n).toFixed(2).padStart(5) + 'x',
    ' >=1x ' + pc(p1).padStart(7),
    ' >=2x ' + pc(p2).padStart(7),
    ' >=5x ' + pc(p5).padStart(7),
    ' >=10x ' + pc(p10).padStart(7)
  );
}

console.log('\n--- current: power law on price ---');
report('power law (current)', (r) => powerLaw(r));

console.log('\n--- candidate: log-normal on ratio ---');
for (const sigma of [0.5, 0.7, 0.9, 1.1, 1.4, 1.8]) {
  for (const blend of [0.02, 0.06]) {
    report(`sigma=${sigma} blend=${blend}`, (r) => logNormal(r, sigma, blend));
  }
}

console.log('\n--- per-case health for the leading candidates ---');
console.log('(averages can hide a subset of cases where every drop is a total loss)\n');
console.log('model'.padEnd(24), 'median<0.4x', ' p(>=1x)<10%', ' p(>=2x)=0', ' worst median');
for (const [label, build] of [
  ['power law (current)', (r) => powerLaw(r)],
  ['logN 0.7/0.02', (r) => logNormal(r, 0.7, 0.02)],
  ['logN 0.9/0.02', (r) => logNormal(r, 0.9, 0.02)],
  ['logN 0.9/0.03', (r) => logNormal(r, 0.9, 0.03)],
  ['logN 1.0/0.03', (r) => logNormal(r, 1.0, 0.03)]
]) {
  let badMed = 0, badP1 = 0, deadTail = 0, worst = Infinity, worstName = '';
  for (const c of feasible) {
    const s = stats(build(c.ratios), c.ratios);
    if (s.med < 0.4) badMed++;
    if (s.p1 < 0.10) badP1++;
    if (s.p2 === 0) deadTail++;
    if (s.med < worst) { worst = s.med; worstName = c.name; }
  }
  const pc = (x) => (x / feasible.length * 100).toFixed(0) + '%';
  console.log(
    label.padEnd(24),
    pc(badMed).padStart(9),
    pc(badP1).padStart(10),
    String(deadTail).padStart(10),
    ('  ' + worst.toFixed(2) + 'x ' + worstName).padEnd(28)
  );
}