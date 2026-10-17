/**
 * Traces how the profile cards consume useUserStatsQuery's fields, so
 * bestDrop comes back in the right shape.
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '_next', 'static', 'chunks');
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
  const s = fs.readFileSync(path.join(dir, f), 'utf8');
  let i = -1;
  while ((i = s.indexOf('useUserStatsQuery', i + 1)) >= 0) {
    const seg = s.slice(Math.max(0, i - 1800), i + 2200);
    if (/bestDrop\s*\.\s*[a-zA-Z]/.test(seg) || /stats\?\.bestDrop/.test(seg)) {
      console.log('=== ' + f + ' ===\n');
      console.log(seg.replace(/\s+/g, ' '));
      console.log('\n--- bestDrop sub-fields ---');
      console.log([...new Set([...seg.matchAll(/bestDrop\s*\??\.\s*([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1]))].join(', '));
      process.exit(0);
    }
  }
}
console.log('not found inline');