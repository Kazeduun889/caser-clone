/**
 * Lists the API paths the mirrored bundle actually calls, so the server can
 * satisfy them instead of guessing what a page needs.
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '_next', 'static', 'chunks');
const re = /api\.(get|post|put|delete)\(\s*[`'"]([^`'"]+)[`'"]/g;

const all = new Map();
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
  const s = fs.readFileSync(path.join(dir, f), 'utf8');
  let m;
  while ((m = re.exec(s))) {
    const key = m[1].toUpperCase() + ' ' + m[2];
    if (!all.has(key)) all.set(key, f);
  }
}

const wanted = [...all.keys()].filter((k) =>
  /profile|inventory|balance|stat|rating|best|withdraw|user|drop|bonus|promo|case|upgrade/i.test(k)
).sort();

console.log('endpoints the bundle calls (' + wanted.length + '):\n');
for (const k of wanted) console.log('  ' + k);

console.log('\n--- all endpoints (' + all.size + ') ---');
[...all.keys()].sort().forEach((k) => console.log('  ' + k));