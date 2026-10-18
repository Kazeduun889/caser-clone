/**
 * Puts the operator's single giveaway on the board without going through the
 * admin HTTP route (the local server mints an ephemeral ADMIN_TOKEN, so the
 * token used by _seed_giveaway.js cannot be trusted here).
 *
 * Outcome: exactly one active giveaway - "Розыгрыш наклеек ПОТС", three
 * Sticker | Please Be Patient prizes, three hours on the clock.
 */
const path = require('path');
const { createClient } = require('@libsql/client');
const store = require('./store');

const db = createClient({ url: 'file:' + path.join(__dirname, 'data', 'caser.db') });

const PRIZE = {
  id: '27301',
  appId: 730,
  marketName: 'Sticker | Please Be Patient',
  price: '97.290',
  image: 'https://community.akamai.steamstatic.com/economy/image/i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJai0ki7VeTHjMmuOHaC619h7cj1_03ofg_wnZ_u-m1L7uKreptvJc-DD3OZxOBi_rk-TXDgzR525WSDzt6hdn3GaQckW5RyTeAOs0LtloK0Y7jj4FDcjo1bjXKpN59SMJA/360fx360f',
  weapon: null,
  skin: 'Please Be Patient',
  exterior: null,
  stattrak: false,
  type: '13',
  rarity: '8'
};

(async () => {
  await store.init();

  await db.execute('DELETE FROM giveaway_winners');
  await db.execute('DELETE FROM giveaway_entries');
  await db.execute('DELETE FROM giveaways');
  console.log('board cleared');

  const res = await store.createGiveaway({
    title: 'Розыгрыш наклеек ПОТС',
    description: 'Три наклейки Sticker | Please Be Patient. Участие бесплатное, победители выбираются случайно.',
    prize: PRIZE,
    slots: 3,
    endsAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString()
  });
  if (res.error) throw new Error(res.error);
  console.log('created:', res.giveaway.id, '| ends', res.giveaway.endsAt);

  const list = await store.listGiveaways({ limit: 10 });
  for (const g of list) {
    const stats = await store.giveawayStats(g.id);
    console.log('  ', g.id, '|', g.title, '| status', g.status, '| slots', g.slots, '| entries', stats.entries, '| live', g.live);
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
