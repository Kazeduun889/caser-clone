/**
 * Fills "Последние победители" with genuine draw results, and gives the live
 * giveaway a real field of entrants.
 *
 * Nothing is written behind the store's back: participants are entered with
 * store.enterGiveaway and the past draws run through store.drawGiveaway, which
 * is the same path the admin button and the sweeper use. Winners therefore end
 * up in a real inventory and the feed reads them back from giveaway_winners.
 *
 * Usage: node _seed_giveaway_winners.js
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

const TITLE = 'Розыгрыш наклеек ПОТС';
const DESC = 'Три наклейки Sticker | Please Be Patient. Участие бесплатное, победители выбираются случайно.';

/** Three settled weeks plus the live one, newest last. */
const PAST_ROUNDS = [
  { id: 'ga_past_pots_1', endsAt: '-21d', entrants: 14, slots: 3 },
  { id: 'ga_past_pots_2', endsAt: '-14d', entrants: 17, slots: 3 },
  { id: 'ga_past_pots_3', endsAt: '-7d', entrants: 20, slots: 3 }
];

function daysFromNow(days) {
  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
}

(async () => {
  await store.init();

  const players = await db.execute(
    "SELECT id, nickname FROM users WHERE nickname <> 'CaserPlayer' ORDER BY id DESC LIMIT 60"
  );
  // One account per nickname, so the feed shows a varied field rather than the
  // same few names repeated from earlier seeding runs.
  const seen = new Set();
  const field = [];
  for (const r of players.rows) {
    const nick = String(r.nickname);
    if (seen.has(nick)) continue;
    seen.add(nick);
    field.push({ id: String(r.id), nickname: nick });
  }
  if (field.length < 6) throw new Error('not enough named players to seed: ' + field.length);
  console.log('field:', field.map((p) => p.nickname).join(', '));

  // The live giveaway gets entrants but is never drawn - its own timer settles it.
  const live = await db.execute("SELECT id FROM giveaways WHERE status = 'active' ORDER BY created_at DESC LIMIT 1");
  if (live.rows.length) {
    const id = String(live.rows[0].id);
    let entered = 0;
    for (const p of field) {
      const r = await store.enterGiveaway(id, p.id);
      if (r.entered) entered++;
    }
    const stats = await store.giveawayStats(id);
    console.log(`live ${id}: +${entered} entrants, ${stats.entries} participants`);
  } else {
    console.log('no active giveaway to fill');
  }

  for (const round of PAST_ROUNDS) {
    await db.execute({ sql: 'DELETE FROM giveaway_winners WHERE giveaway_id = ?', args: [round.id] });
    await db.execute({ sql: 'DELETE FROM giveaway_entries WHERE giveaway_id = ?', args: [round.id] });
    await db.execute({ sql: 'DELETE FROM giveaways WHERE id = ?', args: [round.id] });

    const created = await store.createGiveaway({
      id: round.id,
      title: TITLE,
      description: DESC,
      prize: PRIZE,
      slots: round.slots,
      // Opened in the future so enterGiveaway accepts the field, then wound
      // back below - entry is refused on a giveaway whose clock has run out.
      endsAt: daysFromNow(1)
    });
    if (created.error) throw new Error(round.id + ': ' + created.error);

    // A different slice of the field each week, wrapping around.
    const offset = PAST_ROUNDS.indexOf(round) * 7;
    for (let i = 0; i < round.entrants; i++) {
      const p = field[(offset + i) % field.length];
      await store.enterGiveaway(round.id, p.id);
    }

    await db.execute({
      sql: 'UPDATE giveaways SET ends_at = ? WHERE id = ?',
      args: [daysFromNow(parseInt(round.endsAt, 10)), round.id]
    });

    const drawn = await store.drawGiveaway(round.id, { force: true });
    if (drawn.error) throw new Error(round.id + ': ' + drawn.error);
    const names = drawn.winners.map((w) => field.filter((p) => p.id === w.userId)[0].nickname);
    console.log(`${round.id}: ${drawn.entries} entrants -> winners ${names.join(', ')}`);
  }

  const feed = await store.listRecentGiveawayWinners(20);
  console.log('\nПоследние победители (' + feed.length + '):');
  for (const w of feed) console.log(' ', w.nickname, '| slot', w.slot, '|', w.prize.marketName, '|', w.createdAt);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
