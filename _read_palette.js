/**
 * The custom Tailwind shades caser.one uses. The numeric suffixes are not
 * standard Tailwind, so they are defined by the generated CSS - dig them out
 * with the attribute/utility selector rather than expecting `.black-250`.
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '_next/static/chunks');
let css = '';
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.css'))) {
  css += fs.readFileSync(path.join(dir, f), 'utf8');
}

const want = ['black-250', 'black-450', 'white-150', 'white-550', 'white-650', 'white-750', 'white-450'];

for (const w of want) {
  const hits = new Set();
  // utility form: .bg-black-250{...} / .text-white-550{...} / .border-white-10
  const re1 = new RegExp('\\.(?:bg|text|border|from|to|via|ring|fill|stroke)-' + w + '(?![\\w-])[^{]*\\{([^}]*)\\}', 'g');
  let m;
  while ((m = re1.exec(css))) hits.add(m[1].trim().replace(/\s+/g, ' '));
  console.log(w.padEnd(14) + '-> ' + ([...hits].slice(0, 3).join(' | ') || 'NOT FOUND'));
}

console.log('\n--- all custom shade names present ---');
const names = new Set();
for (const m of css.matchAll(/\.(?:bg|text|border|from|to|via|ring|fill|stroke)-(black|white)-(\d+)(?![\w-])/g)) {
  names.add(m[1] + '-' + m[2]);
}
console.log([...names].sort().join('  '));

console.log('\n--- radius scale ---');
const radii = new Set();
for (const m of css.matchAll(/\.rounded-([a-z0-9\[\]\.\/]+)(?![\w-])/g)) radii.add(m[1]);
console.log([...radii].sort().join('  '));

console.log('\n--- a sample of the real dark surface values ---');
for (const sel of ['bg-black-250', 'bg-black-450', 'bg-black-550', 'bg-black-650']) {
  const re = new RegExp('\\.' + sel + '\\s*\\{([^}]*)\\}');
  const m = css.match(re);
  if (m) console.log(sel + ' = ' + m[1].trim().replace(/\s+/g, ' '));
}