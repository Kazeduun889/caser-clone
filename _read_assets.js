/**
 * Lists the stylesheets and font files the real pages load, so the profile can
 * pull the same ones instead of relying on a serif fallback.
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'ru', 'index.html'), 'utf8');

const links = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
console.log('stylesheets on /ru:');
for (const l of links) {
  const p = path.join(__dirname, l.replace(/^\//, ''));
  const size = fs.existsSync(p) ? Math.round(fs.statSync(p).size / 1024) + ' KB' : 'MISSING';
  console.log('  ' + l.padEnd(52) + size);
}

// Font files shipped with the site.
const fonts = [];
for (const dir of ['fonts', 'cdn']) {
  const full = path.join(__dirname, dir);
  if (!fs.existsSync(full)) continue;
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.(woff2?|ttf|otf)$/i.test(f)) fonts.push('/' + path.relative(__dirname, p).replace(/\\/g, '/'));
    }
  };
  walk(full);
}
console.log('\nfont files (' + fonts.length + '):');
fonts.slice(0, 25).forEach((f) => console.log('  ' + f));

// Where the @font-face rules live.
const chunkDir = path.join(__dirname, '_next', 'static', 'chunks');
const cssFiles = fs.readdirSync(chunkDir).filter((f) => f.endsWith('.css'));
console.log('\ncss chunks: ' + cssFiles.map((f) => '/_next/static/chunks/' + f).join('\n            '));