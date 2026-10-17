/**
 * Plays real case opens through the public HTTP API and reports what the player
 * actually experiences: how often the case price is beaten, and how large a
 * typical drop is relative to what was paid.
 *
 * Usage: node _measure_drops.js [opens]
 */
const http = require('http');

const HOST = '127.0.0.1', PORT = 3000;
const TOTAL = parseInt(process.argv[2], 10) || 1500;

function call(method, p, body, cookie) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ host: HOST, port: PORT, path: p, method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let j;
        try { j = JSON.parse(b); } catch (e) { j = b; }
        resolve({ status: res.statusCode, json: j });
      });
    });
    req.on('error', (e) => resolve({ status: 0, json: String(e) }));
    if (data) req.write(data);
    req.end();
  });
}

const BUCKETS = [
  [0, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 1],
  [1, 2], [2, 5], [5, 10], [10, Infinity]
];
const label = ([lo, hi]) =>
  (lo === 0 ? '<0.25' : lo + '-' + (hi === Infinity ? 'inf' : hi)) + 'x';

async function main() {
  const list = (await call('GET', '/api/game/cases')).json.cases || [];
  if (!list.length) throw new Error('no cases from the API');

  // Round-robin over the whole catalogue so no single price point skews it.
  const slugs = list.map((c) => c.slug);
  const priceOf = {};
  for (const c of list) priceOf[c.slug] = parseFloat(c.price) || 0;

  const id = 'player_measure_' + Date.now().toString(36);
  const cookie = `caser_user_id=${id}`;
  await call('GET', '/api/users/me', undefined, cookie);

  const buckets = BUCKETS.map(() => 0);
  const ratios = [];
  let staked = 0, won = 0, done = 0, balance = 0;

  while (done < TOTAL) {
    // Plenty of balance up front; the RTP maths is unaffected by the stake size.
    await call('POST', '/api/users/balance/topup', { amount: 500000 }, cookie);
    const slug = slugs[done % slugs.length];
    const res = await call('POST', `/api/game/cases/${slug}/open`, undefined, cookie);
    if (res.status !== 200) { balance = res.json && res.json.balance; break; }

    const price = priceOf[slug];
    const item = res.json.items && res.json.items[0];
    if (!item || !price) { done++; continue; }

    const r = (parseFloat(item.price) || 0) / price;
    ratios.push(r);
    staked += price;
    won += parseFloat(item.price) || 0;
    BUCKETS.forEach((b, i) => { if (r >= b[0] && r < b[1]) buckets[i]++; });
    done++;
    balance = res.json.balance;
  }

  ratios.sort((a, b) => a - b);
  const q = (p) => ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * p))];
  const atLeast = (m) => ratios.filter((r) => r >= m).length;

  console.log(`opens played : ${ratios.length}`);
  console.log(`balance left : ${balance}`);
  console.log(`RTP          : ${(won / staked * 100).toFixed(2)}%`);
  console.log(`median drop  : ${q(0.5).toFixed(2)}x the case price`);
  console.log(`10th / 90th  : ${q(0.1).toFixed(2)}x / ${q(0.9).toFixed(2)}x`);
  console.log('');
  console.log('where the drops land:');
  BUCKETS.forEach((b, i) => {
    const n = buckets[i];
    const share = (n / ratios.length * 100);
    const bar = '#'.repeat(Math.round(share / 2));
    console.log('  ' + label(b).padEnd(9) + String(n).padStart(5) + '  ' +
      (share.toFixed(1) + '%').padStart(6) + '  ' + bar);
  });
  console.log('');
  console.log('beats the price : ' + (atLeast(1) / ratios.length * 100).toFixed(1) + '%  (1 in ' +
    (ratios.length / atLeast(1)).toFixed(1) + ')');
  console.log('2x or better    : ' + (atLeast(2) / ratios.length * 100).toFixed(2) + '%  (1 in ' +
    (ratios.length / atLeast(2)).toFixed(0) + ')');
  console.log('10x or better   : ' + (atLeast(10) / ratios.length * 100).toFixed(2) + '%  (1 in ' +
    (ratios.length / Math.max(1, atLeast(10))).toFixed(0) + ')');
}

main().catch((e) => { console.error(e); process.exit(1); });