/**
 * End-to-end check of the withdrawal lifecycle against the real store.
 * Run with: node _test_withdrawal.js
 */
const store = require('./store');
const fs = require('fs');
const path = require('path');

// Fresh user per run: the local store persists, so a fixed id would make every
// assertion see the previous run's rows too.
const USER = 'player_test_' + Date.now().toString(36);

// Grabs one real skin out of the case cache so the payload looks like production.
function sampleItem(nameHint) {
  const CACHE = path.join(__dirname, 'cases_cache');
  let found = null;
  for (const f of fs.readdirSync(CACHE)) {
    if (found || !f.endsWith('.json')) continue;
    const d = JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8'));
    for (const item of d.items || []) {
      const mn = item.marketName || item.name;
      if (!mn || !item.image) continue;
      if (nameHint && !mn.includes(nameHint)) continue;
      const price = parseFloat(item.price);
      if (!Number.isFinite(price)) continue;
      found = {
        id: String(item.id ?? mn), appId: item.appId ?? 730, marketName: mn, name: mn,
        price: String(price), image: item.image, weapon: item.weapon ?? null,
        skin: item.skin ?? null, exterior: item.exterior ?? null,
        stattrak: item.stattrak ?? false, type: item.type ?? null, rarity: item.rarity ?? null
      };
      break;
    }
  }
  if (!found) throw new Error('no sample item found in cases_cache');
  return found;
}

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : `\n        got      ${JSON.stringify(actual)}\n        expected ${JSON.stringify(expected)}`));
}

async function main() {
  await store.init();
  console.log('store mode:', store.getMode());

  const item = sampleItem('Butterfly Knife');
  const entryId = 'won_test_1';

  await store.addInventoryItem(USER, {
    id: entryId, price: parseFloat(item.price), status: 'available',
    canSell: true, canUpgrade: true, item, source: 'giveaway'
  });
  check('item starts available',
    (await store.getInventoryEntry(USER, entryId)).status, 'available');

  // --- create ---------------------------------------------------------------
  const created = await store.createWithdrawal(USER, entryId);
  check('create returns a withdrawal', created.withdrawal && created.withdrawal.status, 'pending');
  check('create camelCases the row', typeof created.withdrawal.inventoryItemId, 'string');
  check('item is locked', (await store.getInventoryEntry(USER, entryId)).status, 'locked_for_withdrawal');

  // Double submit must be refused (the guard, not a race).
  const dupe = await store.createWithdrawal(USER, entryId);
  check('second submit refused', dupe.error, 'Предмет недоступен');

  // Unknown item.
  check('unknown item refused', (await store.createWithdrawal(USER, 'nope')).error, 'Предмет не найден');

  // --- ready ---------------------------------------------------------------
  const wdId = created.withdrawal.id;
  const offer = 'https://steamcommunity.com/tradeoffer/new/?partner=1&token=abc';
  const ready = await store.setWithdrawalStatus(wdId, 'ready', { tradeOfferUrl: offer });
  check('ready status', ready.withdrawal.status, 'ready');
  check('trade offer stored', ready.withdrawal.tradeOfferUrl, offer);
  check('item is trade_ready', (await store.getInventoryEntry(USER, entryId)).status, 'trade_ready');

  // --- completed -----------------------------------------------------------
  const done = await store.setWithdrawalStatus(wdId, 'completed');
  check('completed status', done.withdrawal.status, 'completed');
  check('item left the inventory', await store.getInventoryEntry(USER, entryId), null);

  // A completed withdrawal must not be re-runnable.
  check('cannot re-complete', (await store.setWithdrawalStatus(wdId, 'ready')).error,
    'Cannot go from completed to ready');

  // pending -> completed is the dangerous shortcut: it would delete the item
  // without a trade offer ever being sent.
  const item3 = sampleItem('AWP');
  await store.addInventoryItem(USER, {
    id: 'won_test_3', price: parseFloat(item3.price), status: 'available',
    canSell: true, canUpgrade: true, item: item3, source: 'giveaway'
  });
  const wd3 = (await store.createWithdrawal(USER, 'won_test_3')).withdrawal;
  check('pending cannot jump to completed',
    (await store.setWithdrawalStatus(wd3.id, 'completed')).error,
    'Cannot go from pending to completed');
  check('item survives the refused shortcut', await store.getInventoryEntry(USER, 'won_test_3') !== null, true);
  await store.setWithdrawalStatus(wd3.id, 'ready', { tradeOfferUrl: 'x' });
  check('pending -> ready is allowed', (await store.getWithdrawal(wd3.id)).status, 'ready');
  check('ready -> completed is allowed', (await store.setWithdrawalStatus(wd3.id, 'completed')).withdrawal.status, 'completed');

  // --- failed path (item goes back to sellable) ------------------------------
  const item2 = sampleItem('Karambit');
  await store.addInventoryItem(USER, {
    id: 'won_test_2', price: parseFloat(item2.price), status: 'available',
    canSell: true, canUpgrade: true, item: item2, source: 'giveaway'
  });
  const wd2 = (await store.createWithdrawal(USER, 'won_test_2')).withdrawal;
  const failedRes = await store.setWithdrawalStatus(wd2.id, 'failed');
  check('failed status', failedRes.withdrawal.status, 'failed');
  check('item unlocked after failure', (await store.getInventoryEntry(USER, 'won_test_2')).status, 'available');

  check('unknown status refused', (await store.setWithdrawalStatus(wd2.id, 'bogus')).error, 'Unknown status');
  check('unknown withdrawal', (await store.setWithdrawalStatus('wd_nope', 'ready')).error, 'Withdrawal not found');

  // --- listing / isolation --------------------------------------------------
  const mine = await store.listWithdrawals({ userId: USER });
  check('lists own withdrawals', mine.length, 3);
  const others = await store.listWithdrawals({ userId: 'player_someone_else' });
  check('other users see nothing', others.length, 0);
  const pendingOnly = await store.listWithdrawals({ status: 'failed' });
  check('status filter works', pendingOnly.every((w) => w.status === 'failed'), true);

  // --- notifications --------------------------------------------------------
  await store.createNotification(USER, 'withdrawal_created', { itemName: item.marketName });
  await store.createNotification(USER, 'withdrawal_ready', { tradeOfferUrl: offer });
  const notes = await store.listNotifications(USER);
  check('two notifications', notes.length, 2);
  check('content is parsed, not a string', typeof notes[0].content, 'object');
  // Both rows can share a millisecond, so assert on the set, not on position.
  check('created notification carries the item name',
    notes.some((n) => n.type === 'withdrawal_created' && n.content.itemName === item.marketName), true);
  check('ready notification carries the trade offer',
    notes.some((n) => n.type === 'withdrawal_ready' && n.content.tradeOfferUrl === offer), true);
  check('unread count', await store.countUnreadNotifications(USER), 2);
  await store.markNotificationRead(notes[0].id);
  check('unread count drops after read', await store.countUnreadNotifications(USER), 1);

  // --- concurrency: overlapping writes must not deadlock ----------------------
  // `failed` is terminal, so the ready->failed batch is expected to be rejected
  // by the transition rules. What matters is that every call *settles* and that
  // none dies with a locking error, which is what used to hang the server.
  const burst = await Promise.allSettled(
    Array.from({ length: 50 }, (_, i) =>
      store.setWithdrawalStatus(wd2.id, i % 2 ? 'failed' : 'ready', { tradeOfferUrl: 'x' })
    )
  );
  check('50 overlapping writes all settled', burst.length, 50);
  const lockErrors = burst.filter((r) =>
    r.status === 'rejected' && /BUSY|TRANSACTION_ACTIVE|locked/i.test(r.reason.message));
  check('no locking errors under concurrency', lockErrors.length, 0);

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('\nCRASH:', e.message, '\n', e.stack); process.exit(1); });