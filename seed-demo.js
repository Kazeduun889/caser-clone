/**
 * Restores the content the rewards page shows on a fresh database.
 *
 * Render's Free plan has an ephemeral filesystem, so the SQLite file is
 * recreated from scratch on every cold start. Without this the giveaway board,
 * the "Последние победители" feed and the "ТОП дроп" feed would all come back
 * empty on the deployed site even though they are populated locally.
 *
 * Every step is guarded by what the database already holds, so a database that
 * already has a live giveaway and named drops is left alone and a restart
 * never duplicates anything.
 */

// Steam CDN avatars that actually resolve. A 404 here leaves the feed rows
// with a broken portrait.
const AVATARS = [
  'https://avatars.steamstatic.com/6ee7f3e3312c196dbdb6bdd754a4e021abc16885_full.jpg',
  'https://avatars.steamstatic.com/b62474de115ac86b1f76c65ee7821bc3a33aebcd_full.jpg',
  'https://avatars.steamstatic.com/f4c7e12795942db02bf89508924f93f92ee40895_full.jpg',
  'https://avatars.steamstatic.com/a91903aaf5442d0b774b9a85239914555d3d1614_full.jpg',
  'https://avatars.steamstatic.com/fd5be41c9a765b8ccc16726ee7686d391031be40_full.jpg'
];

const NAMES = ['clipher', 's1mple_win', 'donk', 'm0NESY', 'sh1ro', 'ZywOo', 'huNter-',
  'electroNic', 'n0rb3r7', 'b1t', 'tolsti', 'sdy'];

const TITLE = 'Розыгрыш наклеек ПОТС';
const DESCRIPTION = 'Три наклейки Sticker | Please Be Patient. Участие бесплатное, победители выбираются случайно.';

const PRIZE = {
  id: '27301',
  appId: 730,
  marketName: 'Sticker | Please Be Patient',
  price: '97.290',
  image: 'https://community.akamai.steamstatic.com/economy/image/i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGJai0ki7VeTHjMmuOHaC619h7cj1_03ofg_wnZ_u-m1L7uKreptvJc-DD3OZxOBi_rk-TXDgzR525WSDzt6hdn3GaQckW5RyTeAOs0LtloK0Y7jj4FDcjo1bjXKpN59SMJA/360fx360f',
  weapon: null,
  skin: 'Please Be Patient',
  exterior: null,
  stattrack: false,
  type: '13',
  rarity: '8'
};

// Settled rounds, purely so "Последние победители" has real rows to show.
const PAST_ROUNDS = [
  { id: 'ga_past_pots_1', entrants: 14, slots: 3, offset: 0 },
  { id: 'ga_past_pots_2', entrants: 14, slots: 3, offset: 5 },
  { id: 'ga_past_pots_3', entrants: 14, slots: 3, offset: 9 }
];

const DEMO_BALANCE = 2043.31;
const DROPS_PER_PLAYER = 4;
const POOL_SIZE = 40;
// The catalogue runs up to seven figures; a feed made of those would read as
// fabricated, so the demo drops stay inside the band real sessions produce.
const POOL_MAX_PRICE = 5000;

/** The page falls back to "CaserPlayer" for a visitor who never signed in. */
function isNamed(drop) {
  const nick = drop.user && drop.user.nickname;
  return !!nick && nick !== 'CaserPlayer' && nick !== 'Игрок';
}

async function createPlayers(store) {
  const players = [];
  for (let i = 0; i < NAMES.length; i++) {
    players.push(await store.createUser({
      id: await store.nextUserId(),
      nickname: NAMES[i],
      image: AVATARS[i % AVATARS.length],
      balance: DEMO_BALANCE
    }));
  }
  return players;
}

async function seedGiveaways(store, players) {
  const live = await store.listGiveaways({ onlyActive: true, limit: 1 });
  if (!live.length) {
    await store.createGiveaway({
      title: TITLE,
      description: DESCRIPTION,
      prize: PRIZE,
      slots: 3,
      endsAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
    });
  }

  const winners = await store.listRecentGiveawayWinners(1);
  if (winners.length || !players.length) return;

  // The rounds are created open and drawn on the spot. enterGiveaway refuses a
  // giveaway whose clock has run out, so the entries have to be placed first;
  // the draw itself is what closes them.
  for (const round of PAST_ROUNDS) {
    const created = await store.createGiveaway({
      id: round.id,
      title: TITLE,
      description: DESCRIPTION,
      prize: PRIZE,
      slots: round.slots,
      endsAt: new Date(Date.now() + 3600 * 1000).toISOString()
    });
    if (created.error) continue;

    for (let i = 0; i < round.entrants; i++) {
      const player = players[(round.offset + i) % players.length];
      await store.enterGiveaway(round.id, player.id);
    }
    await store.drawGiveaway(round.id, { force: true });
  }
}

/** A spread of price points, so the feed looks like play rather than a shelf of duplicates. */
function pickPool(items) {
  if (!Array.isArray(items)) return [];
  const usable = items
    .filter((i) => i && i.image && Number.isFinite(i.price) && i.price > 0 && i.price <= POOL_MAX_PRICE)
    .slice()
    .sort((a, b) => a.price - b.price);
  if (!usable.length) return [];

  const pool = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const item = usable[Math.floor((i + 0.5) * usable.length / POOL_SIZE)];
    if (item && !pool.includes(item)) pool.push(item);
  }
  return pool;
}

async function seedDrops(store, players, items) {
  const pool = pickPool(items);
  if (!players.length || !pool.length) return;

  // Round-robin over the accounts so the newest rows are mixed instead of
  // stacked under a single nickname.
  for (let r = 0; r < DROPS_PER_PLAYER; r++) {
    for (let p = 0; p < players.length; p++) {
      const item = pool[(r * players.length + p) % pool.length];
      await store.recordDrop(players[p].id, item, item.price, 'case');
    }
  }
}

async function seedDemoContent(store, items) {
  const [live, winners, recentDrops] = await Promise.all([
    store.listGiveaways({ onlyActive: true, limit: 1 }),
    store.listRecentGiveawayWinners(1),
    store.listRecentDrops(60)
  ]);

  const named = recentDrops.filter(isNamed);
  if (live.length && winners.length && named.length) return;

  let players = null;
  const getPlayers = async () => (players = players || await createPlayers(store));

  if (!live.length || !winners.length) await seedGiveaways(store, await getPlayers());
  if (!named.length) await seedDrops(store, await getPlayers(), items);

  console.log('[seed] demo content restored for a fresh database');
}

module.exports = { seedDemoContent };
