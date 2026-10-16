/**
 * What the drop odds actually mean for each rarity.
 *
 * The complaint was that no yellow (Covert) skin ever dropped. This computes
 * the real probability per rarity from the shipped catalogue and the odds the
 * server builds.
 */
const fs = require('fs');
const path = require('path');

const RTP = parseFloat(process.env.RTP) || 0.8;

// CS2 wear tiers as used by the site payload
const RARITY = {
  1: 'Consumer (white)',
  2: 'Industrial (blue)',
  3: 'Mil-Spec (purple)',
  4: 'Restricted (pink)',
  5: 'Classified (red)',
  6: 'Covert (gold/yellow)',
  7: 'Contrast',
  8: 'Extraordinary',
  9: 'Gloves',
  10: 'Extraordinary (Meow)',
  11: 'Contraband',
  12: 'Contraband',
  13: 'Contraband',
  14: 'Souvenir'
};

// ---- load ----
const byName = new Map();
for (const f of fs.readdirSync(path.join(__dirname, 'cases_cache'))) {
  if (!f.endsWith('.json')) continue;
  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases_cache', f), 'utf8')); } catch (e) { continue; }
  for (const it of d.items || []) {
    const mn = it.marketName || it.name;
    const p = parseFloat(it.price);
    if (!mn || !it.image || !Number.isFinite(p)) continue;
    const prev = byName.get(mn);
    if (!prev || prev.price < p) byName.set(mn, { name: mn, price: p, rarity: it.rarity });
  }
}

const cases = [];
for (const f of fs.readdirSync(path.join(__dirname, 'cases_cache'))) {
  if (!f.endsWith('.json')) continue;
  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases_cache', f), 'utf8')); } catch (e) { continue; }
  const items = (d.items || []).filter((i) => Number.isFinite(parseFloat(i.price)) && i.image);
  const price = parseFloat((d.case || {}).price);
  if (items.length && price > 0) cases.push({ slug: (d.case || {}).slug || f, price, items });
}

// ---- the server's odds maths ----
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

function probsFrom(cum) {
  const out = [];
  let prev = 0;
  for (let i = 0; i < cum.length; i++) { out.push(cum[i] - prev); prev = cum[i]; }
  return out;
}

// ---- 1. what rarities even exist in the data ----
console.log('=== rarities present in the catalogue ===');
const rarityCounts = new Map();
for (const it of byName.values()) {
  const r = String(it.rarity);
  rarityCounts.set(r, (rarityCounts.get(r) || 0) + 1);
}
[...rarityCounts.entries()].sort((a, b) => b[1] - a[1]).forEach(([r, n]) => {
  const prices = [...byName.values()].filter((x) => String(x.rarity) === r).map((x) => x.price);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  console.log(`  rarity ${String(r).padStart(3)}  ${String(RARITY[r] || 'unknown').padEnd(26)} ${String(n).padStart(5)} items, avg $${Math.round(avg)}`);
});

// ---- 2. per-case probability of the best rarity ----
console.log('\n=== how often a gold/Covert (rarity 6) drops, per case ===');
console.log('case                      price    gold items   P(gold)     1 in N opens');
const perCase = [];
for (const c of cases) {
  const cum = buildDropOdds(c.items, c.price);
  const probs = probsFrom(cum);
  const goldIdx = c.items.map((it, i) => [it, i]).filter(([it]) => String(it.rarity) === '6');
  const pGold = goldIdx.reduce((a, [, i]) => a + probs[i], 0);
  if (goldIdx.length) {
    perCase.push({ slug: c.slug, price: c.price, n: goldIdx.length, p: pGold });
  }
}
perCase.sort((a, b) => a.p - b.p);
for (const r of perCase.slice(0, 12)) {
  console.log(`${r.slug.padEnd(26)} $${String(Math.round(r.price)).padStart(7)} ${String(r.n).padStart(8)}   ${(r.p * 100).toFixed(4)}%    ${(1 / r.p).toFixed(0)}`);
}
if (!perCase.length) console.log('  NO CASE CONTAINS A RARITY-6 ITEM');
console.log(`\n  cases containing any gold item: ${perCase.length}/${cases.length}`);

// ---- 3. how many opens to expect one ----
const median = perCase.length
  ? perCase.slice().sort((a, b) => a.p - b.p)[Math.floor(perCase.length / 2)]
  : null;
if (median) {
  console.log(`\n  median case: 1 gold per ${Math.round(1 / median.p)} opens`);
  console.log(`  at 20 opens per session, chance of seeing one: ${(1 - Math.pow(1 - median.p, 20)) * 100 < 0.01 ? '<0.01%' : ((1 - Math.pow(1 - median.p, 20)) * 100).toFixed(2) + '%'}`);
}