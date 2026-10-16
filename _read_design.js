/**
 * Pulls the real design tokens out of the mirrored caser.one markup so the
 * profile can use the same colours, fonts and radii instead of my guesses.
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'ru', 'index.html'), 'utf8');

const decls = [...html.matchAll(/(--[a-zA-Z0-9_-]+)\s*:\s*([^;"']+)/g)]
  .map((m) => ({ name: m[1], value: m[2].trim() }));

const seen = new Map();
for (const d of decls) if (!seen.has(d.name)) seen.set(d.name, d.value);

console.log('total CSS variables found:', seen.size, '\n');

const groups = {
  brand: /brand/i,
  bg: /^--bg|^--black|^--white-/i,
  text: /text-/i,
  radius: /radius/i,
  font: /font/i,
  accent: /accent/i
};

for (const [label, re] of Object.entries(groups)) {
  const rows = [...seen.entries()].filter(([n]) => re.test(n));
  if (!rows.length) continue;
  console.log('=== ' + label + ' ===');
  rows.slice(0, 28).forEach(([n, v]) => console.log('  ' + n.padEnd(38) + v.slice(0, 40)));
  console.log('');
}

// Tailwind colour classes used across the real pages: that is the palette.
const classes = new Set();
for (const f of ['ru/index.html', 'ru/inventory/index.html', 'ru/cases/index.html']) {
  const t = fs.readFileSync(path.join(__dirname, f), 'utf8');
  for (const m of t.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
  }
}

const colourClasses = [...classes].filter((c) =>
  /^(bg|text|border|from|to|via)-(brand|black|white|green|red|yellow|accent)/.test(c) ||
  /^text-brand/.test(c) || /^bg-brand/.test(c) || /^border-brand/.test(c));

console.log('=== brand colour classes in use ===');
[...new Set(colourClasses)].sort().forEach((c) => console.log('  ' + c));

const fontClasses = [...new Set([...classes].filter((c) => /font-|leading-|tracking-/.test(c)))].sort();
console.log('\n=== typography classes ===');
fontClasses.forEach((c) => console.log('  ' + c));

const radiusClasses = [...new Set([...classes].filter((c) => /rounded/.test(c)))].sort();
console.log('\n=== radius classes ===');
radiusClasses.forEach((c) => console.log('  ' + c));