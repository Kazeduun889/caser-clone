/**
 * Persistent storage layer.
 *
 * Two modes, one code path:
 *   - Turso / libSQL remote  -> DATABASE_URL=libsql://... + DATABASE_AUTH_TOKEN
 *   - Local SQLite file     -> used when DATABASE_URL is not set
 *
 * The driver (@libsql/client) speaks the same SQL in both cases, so there is a
 * single implementation. Everything is async because the remote protocol is
 * HTTP-based.
 *
 * On Render's FREE plan the local filesystem is ephemeral, so the file mode
 * loses data on every spin-down / redeploy. Use Turso there.
 */
const fs = require('fs');
const path = require('path');

const START_BALANCE = 2043.31;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const REMOTE_URL = process.env.DATABASE_URL || '';
const AUTH_TOKEN = process.env.DATABASE_AUTH_TOKEN || '';

let client = null;
let mode = 'memory';
let ready = false;
let initError = null;

// ---------------------------------------------------------------------------
// In-memory fallback: the site still boots if the database is unreachable.
// ---------------------------------------------------------------------------
const mem = {
  users: new Map(),
  inventory: new Map(), // userId -> [entry]
  transactions: [],
  opens: [],
  withdrawals: [],
  notifications: [],
  promos: [],
  promoRedemptions: [],
  drops: [],
  stats: new Map()
};

// Mirrors MAX_MONEY in server.js. Kept here so the store never writes a
// balance the client would be unable to render.
const MAX_BALANCE_ALLOWED = 1e12;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
async function init() {
  if (ready) return;

  const isRemote = /^libsql:|^https?:/.test(REMOTE_URL);

  try {
    const { createClient } = require('@libsql/client');

    if (isRemote) {
      client = createClient({ url: REMOTE_URL, authToken: AUTH_TOKEN || undefined });
      mode = 'turso';
    } else {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      client = createClient({ url: `file:${path.join(DATA_DIR, 'caser.db')}` });
      mode = 'local';
    }

    // PRAGMAs are local-SQLite only. libSQL over HTTP rejects them outright:
    //   SQL_PARSE_ERROR: SQL not allowed statement: PRAGMA busy_timeout = 10000
    // Running them against Turso made init() throw, the store silently fell
    // back to `memory`, and every balance, inventory and promo code was lost
    // on each restart - which looked like "the deploy wipes my data".
    if (!isRemote) {
      // Concurrent readers should not block the single writer, and a blocked
      // writer should wait instead of throwing SQLITE_BUSY straight away.
      await client.execute('PRAGMA busy_timeout = 10000');
      await client.execute('PRAGMA journal_mode = WAL');
    }

    await migrate();
    // Fail fast on a bad connection instead of erroring on the first request
    await client.execute('SELECT 1');
    ready = true;
    console.log(`[store] ready (${mode}) -> ${isRemote ? REMOTE_URL : DATA_DIR}`);
    if (!isRemote && (process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME)) {
      console.warn('[store] WARNING: local SQLite file on a host with an ephemeral filesystem.');
      console.warn('[store]          Balances, inventories, withdrawals, promo codes and drops are');
      console.warn('[store]          WIPED on every deploy, restart or spin-down. Set DATABASE_URL');
      console.warn('[store]          and DATABASE_AUTH_TOKEN to a Turso database to keep them.');
    }
  } catch (err) {
    initError = err.message;
    mode = 'memory';
    ready = true;
    console.warn(`[store] database unavailable (${err.message}); falling back to memory`);
  }
}

/** Only intended for tests / diagnostics. */
async function resetConnection() {
  if (client && typeof client.close === 'function') {
    try { await client.close(); } catch (e) { /* ignore */ }
  }
  client = null;
  ready = false;
  await init();
}

const now = () => new Date().toISOString();

function newId(prefix) {
  const rand = Math.floor(Math.random() * 1e9).toString(36);
  return `${prefix || 'id'}_${Date.now().toString(36)}${rand}`;
}

/** libSQL only accepts JSON primitives - never undefined, booleans, dates. */
const val = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') return v;
  return String(v);
};

/**
 * Serialises write transactions inside this process.
 *
 * libSQL/SQLite allows exactly one writer. Two overlapping write transactions
 * from the same Node process do not wait for each other politely - the second
 * one dies with SQLITE_BUSY. Chaining them on a single promise makes the
 * database effectively single-writer while leaving reads fully concurrent.
 */
let writeChain = Promise.resolve();

/**
 * Runs fn inside a database transaction. The callback receives the transaction
 * handle - every statement MUST go through it (`tx.execute`), never through the
 * client directly: touching the client while a write transaction is open asks
 * the pool for a second connection and fails with TRANSACTION_ACTIVE/SQLITE_BUSY.
 * Commits on success, rolls back on any thrown error.
 */
async function dbTransaction(fn) {
  if (mode === 'memory') return fn({ execute: async () => ({ rowsAffected: 1 }), batch: async () => [] });

  const run = writeChain.then(async () => {
    const tx = await client.transaction('write');
    try {
      const out = await fn(tx);
      await tx.commit();
      return out;
    } catch (err) {
      try { await tx.rollback(); } catch (e) { /* ignore */ }
      throw err;
    }
  });

  // Keep the chain alive even if this transaction rejects.
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
async function migrate() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      nickname    TEXT,
      image       TEXT,
      balance     REAL NOT NULL,
      trade_url   TEXT,
      role        TEXT NOT NULL DEFAULT 'user',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS inventory_items (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      market_name  TEXT,
      image        TEXT,
      price        REAL NOT NULL DEFAULT 0,
      status       TEXT NOT NULL DEFAULT 'available',
      can_sell     INTEGER NOT NULL DEFAULT 1,
      can_upgrade  INTEGER NOT NULL DEFAULT 1,
      item_json    TEXT NOT NULL,
      source       TEXT NOT NULL DEFAULT 'case',
      created_at   TEXT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_inv_user ON inventory_items(user_id, created_at DESC)',
    `CREATE TABLE IF NOT EXISTS transactions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        TEXT NOT NULL,
      type           TEXT NOT NULL,
      delta          REAL NOT NULL,
      balance_after  REAL NOT NULL,
      meta           TEXT,
      created_at     TEXT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, id DESC)',
    `CREATE TABLE IF NOT EXISTS case_opens (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT NOT NULL,
      case_slug   TEXT NOT NULL,
      cost        REAL NOT NULL,
      items_json  TEXT NOT NULL,
      created_at  TEXT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_open_user ON case_opens(user_id, id DESC)',
    `CREATE TABLE IF NOT EXISTS withdrawals (
      id                TEXT PRIMARY KEY,
      user_id           TEXT NOT NULL,
      inventory_item_id TEXT NOT NULL,
      market_name       TEXT,
      price             REAL NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'pending',
      trade_offer_url   TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_wd_status ON withdrawals(status, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_wd_user ON withdrawals(user_id, created_at DESC)',
    `CREATE TABLE IF NOT EXISTS notifications (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      type       TEXT NOT NULL,
      content    TEXT NOT NULL,
      is_read    INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_ntf_user ON notifications(user_id, id DESC)',
    `CREATE TABLE IF NOT EXISTS promo_codes (
      id              TEXT PRIMARY KEY,
      code            TEXT NOT NULL,
      amount          REAL NOT NULL,
      max_activations INTEGER NOT NULL DEFAULT 1,
      activations     INTEGER NOT NULL DEFAULT 0,
      is_active       INTEGER NOT NULL DEFAULT 1,
      created_by      TEXT,
      expires_at      TEXT,
      created_at      TEXT NOT NULL
    )`,
    // One row per code: the UNIQUE index is what makes redeeming race-free.
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_code ON promo_codes(code)',
    `CREATE TABLE IF NOT EXISTS promo_redemptions (
      id         TEXT PRIMARY KEY,
      code_id    TEXT NOT NULL,
      code       TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      amount     REAL NOT NULL,
      created_at TEXT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_promo_red_user ON promo_redemptions(user_id, code)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_once ON promo_redemptions(user_id, code)',
    // Every item a player actually wins, so the live feed and the profile
    // stats reflect real play instead of a generated loop.
    `CREATE TABLE IF NOT EXISTS drops (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      item_id     TEXT,
      market_name TEXT,
      image       TEXT,
      price       REAL NOT NULL DEFAULT 0,
      rarity      TEXT,
      source      TEXT NOT NULL DEFAULT 'case',
      created_at  TEXT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_drops_recent ON drops(created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_drops_user ON drops(user_id, price DESC)',
    // Counts upgrades separately from case opens for the profile tiles.
    `CREATE TABLE IF NOT EXISTS player_stats (
      user_id        TEXT PRIMARY KEY,
      cases_opened   INTEGER NOT NULL DEFAULT 0,
      upgrades_made  INTEGER NOT NULL DEFAULT 0,
      upgrades_won   INTEGER NOT NULL DEFAULT 0,
      best_drop      REAL NOT NULL DEFAULT 0,
      best_drop_name TEXT,
      best_drop_img  TEXT,
      rating         REAL NOT NULL DEFAULT 0
    )`,
    // Sequential account numbers (1, 2, 3 ...). Kept as a row so concurrent
    // signups cannot collide on a MAX(id)+1 read.
    `CREATE TABLE IF NOT EXISTS counters (
      name  TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    )`,

    // Giveaways. One entry per player per giveaway, and the draw happens once
    // the timer expires - winners are picked at random from the entrants.
    `CREATE TABLE IF NOT EXISTS giveaways (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      description   TEXT,
      prize_json    TEXT NOT NULL,
      prize_name    TEXT,
      prize_image   TEXT,
      prize_rarity  TEXT,
      slots         INTEGER NOT NULL DEFAULT 1,
      ends_at       TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active',
      created_at    TEXT NOT NULL,
      drawn_at      TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS giveaway_entries (
      giveaway_id TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (giveaway_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS giveaway_winners (
      giveaway_id TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      slot        INTEGER NOT NULL DEFAULT 1,
      item_id     TEXT,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (giveaway_id, user_id)
    )`,

    // Old random account slugs (player_xxx...) map onto the numbered account
    // that replaced them, so a returning visitor with an old cookie - and an
    // ADMIN_IDS entry written before numbering - still finds the same account.
    `CREATE TABLE IF NOT EXISTS id_aliases (
      old_id     TEXT PRIMARY KEY,
      new_id     TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`
  ];
  await client.batch(statements.map((sql) => ({ sql })), 'write');

  // Added after the first release, so existing databases need the column added
  // separately. SQLite has no ADD COLUMN IF NOT EXISTS, so a duplicate-column
  // error is the expected "already there" signal.
  try {
    await client.execute('ALTER TABLE users ADD COLUMN is_creator INTEGER NOT NULL DEFAULT 0');
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }

  // The best-drop frame is tinted with the item's own rarity colour, so the
  // tier has to be remembered next to the name and image.
  try {
    await client.execute('ALTER TABLE player_stats ADD COLUMN best_drop_rarity TEXT');
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }

  // Where an item came from. Only 'giveaway' items may be withdrawn right now -
  // everything won in a case or an upgrade is stuck in the inventory.
  try {
    await client.execute("ALTER TABLE inventory_items ADD COLUMN source TEXT NOT NULL DEFAULT 'case'");
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }

  // Backfill rows recorded before the column existed, so an established
  // player's best-drop frame tints correctly instead of staying grey.
  try {
    await client.execute(
      `UPDATE player_stats
          SET best_drop_rarity = (
            SELECT d.rarity FROM drops d
             WHERE d.user_id = player_stats.user_id
               AND d.rarity IS NOT NULL
             ORDER BY ABS(d.price - player_stats.best_drop) ASC
             LIMIT 1
          )
        WHERE best_drop_rarity IS NULL AND best_drop > 0`
    );
  } catch (e) {
    // A missing drops table is not fatal; the frame just stays at the default.
  }
}

/**
 * Hands out account numbers 1, 2, 3 ... so the profile can show a plain
 * "ID:242408" like the original instead of a random slug.
 *
 * The counter is a row rather than a SELECT MAX(id)+1 so two visitors joining
 * at the same moment cannot be handed the same number. Concurrent bumps are
 * retried until one actually advances the row.
 */
async function nextUserId() {
  if (mode === 'memory') {
    mem.counters = mem.counters || { user_seq: 0 };
    mem.counters.user_seq += 1;
    return String(mem.counters.user_seq);
  }

  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await client.execute({
      sql: "SELECT value FROM counters WHERE name = 'user_seq'"
    });
    const now = cur.rows.length ? Number(cur.rows[0].value) || 0 : 0;
    const next = now + 1;

    const bumped = await client.execute({
      sql: `UPDATE counters SET value = ? WHERE name = 'user_seq' AND value = ?`,
      args: [next, now]
    });
    if (bumped.rowsAffected) return String(next);

    // Someone else moved it first; read again and retry.
    const created = await client.execute({
      sql: "INSERT OR IGNORE INTO counters (name, value) VALUES ('user_seq', ?)",
      args: [next]
    });
    if (created.rowsAffected) return String(next);
  }

  // Should not happen; a unique id is better than a failed registration.
  return newId('player');
}

/**
 * Renumbers an account that still carries a pre-numbering slug (player_xxx...).
 *
 * The slug keeps its balance, inventory, statistics and history - everything is
 * moved onto the next account number in one batch - and the slug is remembered
 * as an alias, so the old cookie lands on the same account on every later
 * visit. Returns null when the slug never belonged to anyone, which tells the
 * caller to simply mint a fresh number.
 */
async function migrateLegacyUser(oldId) {
  const oid = String(oldId);
  if (mode === 'memory') return oid;

  const aliased = await client.execute({
    sql: 'SELECT new_id FROM id_aliases WHERE old_id = ?',
    args: [oid]
  });
  if (aliased.rows.length) return String(aliased.rows[0].new_id);

  const found = await client.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [oid] });
  if (!found.rows.length) return null;

  const newIdNum = String(await nextUserId());

  // Copy the user row across with its real column list - guessing column names
  // would break the moment the schema gains one - then repoint every table
  // that references a user, then drop the slug and record the alias. One batch
  // = one transaction, so a failure cannot leave a half-migrated account.
  const statements = [];
  const userCols = (await client.execute('PRAGMA table_info("users")')).rows.map((c) => c.name);
  const row = found.rows[0];
  statements.push({
    sql: 'INSERT INTO users (' + userCols.map((c) => '"' + c + '"').join(', ') + ') VALUES ('
      + userCols.map(() => '?').join(', ') + ')',
    args: userCols.map((c) => (c === 'id' ? newIdNum : row[c]))
  });

  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('users', 'id_aliases')");
  for (const t of tables.rows) {
    const info = await client.execute('PRAGMA table_info("' + t.name + '")');
    if (info.rows.some((c) => c.name === 'user_id')) {
      statements.push({
        sql: 'UPDATE "' + t.name + '" SET user_id = ? WHERE user_id = ?',
        args: [newIdNum, oid]
      });
    }
  }

  statements.push({ sql: 'DELETE FROM users WHERE id = ?', args: [oid] });
  statements.push({
    sql: 'INSERT OR REPLACE INTO id_aliases (old_id, new_id, created_at) VALUES (?, ?, ?)',
    args: [oid, newIdNum, now()]
  });
  await client.batch(statements, 'write');
  return newIdNum;
}

/**
 * True when the account's number came from a slug listed in `ids`. Keeps the
 * operator's own ADMIN_IDS entry working after their account was renumbered.
 */
async function legacyAdminMatch(userId, ids) {
  if (mode === 'memory' || !ids || !ids.size) return false;
  const res = await client.execute({
    sql: 'SELECT old_id FROM id_aliases WHERE new_id = ?',
    args: [String(userId)]
  });
  return res.rows.some((r) => ids.has(String(r.old_id)));
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    nickname: row.nickname,
    image: row.image,
    balance: Number(row.balance),
    tradeUrl: row.trade_url,
    role: row.role,
    createdAt: row.created_at,
    // The green tick. Only the operator can set this.
    isCreator: !!row.is_creator
  };
}

async function getUser(id) {
  if (!id) return null;
  const uid = String(id);
  if (mode === 'memory') return mem.users.get(uid) || null;
  const res = await client.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [uid] });
  return res.rows.length ? rowToUser(res.rows[0]) : null;
}

async function createUser(user) {
  const id = String(user.id || newId('player'));
  const record = {
    id,
    nickname: val(user.nickname) ?? 'CaserPlayer',
    image: val(user.image),
    balance: Number.isFinite(Number(user.balance)) ? Number(user.balance) : START_BALANCE,
    trade_url: val(user.tradeUrl),
    role: val(user.role) ?? 'user'
  };
  const ts = now();

  if (mode === 'memory') {
    const entity = { ...record, tradeUrl: record.trade_url };
    mem.users.set(id, entity);
    return entity;
  }

  await client.execute({
    sql: `INSERT INTO users (id, nickname, image, balance, trade_url, role, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING`,
    args: [record.id, record.nickname, record.image, record.balance, record.trade_url, record.role, ts, ts]
  });
  return getUser(id);
}

/** Returns the existing user or creates one with the starting balance. */
/**
 * Returns the account, creating it if needed, and keeps the profile fields in
 * sync when the client sends them.
 *
 * It used to be `getUser(id) || createUser(user)`, which meant an account that
 * had been created by an earlier /api/users/me call never picked up the
 * nickname, avatar or trade link the client had sent since - every player
 * stayed "CaserPlayer" forever.
 */
async function ensureUser(user) {
  const existing = await getUser(user.id);
  if (!existing) return createUser(user);

  const nickname = user.nickname || existing.nickname;
  const image = user.image || existing.image;
  const tradeUrl = user.tradeUrl !== undefined ? user.tradeUrl : existing.tradeUrl;
  const role = user.role || existing.role;

  if (nickname === existing.nickname && image === existing.image
      && tradeUrl === existing.tradeUrl && role === existing.role) {
    return existing;
  }

  if (mode === 'memory') {
    const u = mem.users.get(String(user.id));
    Object.assign(u, { nickname, image, tradeUrl, role });
    return { ...u };
  }
  await client.execute({
    sql: 'UPDATE users SET nickname = ?, image = ?, trade_url = ?, role = ?, updated_at = ? WHERE id = ?',
    args: [val(nickname), val(image), val(tradeUrl), role, now(), String(user.id)]
  });
  return getUser(user.id);
}

async function setBalance(userId, value) {
  const balance = Number(Number(value).toFixed(2));
  if (mode === 'memory') {
    const u = mem.users.get(String(userId));
    if (u) u.balance = balance;
    return balance;
  }
  await client.execute({
    sql: 'UPDATE users SET balance = ?, updated_at = ? WHERE id = ?',
    args: [balance, now(), String(userId)]
  });
  return balance;
}

/**
 * Atomically applies a delta and writes a ledger row.
 * Returns the new balance, or null if the user does not exist.
 * Pass `minBalance` to make the debit conditional (prevents overspending).
 */
async function addBalance(userId, delta, type, meta, minBalance) {
  const uid = String(userId);
  const amount = Number(delta || 0);

  if (mode === 'memory') {
    const u = mem.users.get(uid);
    if (!u) return null;
    if (minBalance != null && u.balance < minBalance) return null;
    u.balance = Number((u.balance + amount).toFixed(2));
    mem.transactions.push({ user_id: uid, type, delta: amount, balance_after: u.balance, meta, created_at: now() });
    return u.balance;
  }

  // Single conditional statement: the WHERE guard is evaluated on the value
  // before the update, so the debit cannot go through on an insufficient balance.
  const guard = minBalance != null ? ' AND balance >= ?' : '';
  const res = await client.execute({
    sql: `UPDATE users SET balance = ROUND(balance + ?, 2), updated_at = ? WHERE id = ?${guard} RETURNING balance`,
    args: minBalance != null
      ? [amount, now(), uid, Number(minBalance)]
      : [amount, now(), uid]
  });
  if (!res.rows.length) return null;

  const balance = Number(res.rows[0].balance);
  await client.execute({
    sql: `INSERT INTO transactions (user_id, type, delta, balance_after, meta, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [uid, String(type), amount, balance, meta ? JSON.stringify(meta) : null, now()]
  });
  return balance;
}

async function listTransactions(userId, limit = 20, offset = 0) {
  if (mode === 'memory') {
    return mem.transactions
      .filter((t) => t.user_id === String(userId))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(offset, offset + limit);
  }
  const res = await client.execute({
    sql: 'SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
    args: [String(userId), Number(limit), Number(offset)]
  });
  return res.rows;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------
function rowToEntry(row) {
  let item;
  try {
    item = JSON.parse(row.item_json);
  } catch (e) {
    item = { id: row.id, marketName: row.market_name, price: row.price, image: row.image };
  }
  return {
    id: row.id,
    price: Number(row.price),
    status: row.status,
    canSell: !!row.can_sell,
    canUpgrade: !!row.can_upgrade,
    source: row.source || 'case',
    item,
    createdAt: row.created_at
  };
}

async function listInventory(userId, { limit = 28, offset = 0, status } = {}) {
  if (mode === 'memory') {
    let list = (mem.inventory.get(String(userId)) || []).slice();
    if (status) list = list.filter((e) => e.status === status);
    return list.slice(offset, offset + limit);
  }
  const sql = status
    ? 'SELECT * FROM inventory_items WHERE user_id = ? AND status = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?'
    : 'SELECT * FROM inventory_items WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?';
  const args = status
    ? [String(userId), status, Number(limit), Number(offset)]
    : [String(userId), Number(limit), Number(offset)];
  const res = await client.execute({ sql, args });
  return res.rows.map(rowToEntry);
}

async function countInventory(userId, status) {
  if (mode === 'memory') {
    let list = mem.inventory.get(String(userId)) || [];
    if (status) list = list.filter((e) => e.status === status);
    return list.length;
  }
  const res = status
    ? await client.execute({ sql: 'SELECT COUNT(*) AS c FROM inventory_items WHERE user_id = ? AND status = ?', args: [String(userId), status] })
    : await client.execute({ sql: 'SELECT COUNT(*) AS c FROM inventory_items WHERE user_id = ?', args: [String(userId)] });
  return Number(res.rows[0].c);
}

async function getInventoryEntry(userId, id) {
  if (mode === 'memory') {
    return (mem.inventory.get(String(userId)) || []).find((e) => String(e.id) === String(id)) || null;
  }
  const res = await client.execute({
    sql: 'SELECT * FROM inventory_items WHERE user_id = ? AND id = ?',
    args: [String(userId), String(id)]
  });
  return res.rows.length ? rowToEntry(res.rows[0]) : null;
}

async function addInventoryItem(userId, entry) {
  const record = {
    id: String(entry.id || newId('inv')),
    price: Number(entry.price) || 0,
    status: entry.status || 'available',
    canSell: entry.canSell !== false,
    canUpgrade: entry.canUpgrade !== false,
    // case | upgrade | giveaway. Withdrawal checks this.
    source: entry.source || 'case',
    item: entry.item || {},
    createdAt: entry.createdAt || now()
  };

  if (mode === 'memory') {
    const list = mem.inventory.get(String(userId)) || [];
    list.unshift(record);
    mem.inventory.set(String(userId), list);
    return record;
  }

  await client.execute({
    sql: `INSERT OR REPLACE INTO inventory_items
          (id, user_id, market_name, image, price, status, can_sell, can_upgrade, item_json, source, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      record.id,
      String(userId),
      val(record.item.marketName),
      val(record.item.image),
      record.price,
      record.status,
      record.canSell ? 1 : 0,
      record.canUpgrade ? 1 : 0,
      JSON.stringify(record.item),
      record.source,
      record.createdAt
    ]
  });
  return record;
}

/** Removes entries by id and returns how many rows were actually deleted. */
async function removeInventoryItems(userId, ids) {
  const wanted = (ids || []).map(String).filter(Boolean);
  if (!wanted.length) return 0;

  if (mode === 'memory') {
    const list = mem.inventory.get(String(userId)) || [];
    const set = new Set(wanted);
    const kept = list.filter((e) => !set.has(String(e.id)));
    mem.inventory.set(String(userId), kept);
    return list.length - kept.length;
  }

  // Only touch rows that actually belong to this user, then delete them.
  const existing = await client.batch(
    wanted.map((id) => ({ sql: 'SELECT 1 FROM inventory_items WHERE user_id = ? AND id = ?', args: [String(userId), id] })),
    'read'
  );
  const found = existing.filter((r) => r.rows.length > 0).map((r) => r.rows[0]);

  if (!found.length) return 0;

  await client.batch(
    wanted.map((id) => ({ sql: 'DELETE FROM inventory_items WHERE user_id = ? AND id = ?', args: [String(userId), id] })),
    'write'
  );
  return wanted.length;
}

async function setInventoryStatus(userId, ids, status) {
  const wanted = (ids || []).map(String).filter(Boolean);
  if (!wanted.length) return 0;
  if (mode === 'memory') {
    const list = mem.inventory.get(String(userId)) || [];
    let n = 0;
    list.forEach((e) => {
      if (wanted.includes(String(e.id))) { e.status = status; n++; }
    });
    return n;
  }
  await client.batch(
    wanted.map((id) => ({ sql: 'UPDATE inventory_items SET status = ? WHERE user_id = ? AND id = ?', args: [status, String(userId), id] })),
    'write'
  );
  return wanted.length;
}

async function totalInventoryValue(userId) {
  if (mode === 'memory') {
    const list = (mem.inventory.get(String(userId)) || []).filter((e) => e.status === 'available');
    return Number(list.reduce((acc, e) => acc + (Number(e.price) || 0), 0).toFixed(2));
  }
  const res = await client.execute({
    sql: "SELECT COALESCE(SUM(price), 0) AS s FROM inventory_items WHERE user_id = ? AND status = 'available'",
    args: [String(userId)]
  });
  return Number(Number(res.rows[0].s || 0).toFixed(2));
}

// ---------------------------------------------------------------------------
// Case opens
// ---------------------------------------------------------------------------
async function recordCaseOpen(userId, slug, cost, items) {
  if (mode === 'memory') {
    mem.opens.push({ user_id: String(userId), case_slug: slug, cost, items_json: JSON.stringify(items), created_at: now() });
    return;
  }
  await client.execute({
    sql: 'INSERT INTO case_opens (user_id, case_slug, cost, items_json, created_at) VALUES (?, ?, ?, ?, ?)',
    args: [String(userId), String(slug), Number(cost) || 0, JSON.stringify(items || []), now()]
  });
}

async function countCaseOpens(userId) {
  if (mode === 'memory') return mem.opens.filter((o) => o.user_id === String(userId)).length;
  const res = await client.execute({ sql: 'SELECT COUNT(*) AS c FROM case_opens WHERE user_id = ?', args: [String(userId)] });
  return Number(res.rows[0].c);
}

// ---------------------------------------------------------------------------
// Drops and player stats (the live feed + the profile tiles)
// ---------------------------------------------------------------------------

// caser.one's own rarity palette, read from the client bundle
// (getItemRarityColorByFlatItem, chunks/2b0jyrka0h02i.js).
//
// It accepts either the numeric tier the API ships or one of these names.
// Inventing a band name is what made every feed row render grey: the lookup
// returned the default #B0C3D9 for anything it did not recognise.
const RARITY_DEFAULT = '#B0C3D9';

const RARITY_BY_NUMBER = {
  1: '#B0C3D9', 2: '#4B69FF', 3: '#8847FF', 4: '#EB4B4B', 5: '#D32CE6',
  6: '#D32CE6', 7: '#EB4B4B', 8: '#4B69FF', 9: '#8847FF', 10: '#EB4B4B',
  11: '#FFAE39', 12: '#D32CE6', 13: '#B0C3D9', 14: '#5E98D9', 15: '#4B69FF',
  16: '#8847FF'
};

const RARITY_BY_NAME = {
  common: '#B0C3D9', uncommon: '#5E98D9', rare: '#4B69FF', mythical: '#8847FF',
  legendary: '#D32CE6', ancient: '#EB4B4B', immortal: '#FFAE39'
};

/** Port of the site's getItemRarityColorByFlatItem. */
function rarityColorFor(item) {
  if (!item) return RARITY_DEFAULT;
  const marketName = String(item.marketName || '');
  const skin = String(item.skin || '');
  const type = Number(item.type);

  // Knives and M4A4 | Howl are always gold on the original.
  if (marketName.includes('★')
    || (marketName.includes('M4A4') && skin.toLowerCase() === 'howl')
    || marketName.includes('M4A4 | Howl')) return '#FFAE39';
  if (type === 13 || marketName.startsWith('Sticker')) return '#8847FF';

  const rarity = item.rarity;
  if (rarity == null || rarity === '') return RARITY_DEFAULT;
  if (/^\d+$/.test(String(rarity))) return RARITY_BY_NUMBER[Number(rarity)] || RARITY_DEFAULT;
  return RARITY_BY_NAME[String(rarity).toLowerCase()] || RARITY_DEFAULT;
}

/**
 * Records a won item. Drives three things at once: the live feed every client
 * sees, the "best drop" tile and the CS rating on the profile.
 */
async function recordDrop(userId, item, price, source = 'case') {
  const uid = String(userId);
  const id = newId('drop');
  const value = Number(price) || 0;
  // The item's OWN tier, so the site can colour the row. A price band would
  // not map onto the site's palette.
  const rarity = item && item.rarity != null && item.rarity !== '' ? String(item.rarity) : null;
  const ts = now();

  if (mode === 'memory') {
    mem.drops = mem.drops || [];
    mem.drops.unshift({
      id, user_id: uid, item_id: item && item.id ? String(item.id) : null,
      market_name: (item && item.marketName) || null,
      image: (item && item.image) || null,
      price: value, rarity, source, created_at: ts, item: item || null
    });
    if (mem.drops.length > 500) mem.drops.pop();
    await bumpStatsMemory(uid, source, value, item);
    return { id, price: value, rarity };
  }

  await client.execute({
    sql: `INSERT INTO drops (id, user_id, item_id, market_name, image, price, rarity, source, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, uid,
      item && item.id != null ? String(item.id) : null,
      item && item.marketName ? String(item.marketName) : null,
      item && item.image ? String(item.image) : null,
      value, rarity, String(source), ts
    ]
  });

  // The stats upsert is written as INSERT OR IGNORE + UPDATE rather than
  // ON CONFLICT ... DO UPDATE with `excluded.` references. The upsert form is
  // valid SQL and works on a local file, but Turso rejected it in production -
  // the drop was stored and the counters stayed at 0, because this statement
  // threw after the drops INSERT had already committed.
  await upsertStats(uid, {
    casesDelta: source === 'case' ? 1 : 0,
    upgradesDelta: source === 'upgrade' ? 1 : 0,
    upgradesWonDelta: source === 'upgrade' ? 1 : 0,
    bestDrop: value,
    bestDropName: (item && item.marketName) || null,
    bestDropImage: (item && item.image) || null,
    // The profile tints the best-drop frame with this; without it the tile
    // always fell back to the default grey.
    bestDropRarity: (item && item.rarity != null && item.rarity !== '')
      ? String(item.rarity)
      : null
  });

  return { id, price: value, rarity };
}

/**
 * Creates the stats row if needed, then applies the deltas with plain SQL.
 * Splitting it this way keeps every statement portable and makes the running
 * maximum explicit in JS rather than in a CASE expression.
 */
async function upsertStats(uid, delta) {
  const cases = delta.casesDelta || 0;
  const upgrades = delta.upgradesDelta || 0;
  const won = delta.upgradesWonDelta || 0;
  const rating = delta.ratingDelta || 0;

  await client.execute('INSERT OR IGNORE INTO player_stats (user_id) VALUES (?)', [uid]);

  // best_drop only ever moves up.
  if (delta.bestDrop != null && delta.bestDrop > 0) {
    const current = await client.execute({
      sql: 'SELECT best_drop FROM player_stats WHERE user_id = ?', args: [uid]
    });
    const held = current.rows.length ? Number(current.rows[0].best_drop) || 0 : 0;
    if (delta.bestDrop > held) {
      await client.execute({
        sql: `UPDATE player_stats
              SET cases_opened = cases_opened + ?,
                  upgrades_made = upgrades_made + ?,
                  upgrades_won = upgrades_won + ?,
                  rating = rating + ?,
                  best_drop = ?, best_drop_name = ?, best_drop_img = ?,
                  best_drop_rarity = ?
              WHERE user_id = ?`,
        args: [cases, upgrades, won, rating, delta.bestDrop, val(delta.bestDropName),
          val(delta.bestDropImage), val(delta.bestDropRarity), uid]
      });
      return;
    }
  }

  await client.execute({
    sql: `UPDATE player_stats
          SET cases_opened = cases_opened + ?,
              upgrades_made = upgrades_made + ?,
              upgrades_won = upgrades_won + ?,
              rating = rating + ?
          WHERE user_id = ?`,
    args: [cases, upgrades, won, rating, uid]
  });
}

async function bumpStatsMemory(uid, source, value, item) {
  mem.stats = mem.stats || new Map();
  const s = mem.stats.get(uid) || {
    cases_opened: 0, upgrades_made: 0, upgrades_won: 0,
    best_drop: 0, best_drop_name: null, best_drop_img: null, rating: 0
  };
  if (source === 'case') s.cases_opened += 1;
  else if (source === 'upgrade') { s.upgrades_made += 1; s.upgrades_won += 1; }
  if (value > s.best_drop) {
    s.best_drop = value;
    s.best_drop_name = (item && item.marketName) || null;
    s.best_drop_img = (item && item.image) || null;
    s.best_drop_rarity = (item && item.rarity != null) ? String(item.rarity) : null;
  }
  mem.stats.set(uid, s);
}

/**
 * Counts an upgrade attempt and moves the CS rating.
 *
 * The rating is outcome-minus-expectation: at RTP 0.8 a win is worth +0.2 and
 * a loss -0.8, so a player who breaks even converges on 0.000 and a player who
 * does well climbs. A fresh account is 0.000, which is what the reference
 * screen shows.
 */
async function recordUpgradeAttempt(userId, won, expected = 0.8) {
  const uid = String(userId);
  const delta = won ? 1 - expected : -expected;

  if (mode === 'memory') {
    mem.stats = mem.stats || new Map();
    const s = mem.stats.get(uid) || {
      cases_opened: 0, upgrades_made: 0, upgrades_won: 0,
      best_drop: 0, best_drop_name: null, best_drop_img: null, rating: 0
    };
    s.upgrades_made += 1;
    if (won) s.upgrades_won += 1;
    s.rating += delta;
    mem.stats.set(uid, s);
    return;
  }

  await upsertStats(uid, {
    upgradesDelta: 1,
    upgradesWonDelta: won ? 1 : 0,
    ratingDelta: delta
  });
}

/** The newest real drops, joined with the player who won them. */
async function listRecentDrops(limit = 40) {
  const n = Math.min(200, Math.max(1, parseInt(limit, 10) || 40));
  if (mode === 'memory') {
    const list = (mem.drops || []).slice(0, n);
    return list.map((d) => decorateDrop(d));
  }
  const res = await client.execute({
    sql: `SELECT d.*, u.nickname, u.image AS user_image
          FROM drops d LEFT JOIN users u ON u.id = d.user_id
          ORDER BY d.created_at DESC, d.rowid DESC LIMIT ?`,
    args: [n]
  });
  return res.rows.map((r) => decorateDrop({
    id: r.id, user_id: r.user_id, item_id: r.item_id, market_name: r.market_name,
    image: r.image, price: r.price, rarity: r.rarity, source: r.source,
    created_at: r.created_at, nickname: r.nickname, user_image: r.user_image
  }));
}

function decorateDrop(d) {
  const item = {
    id: d.item_id,
    marketName: d.market_name,
    price: d.price,
    image: d.image,
    // The raw tier the site expects, plus the colour it resolves to, so a
    // consumer that does not run the site's own palette still renders right.
    rarity: d.rarity != null ? d.rarity : undefined,
    color: rarityColorFor(d.item || { marketName: d.market_name, rarity: d.rarity }),
    source: d.source
  };
  return {
    id: d.id,
    item,
    user: {
      id: d.user_id,
      nickname: d.nickname || 'Игрок',
      image: d.user_image || null
    },
    createdAt: d.created_at
  };
}

/**
 * Everything the profile header needs in one round trip.
 * `withdrawn` comes from completed withdrawals, which is the honest number to
 * show next to "Выведено".
 */
async function playerStats(userId) {
  const uid = String(userId);
  const empty = {
    casesOpened: 0, upgradesMade: 0, upgradesWon: 0,
    bestDrop: 0, bestDropName: null, bestDropImage: null, bestDropRarity: null,
    rating: 0, withdrawn: 0, withdrawnItems: 0,
    inventoryValue: 0, inventoryCount: 0
  };

  if (mode === 'memory') {
    const s = mem.stats && mem.stats.get(uid);
    const inv = mem.inventory.get(uid) || [];
    const done = mem.withdrawals.filter((w) => w.user_id === uid && w.status === 'completed');
    return {
      ...empty,
      casesOpened: s ? s.cases_opened : 0,
      upgradesMade: s ? s.upgrades_made : 0,
      upgradesWon: s ? s.upgrades_won : 0,
      bestDrop: s ? s.best_drop : 0,
      bestDropName: s ? s.best_drop_name : null,
      bestDropImage: s ? s.best_drop_img : null,
      bestDropRarity: s ? s.best_drop_rarity : null,
      rating: s ? s.rating : 0,
      withdrawn: done.reduce((a, w) => a + (Number(w.price) || 0), 0),
      withdrawnItems: done.length,
      inventoryCount: inv.length,
      inventoryValue: inv.reduce((a, e) => a + (Number(e.price) || 0), 0)
    };
  }

  const res = await client.execute({ sql: 'SELECT * FROM player_stats WHERE user_id = ?', args: [uid] });
  const s = res.rows.length ? res.rows[0] : null;

  const wd = await client.execute({
    sql: `SELECT COUNT(*) AS c, COALESCE(SUM(price), 0) AS total
          FROM withdrawals WHERE user_id = ? AND status = 'completed'`,
    args: [uid]
  });
  const inv = await client.execute({
    sql: 'SELECT COUNT(*) AS c, COALESCE(SUM(price), 0) AS total FROM inventory_items WHERE user_id = ?',
    args: [uid]
  });

  return {
    casesOpened: s ? Number(s.cases_opened) : 0,
    upgradesMade: s ? Number(s.upgrades_made) : 0,
    upgradesWon: s ? Number(s.upgrades_won) : 0,
    bestDrop: s ? Number(s.best_drop) : 0,
    bestDropName: s ? s.best_drop_name : null,
    bestDropImage: s ? s.best_drop_img : null,
    bestDropRarity: s ? s.best_drop_rarity : null,
    rating: s ? Number(s.rating) : 0,
    withdrawn: Number(wd.rows[0].total) || 0,
    withdrawnItems: Number(wd.rows[0].c) || 0,
    inventoryCount: Number(inv.rows[0].c) || 0,
    inventoryValue: Number(inv.rows[0].total) || 0
  };
}

/**
 * Writes a ledger row WITHOUT touching the balance.
 *
 * Needed when the balance was already changed elsewhere (setBalance, a
 * correction) and you only want the history to explain it. Calling addBalance
 * for this would apply the delta a second time and double the balance.
 */
async function recordTransaction(userId, type, delta, meta, balanceAfter) {
  const uid = String(userId);
  const amount = Number(delta) || 0;

  if (mode === 'memory') {
    const u = mem.users.get(uid);
    const after = balanceAfter != null ? Number(balanceAfter) : (u ? u.balance : 0);
    mem.transactions.push({ user_id: uid, type, delta: amount, balance_after: after, meta, created_at: now() });
    return after;
  }

  let after = balanceAfter;
  if (after == null) {
    const row = await client.execute({ sql: 'SELECT balance FROM users WHERE id = ?', args: [uid] });
    if (!row.rows.length) return null;
    after = Number(row.rows[0].balance);
  }
  await client.execute({
    sql: `INSERT INTO transactions (user_id, type, delta, balance_after, meta, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [uid, String(type), amount, after, meta ? JSON.stringify(meta) : null, now()]
  });
  return after;
}

/**
 * Grants or revokes the content-creator tick.
 * Mirrored into `role` so any client that only looks at the role still sees it.
 */
async function setCreator(userId, isCreator) {
  const uid = String(userId);
  const flag = isCreator ? 1 : 0;
  const existing = await getUser(uid);
  if (!existing) return { error: 'User not found' };
  const role = flag ? 'creator' : (existing.role === 'creator' ? 'user' : existing.role);

  if (mode === 'memory') {
    const u = mem.users.get(uid);
    if (u) { u.isCreator = !!flag; u.role = role; }
    return { user: { ...u } };
  }
  await client.execute({
    sql: 'UPDATE users SET is_creator = ?, role = ?, updated_at = ? WHERE id = ?',
    args: [flag, role, now(), uid]
  });
  return { user: await getUser(uid) };
}

// ---------------------------------------------------------------------------
// Promo codes
// ---------------------------------------------------------------------------

const normaliseCode = (code) => String(code || '').trim().toUpperCase();

function rowToPromo(r) {
  if (!r) return null;
  return {
    id: r.id,
    code: r.code,
    amount: Number(r.amount),
    maxActivations: Number(r.max_activations),
    activations: Number(r.activations),
    isActive: !!r.is_active,
    createdBy: r.created_by,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    remaining: Math.max(0, Number(r.max_activations) - Number(r.activations))
  };
}

async function createPromoCode({ code, amount, maxActivations = 1, expiresAt = null, createdBy = null }) {
  const clean = normaliseCode(code);
  if (!/^[A-Z0-9_-]{3,32}$/.test(clean)) {
    return { error: 'Code must be 3-32 characters: A-Z, 0-9, dash or underscore' };
  }
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_BALANCE_ALLOWED) {
    return { error: 'Invalid amount' };
  }
  const max = parseInt(maxActivations, 10);
  if (!Number.isFinite(max) || max < 1) return { error: 'Invalid activation limit' };

  const id = newId('promo');

  if (mode === 'memory') {
    if (mem.promos.some((p) => p.code === clean)) return { error: 'Такой промокод уже есть' };
    const record = {
      id, code: clean, amount: value, max_activations: max, activations: 0,
      is_active: 1, created_by: createdBy, expires_at: expiresAt, created_at: now()
    };
    mem.promos.push(record);
    mem.promoRedemptions = mem.promoRedemptions || [];
    return { promo: rowToPromo(record) };
  }

  try {
    await client.execute({
      sql: `INSERT INTO promo_codes (id, code, amount, max_activations, activations, is_active, created_by, expires_at, created_at)
            VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?)`,
      args: [id, clean, value, max, createdBy, expiresAt, now()]
    });
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) return { error: 'Такой промокод уже есть' };
    throw e;
  }
  return { promo: await getPromoCode(clean) };
}

async function getPromoCode(code) {
  const clean = normaliseCode(code);
  if (!clean) return null;
  if (mode === 'memory') return rowToPromo(mem.promos.find((p) => p.code === clean));
  const res = await client.execute({ sql: 'SELECT * FROM promo_codes WHERE code = ?', args: [clean] });
  return res.rows.length ? rowToPromo(res.rows[0]) : null;
}

/** Switches a code on or off without touching its redemption history. */
async function setPromoActive(code, isActive) {
  const clean = normaliseCode(code);
  const flag = isActive ? 1 : 0;
  if (mode === 'memory') {
    const promo = mem.promos.find((p) => p.code === clean);
    if (!promo) return { error: 'Промокод не найден' };
    promo.is_active = flag;
    return { promo: rowToPromo(promo) };
  }
  const res = await client.execute({
    sql: 'UPDATE promo_codes SET is_active = ? WHERE code = ?',
    args: [flag, clean]
  });
  if (!res.rowsAffected) return { error: 'Промокод не найден' };
  return { promo: await getPromoCode(clean) };
}

async function listPromoCodes({ limit = 50, offset = 0 } = {}) {
  const n = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const o = Math.max(0, parseInt(offset, 10) || 0);
  if (mode === 'memory') {
    return mem.promos.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(o, o + n).map(rowToPromo);
  }
  const res = await client.execute({
    sql: 'SELECT * FROM promo_codes ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?',
    args: [n, o]
  });
  return res.rows.map(rowToPromo);
}

/**
 * Redeems a code and credits the balance, exactly once per account.
 *
 * The activation counter is bumped with a conditional UPDATE that also checks
 * the limit, the expiry and the active flag. That single statement is what
 * makes "any number of activations" safe under concurrent clicks - the loser
 * gets 0 rows affected and is rejected, so the code can never pay out more
 * times than it is allowed to. The per-user UNIQUE index is the second guard,
 * so one account can never take the same code twice.
 */
async function redeemPromoCode(code, userId) {
  const clean = normaliseCode(code);
  const uid = String(userId);
  if (!clean) return { error: 'Введите промокод' };

  const memoRedeemed = (promo, amount) => {
    mem.promoRedemptions = mem.promoRedemptions || [];
    mem.promoRedemptions.push({ user_id: uid, code: clean, amount, created_at: now() });
  };

  if (mode === 'memory') {
    const promo = mem.promos.find((p) => p.code === clean);
    if (!promo) return { error: 'Такого промокода не существует' };
    if (!promo.is_active) return { error: 'Промокод больше не активен' };
    if (promo.expires_at && new Date(promo.expires_at).getTime() < Date.now()) {
      return { error: 'Срок действия промокода истёк' };
    }
    if (promo.activations >= promo.max_activations) return { error: 'Промокод больше не активируется' };
    if (memo.promoRedemptions.some((r) => r.user_id === uid && r.code === clean)) {
      return { error: 'Вы уже использовали этот промокод' };
    }
    const amount = Number(promo.amount);
    promo.activations += 1;
    memoRedeemed(promo, amount);
    return { promo: rowToPromo(promo), amount, userId: uid };
  }

  const bumped = await client.execute({
    sql: `UPDATE promo_codes
          SET activations = activations + 1
          WHERE code = ?
            AND is_active = 1
            AND activations < max_activations
            AND (expires_at IS NULL OR expires_at > ?)`,
    args: [clean, now()]
  });
  if (!bumped.rowsAffected) {
    // Distinguish "does not exist" from "used up" so the player gets a useful
    // message instead of a generic failure.
    const promo = await getPromoCode(clean);
    if (!promo) return { error: 'Такого промокода не существует' };
    if (!promo.isActive) return { error: 'Промокод больше не активен' };
    if (promo.expiresAt && new Date(promo.expiresAt).getTime() < Date.now()) {
      return { error: 'Срок действия промокода истёк' };
    }
    return { error: 'Промокод больше не активируется' };
  }

  const promo = await getPromoCode(clean);
  const amount = promo ? Number(promo.amount) : 0;

  try {
    await client.execute({
      sql: `INSERT INTO promo_redemptions (id, code_id, code, user_id, amount, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [newId('pr'), promo ? promo.id : null, clean, uid, amount, now()]
    });
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) {
      // This account already used the code. Give the activation slot back so
      // the limit is not silently consumed by a repeat attempt.
      await client.execute({
        sql: 'UPDATE promo_codes SET activations = activations - 1 WHERE code = ? AND activations > 0',
        args: [clean]
      });
      return { error: 'Вы уже использовали этот промокод' };
    }
    throw e;
  }

  return { promo, amount, userId: uid };
}

async function listPromoRedemptions(userId, limit = 20) {
  if (mode === 'memory') {
    return (mem.promoRedemptions || [])
      .filter((r) => r.user_id === String(userId))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit);
  }
  const res = await client.execute({
    sql: 'SELECT * FROM promo_redemptions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    args: [String(userId), Math.min(100, limit)]
  });
  return res.rows.map((r) => ({
    code: r.code, amount: Number(r.amount), createdAt: r.created_at
  }));
}

/** Accounts for the admin panel, newest first. Lets the operator find the
 * player who just registered and check what their balance is.
 */
async function listUsers({ limit = 25, offset = 0, search = '' } = {}) {
  const n = Number(limit) || 25;
  const o = Number(offset) || 0;

  if (mode === 'memory') {
    let list = [...mem.users.values()];
    if (search) {
      const q = String(search).toLowerCase();
      list = list.filter((u) =>
        String(u.id).toLowerCase().includes(q) || String(u.nickname || '').toLowerCase().includes(q));
    }
    list.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    return list.slice(o, o + n).map((u) => ({ ...u, balance: Number(u.balance) || 0 }));
  }

  const where = [];
  const args = [];
  if (search) {
    where.push('(id LIKE ? OR nickname LIKE ?)');
    const like = `%${search}%`;
    args.push(like, like);
  }
  const sql = `SELECT * FROM users ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`;
  const res = await client.execute({ sql, args: [...args, n, o] });
  return res.rows.map((r) => ({
    id: r.id,
    nickname: r.nickname,
    image: r.image,
    balance: Number(r.balance) || 0,
    role: r.role,
    createdAt: r.created_at
  }));
}

/**
 * Site-wide counters, summed from what the server actually holds.
 *
 * The bundle reads these for the footer's "Всего игроков", "Открыто кейсов"
 * and "Сделано апгрейдов". They used to be hardcoded numbers (412589 / 1542380
 * / 894120) that only ever went up, which made a brand new site look like it
 * had been running for years.
 */
async function siteStats() {
  if (mode === 'memory') {
    const stats = [...mem.stats.values()];
    return {
      users: mem.users.size,
      casesOpened: stats.reduce((n, s) => n + (s.cases_opened || 0), 0),
      upgradesMade: stats.reduce((n, s) => n + (s.upgrades_made || 0), 0)
    };
  }
  const [users, totals] = await Promise.all([
    client.execute({ sql: 'SELECT COUNT(*) AS c FROM users', args: [] }),
    client.execute({
      sql: 'SELECT COALESCE(SUM(cases_opened),0) AS cases, COALESCE(SUM(upgrades_made),0) AS upgrades FROM player_stats',
      args: []
    })
  ]);
  return {
    users: Number(users.rows[0] && users.rows[0].c) || 0,
    casesOpened: Number(totals.rows[0] && totals.rows[0].cases) || 0,
    upgradesMade: Number(totals.rows[0] && totals.rows[0].upgrades) || 0
  };
}

/** Every table that points at a user and therefore has to go with it. */
const USER_OWNED_TABLES = [
  'inventory_items', 'transactions', 'case_opens', 'withdrawals',
  'notifications', 'promo_redemptions', 'drops', 'player_stats',
  'giveaway_entries', 'giveaway_winners'
];

/**
 * Removes the throwaway accounts that API probing creates.
 *
 * Hitting any endpoint with a bare `caser_user_id` cookie provisions a player,
 * so a few hundred accounts named CaserPlayer/probe/scam piled up and filled the
 * top drop, the winner list and the player counter with people who never
 * opened anything.
 *
 * Only stock nicknames are touched, and `dryRun` reports what would go without
 * deleting anything: an account that has been renamed is a real player even if
 * it never played.
 */
// Both the anonymous visitors that API probing creates and the roster
// seed-demo.js invents. The second group is what fills the top drop and the
// winner list on the deployed site.
const TEST_NICKNAMES = [
  'caserplayer', 'probe', 'scam', 'test', 'tester',
  'clipher', 's1mple_win', 'donk', 'm0nesy', 'sh1ro', 'zywoo',
  'hunter-', 'electronic', 'n0rb3r7', 'b1t', 'tolsti', 'sdy'
];

async function purgeTestUsers({ dryRun = false, nicknames, protect = [] } = {}) {
  const wanted = (nicknames || TEST_NICKNAMES).map((n) => String(n).toLowerCase());
  const keep = new Set(protect.map((id) => String(id)));

  let ids;
  if (mode === 'memory') {
    ids = [...mem.users.values()]
      .filter((u) => wanted.includes(String(u.nickname || '').toLowerCase()))
      .filter((u) => String(u.role || 'user') !== 'admin' && String(u.role || 'user') !== 'owner')
      .map((u) => String(u.id))
      .filter((id) => !keep.has(id));
    if (dryRun || !ids.length) return { deleted: 0, ids, dryRun };
    const set = new Set(ids);
    mem.drops = (mem.drops || []).filter((d) => !set.has(String(d.user_id)));
    for (const id of ids) { mem.users.delete(id); mem.stats.delete(id); }
    return { deleted: ids.length, ids, dryRun };
  }

  // Two kinds of account survive no matter what their nickname says. An
  // id_aliases row means this id replaced a real legacy slug, i.e. a browser
  // that had a session here before the renumbering - the operator's own account
  // among them. A role of admin/owner is the same argument from the other side.
  const like = wanted.map(() => 'LOWER(nickname) = ?').join(' OR ');
  const found = await client.execute({
    sql: `SELECT id FROM users
          WHERE (${like})
            AND COALESCE(role, 'user') NOT IN ('admin', 'owner')
            AND id NOT IN (SELECT new_id FROM id_aliases)`,
    args: wanted
  });
  ids = found.rows.map((r) => String(r.id)).filter((id) => !keep.has(id));
  if (dryRun || !ids.length) return { deleted: 0, ids, dryRun };

  // SQLite caps how many variables one statement may bind, and a purge is
  // routinely thousands of accounts, so the ids are deleted in chunks.
  const CHUNK = 400;
  for (let start = 0; start < ids.length; start += CHUNK) {
    const part = ids.slice(start, start + CHUNK);
    const holes = part.map(() => '?').join(',');
    const stmts = USER_OWNED_TABLES.map((table) => ({
      sql: `DELETE FROM ${table} WHERE user_id IN (${holes})`,
      args: part
    }));
    // id_aliases maps a retired id onto the one that replaced it, so it is the
    // new_id that has to go - the row is keyed by old_id.
    stmts.push({ sql: `DELETE FROM id_aliases WHERE new_id IN (${holes})`, args: part });
    stmts.push({ sql: `DELETE FROM users WHERE id IN (${holes})`, args: part });
    await client.batch(stmts, 'write');
  }
  return { deleted: ids.length, ids, dryRun };
}

/**
 * Giveaways
 * ---------------------------------------------------------------------------
 *
 * A giveaway is open until its timer expires. Anyone can enter with no
 * conditions, and when the time is up the winners are drawn at random from
 * whoever entered - so the operator does not pick them by hand.
 */
function rowToGiveaway(row) {
  if (!row) return null;
  let prize = {};
  try { prize = JSON.parse(row.prize_json || '{}'); } catch (e) { prize = {}; }
  return {
    id: row.id,
    title: row.title,
    description: row.description || null,
    prize,
    prizeName: row.prize_name || null,
    prizeImage: row.prize_image || null,
    prizeRarity: row.prize_rarity || null,
    slots: Number(row.slots) || 1,
    endsAt: row.ends_at,
    status: row.status,
    createdAt: row.created_at,
    drawnAt: row.drawn_at || null
  };
}

/**
 * Resolves a prize by its market name against the case catalogue.
 *
 * The admin panel only types a name, so the image, price and rarity have to be
 * looked up - a prize without an image renders as an empty box on the banner.
 */
async function findItemByName(marketName) {
  const wanted = String(marketName || '').trim().toLowerCase();
  if (!wanted) return null;

  const dir = path.join(__dirname, 'cases_cache');
  let files = [];
  try { files = fs.readdirSync(dir); } catch (e) { return null; }

  for (const f of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
    const hit = (d.items || []).find((i) => String(i.marketName || '').toLowerCase() === wanted);
    if (hit) return hit;
  }
  return null;
}

async function createGiveaway(data) {
  const id = String(data.id || newId('ga'));
  const record = {
    id,
    title: String(data.title || 'Розыгрыш'),
    description: data.description ? String(data.description) : null,
    prize: data.prize || {},
    prizeName: (data.prize && data.prize.marketName) || null,
    prizeImage: (data.prize && data.prize.image) || null,
    prizeRarity: (data.prize && data.prize.rarity != null) ? String(data.prize.rarity) : null,
    slots: Math.max(1, parseInt(data.slots, 10) || 1),
    endsAt: String(data.endsAt),
    status: 'active',
    createdAt: now()
  };
  if (isNaN(Date.parse(record.endsAt))) return { error: 'Некорректное время окончания' };

  if (mode === 'memory') {
    mem.giveaways = mem.giveaways || [];
    mem.giveaways.push(Object.assign({}, record, {
      entries: [], winners: [], prize_json: JSON.stringify(record.prize)
    }));
    return { giveaway: record };
  }

  await client.execute({
    sql: `INSERT INTO giveaways
          (id, title, description, prize_json, prize_name, prize_image, prize_rarity, slots, ends_at, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [record.id, record.title, val(record.description), JSON.stringify(record.prize),
      val(record.prizeName), val(record.prizeImage), val(record.prizeRarity),
      record.slots, record.endsAt, record.status, record.createdAt]
  });
  return { giveaway: record };
}

async function listGiveaways({ onlyActive = false, limit = 50 } = {}) {
  if (mode === 'memory') {
    let list = (mem.giveaways || []).map((g) => Object.assign({}, g, { prize_json: undefined }));
    if (onlyActive) list = list.filter((g) => g.status === 'active' && new Date(g.endsAt) > new Date());
    return list.slice(-limit).reverse();
  }

  const sql = onlyActive
    ? `SELECT * FROM giveaways WHERE status = 'active' AND ends_at > ?
       ORDER BY created_at DESC LIMIT ?`
    : `SELECT * FROM giveaways ORDER BY created_at DESC LIMIT ?`;
  const args = onlyActive ? [now(), limit] : [limit];
  const res = await client.execute({ sql, args });
  return res.rows.map(rowToGiveaway);
}

async function getGiveaway(id) {
  if (mode === 'memory') {
    const g = (mem.giveaways || []).filter((x) => x.id === String(id))[0];
    if (!g) return null;
    const copy = Object.assign({}, g);
    delete copy.prize_json;
    return copy;
  }
  const res = await client.execute({ sql: 'SELECT * FROM giveaways WHERE id = ?', args: [String(id)] });
  return res.rows.length ? rowToGiveaway(res.rows[0]) : null;
}

async function giveawayStats(id) {
  if (mode === 'memory') {
    const g = (mem.giveaways || []).filter((x) => x.id === String(id))[0] || {};
    return {
      entries: (g.entries || []).length,
      winners: (g.winners || []).map((w) => ({ userId: w.user_id, itemId: w.item_id, createdAt: w.created_at }))
    };
  }
  const e = await client.execute({
    sql: 'SELECT COUNT(*) AS c FROM giveaway_entries WHERE giveaway_id = ?', args: [String(id)]
  });
  const w = await client.execute({
    sql: 'SELECT * FROM giveaway_winners WHERE giveaway_id = ? ORDER BY slot', args: [String(id)]
  });
  return {
    entries: Number(e.rows[0].c) || 0,
    winners: w.rows.map((r) => ({ userId: r.user_id, itemId: r.item_id, createdAt: r.created_at }))
  };
}

/**
 * Whether an account already holds an entry in a draw.
 *
 * The client keeps a "Участвовать" button on screen unless the giveaway it
 * receives says `me.isParticipant`, so this is what stops the page from asking
 * again after the visitor navigates away and comes back.
 */
async function hasGiveawayEntry(id, userId) {
  if (!userId) return false;
  if (mode === 'memory') {
    const rec = (mem.giveaways || []).filter((x) => x.id === String(id))[0];
    return !!(rec && (rec.entries || []).includes(String(userId)));
  }
  const res = await client.execute({
    sql: 'SELECT 1 FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ? LIMIT 1',
    args: [String(id), String(userId)]
  });
  return res.rows.length > 0;
}

/**
 * The newest winners across every draw, joined with the winner and the prize.
 *
 * The "Последние победители" feed used to be a hardcoded list of fictional
 * players; this reads the real draw results instead.
 */
async function listRecentGiveawayWinners(limit = 30) {
  const n = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  if (mode === 'memory') {
    const out = [];
    for (const g of mem.giveaways || []) {
      for (const w of g.winners || []) {
        out.push({
          giveawayId: g.id,
          userId: w.user_id,
          slot: w.slot,
          createdAt: w.created_at,
          nickname: null,
          userImage: null,
          prize: g.prize || {}
        });
      }
    }
    return out.slice(0, n);
  }
  const res = await client.execute({
    sql: `SELECT w.giveaway_id, w.user_id, w.slot, w.created_at,
                 u.nickname, u.image AS user_image, g.prize_json
          FROM giveaway_winners w
          LEFT JOIN users u ON u.id = w.user_id
          LEFT JOIN giveaways g ON g.id = w.giveaway_id
          ORDER BY w.created_at DESC, w.rowid DESC
          LIMIT ?`,
    args: [n]
  });
  return res.rows.map((r) => ({
    giveawayId: r.giveaway_id,
    userId: r.user_id,
    slot: r.slot,
    createdAt: r.created_at,
    nickname: r.nickname,
    userImage: r.user_image,
    prize: (() => { try { return JSON.parse(r.prize_json || '{}'); } catch (e) { return {}; } })()
  }));
}

/** One entry per account; a repeat press is a no-op, not an error. */
async function enterGiveaway(id, userId) {
  const g = await getGiveaway(id);
  if (!g) return { error: 'Розыгрыш не найден' };
  if (g.status !== 'active') return { error: 'Розыгрыш уже завершён' };
  if (new Date(g.endsAt) <= new Date()) return { error: 'Розыгрыш уже завершён' };

  if (mode === 'memory') {
    const rec = (mem.giveaways || []).filter((x) => x.id === String(id))[0];
    rec.entries = rec.entries || [];
    if (!rec.entries.includes(String(userId))) rec.entries.push(String(userId));
    return { giveaway: g, entered: true };
  }

  const res = await client.execute({
    sql: 'INSERT OR IGNORE INTO giveaway_entries (giveaway_id, user_id, created_at) VALUES (?, ?, ?)',
    args: [String(id), String(userId), now()]
  });
  return { giveaway: g, entered: res.rowsAffected > 0 };
}

/**
 * Draws the winners once the timer is up and puts the prize in their inventory.
 *
 * Returns { winners: [] } when the giveaway is already drawn or nobody entered.
 * The item is stamped source='giveaway' so it is the only kind that can be
 * withdrawn.
 *
 * `force` lets the operator settle a draw before the timer runs out; without it
 * only an expired giveaway may be drawn, which is what the sweeper relies on.
 */
async function drawGiveaway(id, { force = false } = {}) {
  const g = await getGiveaway(id);
  if (!g) return { error: 'Розыгрыш не найден' };
  if (g.status !== 'active') return { error: 'Розыгрыш уже разыгран', winners: [] };
  if (!force && new Date(g.endsAt) > new Date()) return { error: 'Розыгрыш ещё не завершён', winners: [] };

  let entrants;
  if (mode === 'memory') {
    const rec = (mem.giveaways || []).filter((x) => x.id === String(id))[0];
    entrants = (rec.entries || []).slice();
  } else {
    const res = await client.execute({
      sql: 'SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?', args: [String(id)]
    });
    entrants = res.rows.map((r) => String(r.user_id));
  }

  if (!entrants.length) {
    await markGiveawayDrawn(id, []);
    return { winners: [], entries: 0 };
  }

  // Fisher-Yates, then take as many as there are slots.
  const pool = entrants.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const winners = pool.slice(0, Math.min(g.slots, pool.length));

  const granted = [];
  for (let i = 0; i < winners.length; i++) {
    const uid = winners[i];
    const inv = await addInventoryItem(uid, {
      price: (g.prize && g.prize.price) || 0,
      source: 'giveaway',
      item: g.prize || {}
    });
    granted.push({ userId: uid, slot: i + 1, itemId: inv.id });
  }

  await markGiveawayDrawn(id, granted);
  return { winners: granted, entries: entrants.length };
}

async function markGiveawayDrawn(id, winners) {
  const ts = now();
  if (mode === 'memory') {
    const rec = (mem.giveaways || []).filter((x) => x.id === String(id))[0];
    if (rec) {
      rec.status = 'finished';
      rec.drawn_at = ts;
      rec.winners = (winners || []).map((w) => ({
        user_id: w.userId, slot: w.slot, item_id: w.itemId, created_at: ts
      }));
    }
    return;
  }

  const stmts = [{ sql: "UPDATE giveaways SET status = 'finished', drawn_at = ? WHERE id = ?", args: [ts, String(id)] }];
  for (const w of winners || []) {
    stmts.push({
      sql: 'INSERT OR IGNORE INTO giveaway_winners (giveaway_id, user_id, slot, item_id, created_at) VALUES (?, ?, ?, ?, ?)',
      args: [String(id), String(w.userId), w.slot, val(w.itemId), ts]
    });
  }
  await client.batch(stmts, 'write');
}

/** Every giveaway whose timer has expired and that still needs drawing. */
async function dueGiveaways() {
  const list = await listGiveaways({ onlyActive: true, limit: 200 });
  return list.filter((g) => new Date(g.endsAt) <= new Date());
}

// ---------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------
const WITHDRAWAL_STATUS = {
  pending: 'pending',
  ready: 'ready',
  completed: 'completed',
  failed: 'failed'
};

/**
 * Legal status transitions.
 *
 * The important one is that `pending` cannot jump straight to `completed`:
 * completing removes the item from the player's inventory, so doing it without
 * a trade offer in between would destroy a skin that was never handed over.
 */
const WITHDRAWAL_TRANSITIONS = {
  pending: ['ready', 'failed'],
  ready: ['completed', 'failed'],
  completed: [],
  failed: []
};

function canTransition(from, to) {
  const allowed = WITHDRAWAL_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/** Maps a `withdrawals` row (snake_case, from either backend) to the API shape. */
function rowToWithdrawal(r) {
  if (!r) return null;
  return {
    id: r.id,
    userId: r.user_id !== undefined ? r.user_id : r.userId,
    inventoryItemId: r.inventory_item_id !== undefined ? r.inventory_item_id : r.inventoryItemId,
    marketName: r.market_name !== undefined ? r.market_name : r.marketName,
    price: Number(r.price) || 0,
    status: r.status,
    tradeOfferUrl: r.trade_offer_url !== undefined ? r.trade_offer_url : r.tradeOfferUrl,
    createdAt: r.created_at !== undefined ? r.created_at : r.createdAt,
    updatedAt: r.updated_at !== undefined ? r.updated_at : r.updatedAt
  };
}

/**
 * Locks the item and opens a withdrawal request.
 * Returns { withdrawal } or { error } when the item is not withdrawable.
 *
 * Right now only items won in a giveaway may be withdrawn. Anything from a case
 * or an upgrade stays in the inventory, so the check is on the item's source
 * rather than on a flag the caller could set.
 */
const WITHDRAWABLE_SOURCES = new Set(['giveaway']);

async function createWithdrawal(userId, inventoryItemId) {
  const uid = String(userId);
  const entry = await getInventoryEntry(uid, inventoryItemId);
  if (!entry) return { error: 'Предмет не найден' };
  if (entry.status !== 'available') return { error: 'Предмет недоступен' };
  if (!WITHDRAWABLE_SOURCES.has(entry.source)) {
    return { error: 'Вывод доступен только для предметов из розыгрыша' };
  }

  const id = newId('wd');
  const ts = now();

  if (mode === 'memory') {
    entry.status = 'locked_for_withdrawal';
    const record = {
      id, user_id: uid, inventory_item_id: entry.id, market_name: entry.item.marketName,
      price: entry.price, status: 'pending', trade_offer_url: null, created_at: ts, updated_at: ts
    };
    mem.withdrawals.push(record);
    return { withdrawal: rowToWithdrawal(record) };
  }

  const ok = await dbTransaction(async (tx) => {
    // The `status = 'available'` guard is what makes double submits impossible:
    // the second attempt updates 0 rows and never reaches the INSERT.
    const locked = await tx.execute({
      sql: "UPDATE inventory_items SET status = 'locked_for_withdrawal' WHERE user_id = ? AND id = ? AND status = 'available'",
      args: [uid, String(inventoryItemId)]
    });
    if (!locked.rowsAffected) return false;

    await tx.execute({
      sql: `INSERT INTO withdrawals (id, user_id, inventory_item_id, market_name, price, status, trade_offer_url, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
      args: [id, uid, String(inventoryItemId), val(entry.item.marketName), Number(entry.price) || 0, ts, ts]
    });
    return true;
  });

  if (!ok) return { error: 'Предмет недоступен' };

  return { withdrawal: await getWithdrawal(id) };
}

async function getWithdrawal(id) {
  if (mode === 'memory') return rowToWithdrawal(mem.withdrawals.find((w) => w.id === String(id)));
  const res = await client.execute({ sql: 'SELECT * FROM withdrawals WHERE id = ?', args: [String(id)] });
  return res.rows.length ? rowToWithdrawal(res.rows[0]) : null;
}

async function listWithdrawals({ userId, status, limit = 50, offset = 0 } = {}) {
  if (mode === 'memory') {
    let list = mem.withdrawals.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    if (userId) list = list.filter((w) => w.user_id === String(userId));
    if (status) list = list.filter((w) => w.status === status);
    return list.slice(offset, offset + limit).map(rowToWithdrawal);
  }

  const where = [];
  const args = [];
  if (userId) { where.push('user_id = ?'); args.push(String(userId)); }
  if (status) { where.push('status = ?'); args.push(status); }
  const sql = `SELECT * FROM withdrawals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`;
  const res = await client.execute({ sql, args: [...args, Number(limit), Number(offset)] });
  return res.rows.map(rowToWithdrawal);
}

/**
 * Moves a withdrawal forward and keeps the inventory item in sync.
 *   ready     -> item becomes 'trade_ready', stores the trade offer URL
 *   completed -> item leaves the inventory (handed over to the player)
 *   failed    -> item is unlocked back to 'available'
 */
async function setWithdrawalStatus(id, status, extra = {}) {
  const key = String(id);
  if (!Object.prototype.hasOwnProperty.call(WITHDRAWAL_STATUS, status)) return { error: 'Unknown status' };

  const w = await getWithdrawal(key);
  if (!w) return { error: 'Withdrawal not found' };
  if (!canTransition(w.status, status)) {
    return { error: `Cannot go from ${w.status} to ${status}` };
  }

  if (mode === 'memory') {
    const record = mem.withdrawals.find((r) => r.id === key);
    record.status = status;
    record.updated_at = now();
    if (status === 'ready') {
      record.trade_offer_url = extra.tradeOfferUrl || null;
      const list = mem.inventory.get(w.userId) || [];
      const entry = list.find((e) => String(e.id) === String(w.inventoryItemId));
      if (entry) { entry.status = 'trade_ready'; entry.tradeOfferUrl = record.trade_offer_url; }
    } else if (status === 'completed') {
      const list = mem.inventory.get(w.userId) || [];
      mem.inventory.set(w.userId, list.filter((e) => String(e.id) !== String(w.inventoryItemId)));
    } else if (status === 'failed') {
      const list = mem.inventory.get(w.userId) || [];
      const entry = list.find((e) => String(e.id) === String(w.inventoryItemId));
      if (entry) { entry.status = 'available'; entry.tradeOfferUrl = null; }
    }
    return { withdrawal: rowToWithdrawal(record) };
  }

  const ts = now();
  // NOTE: every statement goes through `tx`. Calling client.execute() from in
  // here would need a second connection while the write transaction holds the
  // only one, which fails with SQLITE_BUSY / TRANSACTION_ACTIVE.
  await dbTransaction(async (tx) => {
    if (status === 'ready') {
      await tx.execute({
        sql: "UPDATE inventory_items SET status = 'trade_ready' WHERE user_id = ? AND id = ?",
        args: [w.userId, w.inventoryItemId]
      });
      await tx.execute({
        sql: 'UPDATE withdrawals SET status = ?, trade_offer_url = ?, updated_at = ? WHERE id = ?',
        args: ['ready', val(extra.tradeOfferUrl), ts, key]
      });
    } else if (status === 'completed') {
      // The item leaves the inventory for good: it now belongs to the player.
      await tx.execute({
        sql: 'DELETE FROM inventory_items WHERE user_id = ? AND id = ?',
        args: [w.userId, w.inventoryItemId]
      });
      await tx.execute({
        sql: 'UPDATE withdrawals SET status = ?, updated_at = ? WHERE id = ?',
        args: ['completed', ts, key]
      });
    } else if (status === 'failed') {
      // Unlock it so the player can retry or sell it.
      await tx.execute({
        sql: "UPDATE inventory_items SET status = 'available' WHERE user_id = ? AND id = ?",
        args: [w.userId, w.inventoryItemId]
      });
      await tx.execute({
        sql: 'UPDATE withdrawals SET status = ?, updated_at = ? WHERE id = ?',
        args: ['failed', ts, key]
      });
    }
  });

  return { withdrawal: await getWithdrawal(key) };
}

// ---------------------------------------------------------------------------
// Notifications (the header bell + withdrawal lifecycle)
// ---------------------------------------------------------------------------
async function createNotification(userId, type, content) {
  const id = newId('ntf');
  const ts = now();
  if (mode === 'memory') {
    mem.notifications.push({ id, user_id: String(userId), type, content: JSON.stringify(content), is_read: 0, created_at: ts });
    return id;
  }
  await client.execute({
    sql: 'INSERT INTO notifications (id, user_id, type, content, is_read, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    args: [id, String(userId), String(type), JSON.stringify(content), ts]
  });
  return id;
}

async function listNotifications(userId, limit = 20, offset = 0) {
  const shape = (r) => ({
    id: r.id,
    userId: r.user_id,
    type: r.type,
    content: typeof r.content === 'string' ? safeJson(r.content) : (r.content || {}),
    isRead: !!r.is_read,
    createdAt: r.created_at
  });

  if (mode === 'memory') {
    return mem.notifications
      .filter((n) => n.user_id === String(userId))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(offset, offset + limit)
      .map(shape);
  }
  const res = await client.execute({
    sql: 'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?',
    args: [String(userId), Number(limit), Number(offset)]
  });
  return res.rows.map(shape);
}

async function countUnreadNotifications(userId) {
  if (mode === 'memory') {
    return mem.notifications.filter((n) => n.user_id === String(userId) && !n.is_read).length;
  }
  const res = await client.execute({
    sql: 'SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0',
    args: [String(userId)]
  });
  return Number(res.rows[0].c) || 0;
}

async function markNotificationRead(id) {
  if (mode === 'memory') {
    const n = mem.notifications.find((n) => n.id === String(id));
    if (n) n.is_read = 1;
    return;
  }
  await client.execute({ sql: 'UPDATE notifications SET is_read = 1 WHERE id = ?', args: [String(id)] });
}

const safeJson = (raw) => {
  try { return JSON.parse(raw); } catch (e) { return {}; }
};

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------
async function stats() {
  const base = { mode, error: initError };
  if (mode === 'memory') {
    return {
      ...base,
      users: mem.users.size,
      inventory: [...mem.inventory.values()].reduce((a, l) => a + l.length, 0),
      transactions: mem.transactions.length
    };
  }
  try {
    const [u, i, t, o] = await client.batch([
      'SELECT COUNT(*) AS c FROM users',
      'SELECT COUNT(*) AS c FROM inventory_items',
      'SELECT COUNT(*) AS c FROM transactions',
      'SELECT COUNT(*) AS c FROM case_opens'
    ], 'read');
    return {
      ...base,
      users: Number(u.rows[0].c),
      inventory: Number(i.rows[0].c),
      transactions: Number(t.rows[0].c),
      opens: Number(o.rows[0].c)
    };
  } catch (err) {
    return { ...base, error: err.message };
  }
}

module.exports = {
  START_BALANCE,
  DATA_DIR,
  REMOTE_URL,
  newId,
  init,
  resetConnection,
  getMode: () => mode,
  getUser,
  createUser,
  ensureUser,
  setBalance,
  addBalance,
  recordTransaction,
  listUsers,
  siteStats,
  purgeTestUsers,
  setCreator,
  // Promo codes
  createPromoCode,
  getPromoCode,
  listPromoCodes,
  setPromoActive,
  redeemPromoCode,
  listPromoRedemptions,
  // Drops and stats
  recordDrop,
  recordUpgradeAttempt,
  listRecentDrops,
  playerStats,
  rarityColorFor,
  listTransactions,
  listInventory,
  countInventory,
  getInventoryEntry,
  addInventoryItem,
  removeInventoryItems,
  setInventoryStatus,
  totalInventoryValue,
  nextUserId,
  migrateLegacyUser,
  legacyAdminMatch,
  findItemByName,
  // Giveaways
  createGiveaway,
  listGiveaways,
  getGiveaway,
  giveawayStats,
  hasGiveawayEntry,
  enterGiveaway,
  drawGiveaway,
  dueGiveaways,
  listRecentGiveawayWinners,
  recordCaseOpen,
  countCaseOpens,
  // Withdrawals
  createWithdrawal,
  getWithdrawal,
  listWithdrawals,
  setWithdrawalStatus,
  WITHDRAWAL_STATUS,
  WITHDRAWAL_TRANSITIONS,
  // Notifications
  createNotification,
  listNotifications,
  countUnreadNotifications,
  markNotificationRead,
  stats
};