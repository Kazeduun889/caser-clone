/**
 * Persistent storage layer (SQLite).
 *
 * Everything that used to live in a module-level variable in server.js now
 * lives in DATA_DIR/caser.db so it survives process restarts and redeploys
 * (on a persistent disk). If better-sqlite3 cannot be loaded the store
 * silently degrades to an in-memory map so the site still boots.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = process.env.DATABASE_PATH || path.join(DATA_DIR, 'caser.db');
const START_BALANCE = 2043.31;

let db = null;
let memoryOnly = false;

// ---------------------------------------------------------------------------
// In-memory fallback (used only if the sqlite driver is unavailable)
// ---------------------------------------------------------------------------
const mem = {
  users: new Map(),
  inventory: new Map(), // userId -> [entry]
  transactions: [],
  opens: []
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
function migrate(handle) {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      nickname    TEXT,
      image       TEXT,
      balance     REAL NOT NULL,
      trade_url   TEXT,
      role        TEXT NOT NULL DEFAULT 'user',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inventory_items (
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
    );
    CREATE INDEX IF NOT EXISTS idx_inv_user ON inventory_items(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS transactions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        TEXT NOT NULL,
      type           TEXT NOT NULL,
      delta          REAL NOT NULL,
      balance_after  REAL NOT NULL,
      meta           TEXT,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, id DESC);

    CREATE TABLE IF NOT EXISTS case_opens (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT NOT NULL,
      case_slug   TEXT NOT NULL,
      cost        REAL NOT NULL,
      items_json  TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_open_user ON case_opens(user_id, id DESC);
  `);
}

function init() {
  if (db) return db;
  try {
    const Database = require('better-sqlite3');
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    db = new Database(DB_FILE);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
    console.log(`[store] sqlite ready -> ${DB_FILE}`);
  } catch (err) {
    memoryOnly = true;
    console.warn(`[store] sqlite unavailable (${err.message}); falling back to memory`);
  }
  return db;
}

const now = () => new Date().toISOString();

function newId(prefix) {
  const rand = Math.floor(Math.random() * 1e9).toString(36);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
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
    balance: row.balance,
    tradeUrl: row.trade_url,
    role: row.role
  };
}

function getUser(id) {
  if (!id) return null;
  if (memoryOnly) return mem.users.get(String(id)) || null;
  return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(String(id)));
}

function createUser(user) {
  const id = String(user.id || newId('player'));
  const record = {
    id,
    nickname: user.nickname || 'CaserPlayer',
    image: user.image || null,
    balance: Number.isFinite(Number(user.balance)) ? Number(user.balance) : START_BALANCE,
    trade_url: user.tradeUrl || null,
    role: user.role || 'user'
  };
  const ts = now();

  if (memoryOnly) {
    mem.users.set(id, { ...record, tradeUrl: record.trade_url });
    return getUser(id);
  }
  db.prepare(
    `INSERT INTO users (id, nickname, image, balance, trade_url, role, created_at, updated_at)
     VALUES (@id, @nickname, @image, @balance, @trade_url, @role, @ts, @ts)
     ON CONFLICT(id) DO NOTHING`
  ).run({ ...record, ts });
  return getUser(id);
}

/** Returns the existing user or creates one with the starting balance. */
function ensureUser(user) {
  return getUser(user.id) || createUser(user);
}

function setBalance(userId, value) {
  const balance = Number(Number(value).toFixed(2));
  if (memoryOnly) {
    const u = mem.users.get(String(userId));
    if (u) u.balance = balance;
    return balance;
  }
  db.prepare('UPDATE users SET balance = ?, updated_at = ? WHERE id = ?').run(balance, now(), String(userId));
  return balance;
}

/** Atomically adds a delta to the balance and writes a ledger row. */
function addBalance(userId, delta, type, meta) {
  const user = getUser(userId);
  if (!user) return null;
  const next = Number((user.balance + Number(delta || 0)).toFixed(2));

  if (memoryOnly) {
    user.balance = next;
    mem.transactions.push({ user_id: userId, type, delta, balance_after: next, meta, created_at: now() });
    return next;
  }

  const run = db.transaction(() => {
    db.prepare('UPDATE users SET balance = ?, updated_at = ? WHERE id = ?').run(next, now(), String(userId));
    db.prepare(
      'INSERT INTO transactions (user_id, type, delta, balance_after, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(String(userId), type, Number(delta || 0), next, meta ? JSON.stringify(meta) : null, now());
  });
  run();
  return next;
}

function listTransactions(userId, limit = 20, offset = 0) {
  if (memoryOnly) {
    return mem.transactions
      .filter((t) => t.user_id === String(userId))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(offset, offset + limit);
  }
  return db
    .prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(String(userId), limit, offset);
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
    price: row.price,
    status: row.status,
    canSell: !!row.can_sell,
    canUpgrade: !!row.can_upgrade,
    item,
    createdAt: row.created_at
  };
}

function listInventory(userId, { limit = 28, offset = 0, status } = {}) {
  if (memoryOnly) {
    let list = (mem.inventory.get(String(userId)) || []).slice();
    if (status) list = list.filter((e) => e.status === status);
    return list.slice(offset, offset + limit);
  }
  const rows = status
    ? db.prepare('SELECT * FROM inventory_items WHERE user_id = ? AND status = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?').all(String(userId), status, limit, offset)
    : db.prepare('SELECT * FROM inventory_items WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?').all(String(userId), limit, offset);
  return rows.map(rowToEntry);
}

function countInventory(userId, status) {
  if (memoryOnly) {
    let list = mem.inventory.get(String(userId)) || [];
    if (status) list = list.filter((e) => e.status === status);
    return list.length;
  }
  const row = status
    ? db.prepare('SELECT COUNT(*) AS c FROM inventory_items WHERE user_id = ? AND status = ?').get(String(userId), status)
    : db.prepare('SELECT COUNT(*) AS c FROM inventory_items WHERE user_id = ?').get(String(userId));
  return row.c;
}

function getInventoryEntry(userId, id) {
  const list = listInventory(userId, { limit: 1000, offset: 0 });
  return list.find((e) => String(e.id) === String(id)) || null;
}

function addInventoryItem(userId, entry) {
  const record = {
    id: String(entry.id || newId('inv')),
    price: Number(entry.price) || 0,
    status: entry.status || 'available',
    canSell: entry.canSell !== false,
    canUpgrade: entry.canUpgrade !== false,
    item: entry.item || {},
    createdAt: entry.createdAt || now()
  };

  if (memoryOnly) {
    const list = mem.inventory.get(String(userId)) || [];
    list.unshift(record);
    mem.inventory.set(String(userId), list);
    return record;
  }
  db.prepare(
    `INSERT INTO inventory_items (id, user_id, market_name, image, price, status, can_sell, can_upgrade, item_json, created_at)
     VALUES (@id, @user_id, @market_name, @image, @price, @status, @can_sell, @can_upgrade, @item_json, @created_at)`
  ).run({
    id: record.id,
    user_id: String(userId),
    market_name: record.item.marketName || null,
    image: record.item.image || null,
    price: record.price,
    status: record.status,
    can_sell: record.canSell ? 1 : 0,
    can_upgrade: record.canUpgrade ? 1 : 0,
    item_json: JSON.stringify(record.item),
    created_at: record.createdAt
  });
  return record;
}

/** Removes entries by id and returns how many rows were actually deleted. */
function removeInventoryItems(userId, ids) {
  const wanted = new Set((ids || []).map(String));
  if (!wanted.size) return 0;

  if (memoryOnly) {
    const list = mem.inventory.get(String(userId)) || [];
    const kept = list.filter((e) => !wanted.has(String(e.id)));
    const removed = list.length - kept.length;
    mem.inventory.set(String(userId), kept);
    return removed;
  }
  const stmt = db.prepare('DELETE FROM inventory_items WHERE user_id = ? AND id = ?');
  const run = db.transaction((list) => {
    let removed = 0;
    for (const id of list) removed += stmt.run(String(userId), String(id)).changes;
    return removed;
  });
  return run([...wanted]);
}

function setInventoryStatus(userId, ids, status) {
  const wanted = (ids || []).map(String);
  if (!wanted.length) return 0;
  if (memoryOnly) {
    const list = mem.inventory.get(String(userId)) || [];
    list.forEach((e) => {
      if (wanted.includes(String(e.id))) e.status = status;
    });
    return wanted.length;
  }
  const stmt = db.prepare('UPDATE inventory_items SET status = ? WHERE user_id = ? AND id = ?');
  const run = db.transaction((list) => {
    let n = 0;
    for (const id of list) n += stmt.run(status, String(userId), id).changes;
    return n;
  });
  return run(wanted);
}

function totalInventoryValue(userId) {
  const list = listInventory(userId, { limit: 10000, status: 'available' });
  return Number(list.reduce((acc, e) => acc + (Number(e.price) || 0), 0).toFixed(2));
}

// ---------------------------------------------------------------------------
// Case opens (history / stats)
// ---------------------------------------------------------------------------
function recordCaseOpen(userId, slug, cost, items) {
  if (memoryOnly) {
    mem.opens.push({ user_id: userId, case_slug: slug, cost, items_json: JSON.stringify(items), created_at: now() });
    return;
  }
  db.prepare(
    'INSERT INTO case_opens (user_id, case_slug, cost, items_json, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(String(userId), String(slug), Number(cost) || 0, JSON.stringify(items || []), now());
}

function countCaseOpens(userId) {
  if (memoryOnly) return mem.opens.filter((o) => o.user_id === String(userId)).length;
  return db.prepare('SELECT COUNT(*) AS c FROM case_opens WHERE user_id = ?').get(String(userId)).c;
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------
function stats() {
  if (memoryOnly) {
    return {
      persistent: false,
      users: mem.users.size,
      inventory: [...mem.inventory.values()].reduce((a, l) => a + l.length, 0),
      transactions: mem.transactions.length
    };
  }
  return {
    persistent: true,
    file: DB_FILE,
    users: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
    inventory: db.prepare('SELECT COUNT(*) AS c FROM inventory_items').get().c,
    transactions: db.prepare('SELECT COUNT(*) AS c FROM transactions').get().c,
    opens: db.prepare('SELECT COUNT(*) AS c FROM case_opens').get().c
  };
}

module.exports = {
  START_BALANCE,
  DATA_DIR,
  DB_FILE,
  newId,
  init,
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