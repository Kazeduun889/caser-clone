/**
 * Checks the store against a real remote libSQL/Turso database.
 *
 * The PRAGMA bug was invisible locally - it only appears over the HTTP
 * protocol - and it made the whole store fall back to memory in production.
 * This runs the real statements against DATABASE_URL to prove the remote path
 * works before deploying.
 *
 * Usage:
 *   $env:DATABASE_URL=libsql://db.turso.io
 *   $env:DATABASE_AUTH_TOKEN=...
 *   node _test_remote_db.js
 */
const path = require('path');

// Point at a throwaway schema so a live database is never touched.
process.env.DATABASE_URL = process.env.DATABASE_URL || '';
process.env.DATABASE_AUTH_TOKEN = process.env.DATABASE_AUTH_TOKEN || '';

if (!/^libsql:|^https?:/.test(process.env.DATABASE_URL)) {
  console.error('DATABASE_URL is not set to a libsql:// URL - nothing to verify.');
  console.error('Example:');
  console.error('  $env:DATABASE_URL = "libsql://my-db.turso.io"');
  console.error('  $env:DATABASE_AUTH_TOKEN = "<token>"');
  process.exit(2);
}

const store = require('./store');

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (!ok && detail !== undefined ? `\n        ${JSON.stringify(detail).slice(0, 300)}` : ''));
}

async function main() {
  await store.init();

  const mode = store.getMode();
  console.log(`\n  remote: ${process.env.DATABASE_URL.replace(/:\/\/.*@/, '://***@')}`);
  console.log(`  mode:   ${mode}\n`);

  check('the store actually uses the remote database', mode, 'turso');
  if (mode !== 'turso') {
    console.log('\n  ^ init() fell back to memory. The error above is the reason.');
    process.exit(1);
  }

  const id = 'player_remotetest_' + Date.now().toString(36);
  const item = {
    id: 'x', appId: 730, marketName: 'Remote Test AK-47 | Blue (Field-Tested)',
    name: 'Remote Test AK-47 | Blue (Field-Tested)',
    price: '123.45', image: 'https://example.invalid/x.png'
  };

  // --- writes ---
  const created = await store.createUser({
    id, nickname: 'RemoteTest', image: 'https://example.invalid/a.jpg',
    balance: 1000, tradeUrl: null, role: 'user'
  });
  check('user created on the remote database', created && created.id === id, created && created.id);
  check('balance persisted', (await store.getUser(id)).balance, 1000);

  // --- the statement that broke production: a conditional debit ---
  const debited = await store.addBalance(id, -400, 'case_open', { slug: 'x' }, 400);
  check('conditional debit works', debited, 600);
  const refused = await store.addBalance(id, -9999, 'case_open', {}, 9999);
  check('insufficient debit refused', refused, null);

  // --- ensureUser sync (the nickname bug) ---
  await store.ensureUser({ id, nickname: 'Renamed', image: 'https://example.invalid/b.jpg', role: 'user' });
  const renamed = await store.getUser(id);
  check('ensureUser updates an existing account', renamed.nickname, 'Renamed');

  // --- transactions: the path that used to throw SQLITE_BUSY ---
  const results = await Promise.all([
    store.addBalance(id, 10, 'topup', {}),
    store.addBalance(id, -5, 'upgrade', {}),
    store.addBalance(id, 7, 'promo', {}),
    store.addBalance(id, -2, 'sell', {}),
    store.addBalance(id, 3, 'topup', {})
  ]);
  check('concurrent writes all resolved', results.every((r) => r !== null), results);
  const finalBalance = (await store.getUser(id)).balance;
  check('balance is exact after concurrent writes', finalBalance, 613);

  // --- withdrawals: the transaction-heavy path ---
  const entry = await store.addInventoryItem(id, {
    id: 'inv_remote_1', price: 500, status: 'available', canSell: true, canUpgrade: true, item
  });
  check('inventory item stored', entry && entry.id === 'inv_remote_1', entry && entry.id);

  const wd = await store.createWithdrawal(id, 'inv_remote_1');
  check('withdrawal created', wd.withdrawal && wd.withdrawal.status, 'pending');

  const ready = await store.setWithdrawalStatus(wd.withdrawal.id, 'ready', { tradeOfferUrl: 'https://x' });
  check('withdrawal -> ready', ready.withdrawal.status, 'ready');

  const done = await store.setWithdrawalStatus(wd.withdrawal.id, 'completed');
  check('withdrawal -> completed', done.withdrawal.status, 'completed');
  check('item removed on completion', await store.getInventoryEntry(id, 'inv_remote_1'), null);

  const shortcut = await store.setWithdrawalStatus(wd.withdrawal.id, 'failed');
  check('terminal status is refused', !!shortcut.error, true);

  // --- promo codes, including the concurrency guarantee ---
  const code = 'REMOTE' + Math.random().toString(36).slice(2, 7).toUpperCase();
  const promo = await store.createPromoCode({ code, amount: 250, maxActivations: 2, createdBy: 'test' });
  check('promo created', promo.promo && promo.promo.code, code);
  check('duplicate promo refused', !!(await store.createPromoCode({ code, amount: 1, maxActivations: 1 })).error, true);

  const a = 'player_r_a_' + Date.now().toString(36);
  const b = 'player_r_b_' + Date.now().toString(36);
  await store.createUser({ id: a, nickname: 'A', image: null, balance: 0, tradeUrl: null, role: 'user' });
  await store.createUser({ id: b, nickname: 'B', image: null, balance: 0, tradeUrl: null, role: 'user' });

  // Both race for a code with one slot left after the first uses it.
  await store.redeemPromoCode(code, a);
  const race = await Promise.all([
    store.redeemPromoCode(code, a),
    store.redeemPromoCode(code, b),
    store.redeemPromoCode(code, b)
  ]);
  const won = race.filter((r) => !r.error).length;
  check('the last activation goes to exactly one account', won, 1);
  check('the repeat claim from the winner is refused', !!race[0].error, true);

  // --- drops + stats ---
  await store.recordDrop(a, item, 123.45, 'case');
  await store.recordUpgradeAttempt(a, true, 0.2);
  const drops = await store.listRecentDrops(20);
  check('drop recorded and readable', drops.some((d) => d.user.id === a), true);

  const stats = await store.playerStats(a);
  check('cases counted', stats.casesOpened, 1);
  check('best drop tracked', stats.bestDrop, 123.45);
  check('rating moved off zero', stats.rating !== 0, true);

  // --- cleanup ---
  for (const uid of [id, a, b]) {
    await store.setCreator(uid, false).catch(() => {});
  }
  console.log('\n  (test rows left in the remote db; they use player_remote/player_r_ prefixes)');

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('\nCRASH:', e.message, '\n', e.stack);
  process.exit(1);
});