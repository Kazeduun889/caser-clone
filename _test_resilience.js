/**
 * The site must survive bad input. Every request here previously could take
 * the whole process down via an unhandled rejection; Render then shows a dead
 * site until someone redeploys.
 */
const http = require('http');

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (!ok && detail ? `\n        ${JSON.stringify(detail).slice(0, 300)}` : ''));
}

function req(method, p, body, cookie) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const headers = {};
    if (data) {
      headers['Content-Type'] = typeof body === 'string' ? 'application/json' : 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (cookie) headers.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port: 3000, path: p, method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', (e) => resolve({ status: 0, body: String(e) }));
    if (data) r.write(data);
    r.end();
  });
}

const alive = async () => {
  const h = await req('GET', '/healthz');
  return h.status === 200;
};

async function main() {
  check('server is up at the start', await alive());

  // Malformed and hostile inputs across every surface.
  const hostile = [
    ['POST', '/api/items/withdraw', { inventoryItemId: null }],
    ['POST', '/api/items/withdraw', { inventoryItemId: { $ne: 1 } }],
    ['POST', '/api/items/withdraw', { inventoryItemId: "'; DROP TABLE withdrawals;--" }],
    ['POST', '/api/items/withdraw', '{}'],
    ['GET', '/api/withdrawals/not-a-real-id', undefined],
    ['GET', '/api/withdrawals?limit=abc&offset=-5', undefined],
    ['GET', '/api/withdrawals?status=<script>', undefined],
    ['POST', '/api/admin/withdrawals/x/complete', {}],
    ['POST', '/api/admin/withdrawals/x/ready', { tradeOfferUrl: 'not-a-url' }],
    ['GET', '/api/admin/withdrawals', undefined],
    ['GET', '/api/notifications?limit=NaN&offset=Infinity', undefined],
    ['POST', '/api/notifications/nope/read', {}],
    ['POST', '/api/game/upgrade/bet', { betInventoryItemIds: 'not-an-array' }],
    ['POST', '/api/game/upgrade/bet', { targetItemId: '<img src=x onerror=alert(1)>' }],
    ['POST', '/api/game/upgrade/bet', { addedBalance: -999999 }],
    ['POST', '/api/game/upgrade/bet', { addedBalance: 1e308 }],
    ['POST', '/api/game/cases/../../etc/passwd/open', {}],
    ['GET', '/api/game/cases/%00/open', undefined],
    ['GET', '/items/shop?priceFrom=abc&priceTo=NaN&limit=-9', undefined],
    ['GET', '/_next/static/chunks/../../../../../../etc/passwd', undefined],
    ['GET', '/cdn/../../package.json', undefined],
    ['POST', '/api/users/me', '{"broken json'],
    ['POST', '/api/game/cases/agent/open', { count: 'x' }]
  ];

  let anyConnectionReset = 0;
  for (const [m, p, b] of hostile) {
    const r = await req(m, p, b);
    if (r.status === 0) anyConnectionReset++;
    // Any HTTP answer is fine; only a dropped connection signals a crash.
    if (r.status !== 0 && r.status !== 200 && r.status < 400 && r.status >= 300) {
      // 3xx is acceptable too
    }
  }
  check(`survived ${hostile.length} hostile requests without a dropped connection`, anyConnectionReset === 0, { anyConnectionReset });
  check('server still alive after hostile input', await alive());

  // Hammer the write path concurrently - this is where the old
  // transaction bug killed the process.
  const concurrent = await Promise.all(
    Array.from({ length: 60 }, (_, i) =>
      req('POST', '/api/items/withdraw', { inventoryItemId: `concurrent-${i}` })
    )
  );
  check('60 concurrent withdrawals all answered',
    concurrent.every((r) => r.status !== 0), { dropped: concurrent.filter((r) => r.status === 0).length });
  check('server alive after concurrency', await alive());

  // And keep serving afterwards.
  const page = await req('GET', '/ru');
  check('site still serves pages', page.status === 200 && page.body.length > 1000, { status: page.status, len: page.body.length });

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('CRASH', e); process.exit(1); });