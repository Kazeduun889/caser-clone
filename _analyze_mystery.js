/**
 * Reports what the mystery upgrade is worth under the current (uniform) pick.
 * Run with: node _analyze_mystery.js
 */
const fs = require('fs');
const path = require('path');

const map = new Map();
const add = (it) => {
  if (!it || !it.image) return;
  const mn = it.marketName || it.name;
  const p = parseFloat(it.price);
  if (!mn || !Number.isFinite(p)) return;
  if (!map.has(mn) || map.get(mn) < p) map.set(mn, p);
};
for (const f of fs.readdirSync(path.join(__dirname, 'cases_cache'))) {
  if (!f.endsWith('.json')) continue;
  try {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases_cache', f), 'utf8'));
    (d.items || []).forEach(add);
  } catch (e) { /* skip */ }
}

const items = [...map.entries()].map(([name, price]) => ({ name, price }));
const prices = items.map((i) => i.price);
const mean = prices.reduce((a, b) => a + b, 0) / prices.length;

console.log(`предметов в пуле: ${items.length}`);
console.log(`средняя цена:     $${mean.toFixed(2)}`);
console.log(`медиана:          $${prices.slice().sort((a, b) => a - b)[Math.floor(prices.length / 2)].toFixed(2)}`);
console.log(`минимум / максимум: $${Math.min(...prices).toFixed(2)} / $${Math.max(...prices).toFixed(2)}\n`);

console.log('ставка -> средняя выплата -> RTP');
const stakes = [10, 50, 100, 500, 1000, 5000, 20000];
for (const s of stakes) {
  const rtp = mean / s;
  console.log(`  $${String(s).padStart(6)} -> $${mean.toFixed(2).padStart(12)} -> ${(rtp * 100).toFixed(0)}%`);
}

console.log('\nкак часто ставка $500 выигрывает дороже/дешевле неё:');
const s = 500;
const better = prices.filter((p) => p > s).length;
const worse = prices.filter((p) => p < s).length;
console.log(`  дороже: ${((better / prices.length) * 100).toFixed(1)}%`);
console.log(`  дешевле: ${((worse / prices.length) * 100).toFixed(1)}%`);
console.log(`  в 100 раз дороже: ${((prices.filter((p) => p > s * 100).length / prices.length) * 100).toFixed(1)}%`);