/**
 * Isolates the player_stats upsert that works on a local file but returns
 * nothing on Turso.
 */
const path = require('path');
const { createClient } = require('@libsql/client');

const url = process.env.DATABASE_URL || ('file:' + path.join(__dirname, 'data', 'probe.db'));
const isRemote = /^libsql:|^https?:/.test(url);
const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN || undefined });

async function main() {
  console.log('target:', isRemote ? 'REMOTE (Turso)' : 'local file');
  console.log('url:   ', String(url).replace(/:\/\/[^@]*@/, '://***@'), '\n');

  const uid = 'probe_' + Date.now().toString(36);

  await client.execute(`CREATE TABLE IF NOT EXISTS player_stats (
    user_id        TEXT PRIMARY KEY,
    cases_opened   INTEGER NOT NULL DEFAULT 0,
    upgrades_made  INTEGER NOT NULL DEFAULT 0,
    upgrades_won   INTEGER NOT NULL DEFAULT 0,
    best_drop      REAL NOT NULL DEFAULT 0,
    best_drop_name TEXT,
    best_drop_img  TEXT,
    rating         REAL NOT NULL DEFAULT 0
  )`);

  console.log('sqlite version:', (await client.execute('SELECT sqlite_version() AS v')).rows[0].v);

  const sql =
    `INSERT INTO player_stats (user_id, cases_opened, upgrades_made, upgrades_won, best_drop, best_drop_name, best_drop_img, rating)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(user_id) DO UPDATE SET
       cases_opened  = player_stats.cases_opened + excluded.cases_opened,
       upgrades_made = player_stats.upgrades_made + excluded.upgrades_made,
       upgrades_won  = player_stats.upgrades_won  + excluded.upgrades_won,
       best_drop      = CASE WHEN excluded.best_drop > player_stats.best_drop
                             THEN excluded.best_drop ELSE player_stats.best_drop END,
       best_drop_name = CASE WHEN excluded.best_drop > player_stats.best_drop
                             THEN excluded.best_drop_name ELSE player_stats.best_drop_name END,
       best_drop_img  = CASE WHEN excluded.best_drop > player_stats.best_drop
                             THEN excluded.best_drop_img ELSE player_stats.best_drop_img END,
       rating         = player_stats.rating + excluded.rating`;

  console.log('\n--- attempt 1: the full upsert ---');
  try {
    const r = await client.execute({
      sql, args: [uid, 1, 0, 0, 123.45, 'Test Item', 'https://x/y.png', 0]
    });
    console.log('  OK, rowsAffected:', r.rowsAffected);
    const row = await client.execute({ sql: 'SELECT * FROM player_stats WHERE user_id = ?', args: [uid] });
    console.log('  row:', JSON.stringify(row.rows[0]));
  } catch (e) {
    console.log('  FAILED:', e.message);
  }

  console.log('\n--- attempt 2: second insert, same row (the ON CONFLICT path) ---');
  try {
    const r = await client.execute({
      sql, args: [uid, 1, 0, 0, 50, 'Cheaper', 'https://x/z.png', 0]
    });
    console.log('  OK, rowsAffected:', r.rowsAffected);
    const row = await client.execute({ sql: 'SELECT * FROM player_stats WHERE user_id = ?', args: [uid] });
    console.log('  row:', JSON.stringify(row.rows[0]));
    console.log('  -> casesOpened should be 2, bestDrop should stay 123.45');
  } catch (e) {
    console.log('  FAILED:', e.message);
  }

  console.log('\n--- attempt 3: a plain UPDATE, no upsert ---');
  try {
    await client.execute({
      sql: 'INSERT OR IGNORE INTO player_stats (user_id) VALUES (?)', args: [uid + '_b']
    });
    await client.execute({
      sql: 'UPDATE player_stats SET cases_opened = cases_opened + 1, best_drop = 9 WHERE user_id = ?',
      args: [uid + '_b']
    });
    const row = await client.execute({ sql: 'SELECT * FROM player_stats WHERE user_id = ?', args: [uid + '_b'] });
    console.log('  OK, row:', JSON.stringify(row.rows[0]));
  } catch (e) {
    console.log('  FAILED:', e.message);
  }

  process.exit(0);
}

main().catch((e) => { console.error('CRASH', e.message); process.exit(1); });