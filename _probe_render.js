/**
 * Measures the real response time of the deployed site, with a long timeout.
 * Usage: node _probe_render.js [url] [timeoutSeconds]
 */
const https = require('https');

const url = process.argv[2] || 'https://caser-clone.onrender.com/healthz';
const timeoutSec = parseInt(process.argv[3] || '180', 10);

const t0 = Date.now();
const req = https.get(url, { timeout: timeoutSec * 1000 }, (res) => {
  const firstByte = Date.now() - t0;
  let bytes = 0;
  res.on('data', (c) => { bytes += c.length; });
  res.on('end', () => {
    console.log(`status       ${res.statusCode}`);
    console.log(`first byte   ${(firstByte / 1000).toFixed(2)} s`);
    console.log(`total        ${((Date.now() - t0) / 1000).toFixed(2)} s`);
    console.log(`bytes        ${bytes}`);
    const enc = res.headers['content-encoding'] || 'none';
    console.log(`encoding     ${enc}`);
    console.log(`server       ${res.headers['server'] || '-'}`);
    process.exit(res.statusCode === 200 ? 0 : 1);
  });
});
req.on('timeout', () => {
  console.log(`TIMEOUT after ${timeoutSec}s (no response at all)`);
  req.destroy();
  process.exit(2);
});
req.on('error', (e) => {
  console.log(`ERROR after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${e.message}`);
  process.exit(3);
});