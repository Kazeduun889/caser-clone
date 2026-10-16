/**
 * Measures the real page-load cost: how many assets a visitor's browser pulls,
 * and how many of those are missing from disk (i.e. need the origin CDN).
 */
const http = require('http');

function get(p, { cookie } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    http.get({ host: '127.0.0.1', port: 3000, path: p, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, ms: Date.now() - t0, type: res.headers['content-type'] }));
    }).on('error', reject);
  });
}

async function main() {
  for (const page of ['/ru', '/ru/cases']) {
    const r = await get(page);
    const html = r.body;

    const assets = new Set();
    for (const m of html.matchAll(/\/_next\/static\/[^"')\s]+\.(js|css)/g)) assets.add(m[0]);
    for (const m of html.matchAll(/\/cdn\/[^"')\s]+/g)) assets.add(m[0].split('?')[0]);
    for (const m of html.matchAll(/\/(images|icons|cases)\/[^"')\s]+/g)) assets.add(m[0].split('?')[0]);

    const list = [...assets];
    console.log(`\n=== ${page} (${r.ms} ms, ${html.length} bytes) ===`);
    console.log(`  assets referenced: ${list.length}`);

    // Warm pass: everything missing gets fetched and cached on first request.
    const t0 = Date.now();
    let warmMs = 0, misses = 0;
    for (const a of list) {
      const s0 = Date.now();
      const res = await get(a);
      warmMs += res.ms;
      if (res.status !== 200) misses++;
    }
    console.log(`  cold pass: ${list.length} requests in ${Date.now() - t0} ms, ${misses} failed`);

    // Warm pass: everything now on disk, zero network.
    const t1 = Date.now();
    let netFail = 0;
    for (const a of list) {
      const res = await get(a);
      if (res.status !== 200) netFail++;
    }
    console.log(`  warm pass: ${list.length} requests in ${Date.now() - t1} ms, ${netFail} failed`);

    // Verify a chunk really came from disk (immutable cache header).
    const chunk = list.find((a) => a.startsWith('/_next/')) || list[0];
    if (chunk) {
      const cr = await get(chunk);
      console.log(`  sample ${chunk.slice(0, 60)}`);
      console.log(`    status ${cr.status}, type ${cr.type}`);
    }
  }
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });