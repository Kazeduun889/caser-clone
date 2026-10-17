/**
 * Finds the component that consumes /users/:id/stats and lists the fields it
 * reads, so the server returns the exact shape the real page expects.
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '_next', 'static', 'chunks');
const files = fs.readdirSync(dir).filter((x) => x.endsWith('.js'));

for (const f of files) {
  const s = fs.readFileSync(path.join(dir, f), 'utf8');
  let idx = -1;
  while ((idx = s.indexOf('/stats`', idx + 1)) >= 0) {
    // Only care about the one templated on a user id.
    const around = s.slice(Math.max(0, idx - 2600), idx + 2600);
    if (!/\$\{/.test(around.slice(Math.max(0, idx - 2600 - around.indexOf('/stats`')), 0) || around)) continue;
    if (!/\/\$\{[a-z]\}\/stats/.test(around)) continue;

    console.log('=== ' + f + ' ===\n');
    console.log(around.replace(/\s+/g, ' '));
    console.log('\n--- likely field names ---');
    const fields = [...new Set([
      ...[...around.matchAll(/data\.([a-zA-Z_][a-zA-Z0-9_]{2,28})/g)].map((m) => m[1]),
      ...[...around.matchAll(/\.([a-zA-Z_][a-zA-Z0-9_]{2,28})\s*(?:\?\?|\|\|)/g)].map((m) => m[1])
    ])].filter((k) => /rating|best|drop|withdraw|case|upgrade|invent|value|count|total|nick|image|id/i.test(k));
    fields.forEach((x) => console.log('  ' + x));
    process.exit(0);
  }
}