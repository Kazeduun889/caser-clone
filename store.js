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
  opens: []
};

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

    await migrate();
    // Fail fast on a bad connection instead of erroring on the first request
    await client.execute('SELECT 1');
    ready = true;
    console.log(`[store] ready (${mode}) -> ${isRemote ? REMOTE_URL : DATA_DIR}`);
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
    'CREATE INDEX IF NOT EXISTS idx_open_user ON case_opens(user_id, id DESC)'
  ];
  await client.batch(statements.map((sql) => ({ sql })), 'write');
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
    role: row.role
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
async function ensureUser(user) {
  return (await getUser(user.id)) || createUser(user);
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
          (id, user_id, market_name, image, price, status, can_sell, can_upgrade, item_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  listTransactions,
  listInventory,
  countInventory,
  getInventoryEntry,
  addInventoryItem,
  removeInventoryItems,
  setInventoryStatus,
  totalInventoryValue,
  recordCaseOpen,
  countCaseOpens,
  stats
};