/**
 * Removes the accounts created by the automated tests so they do not pollute
 * "who is the newest player" in the admin panel.
 * Run with: node _cleanup_test_users.js
 */
const path = require('path');
const store = require('./store');
const { createClient } = require('@libsql/client');

const PATTERNS = ['player_test%', 'player_bal%'];

(async () => {
  await store.init();

  const isFile = store.getMode() === 'local';
  const client = isFile
    ? createClient({ url: 'file:' + path.join(__dirname, 'data', 'caser.db') })
    : createClient({ url: store.REMOTE_URL, authToken: process.env.DATABASE_AUTH_TOKEN || undefined });

  const like = (col) => PATTERNS.map(() => `${col} LIKE ?`).join(' OR ');
  const args = PATTERNS;

  const before = await client.execute('SELECT COUNT(*) AS n FROM users');
  console.log('пользователей до:', Number(before.rows[0].n));

  const tables = [
    ['notifications', 'user_id'],
    ['withdrawals', 'user_id'],
    ['inventory_items', 'user_id'],
    ['transactions', 'user_id'],
    ['users', 'id']
  ];

  for (const [table, col] of tables) {
    const res = await client.execute(`DELETE FROM ${table} WHERE ${like(col)}`, args);
    console.log(`  ${table.padEnd(16)} удалено ${res.rowsAffected}`);
  }

  const after = await client.execute('SELECT COUNT(*) AS n FROM users');
  console.log('пользователей после:', Number(after.rows[0].n));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });