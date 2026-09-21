const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const dbPath = process.env.DB_PATH || './data/mdm.sqlite';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS schools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  tablet_number TEXT NOT NULL,
  tablet_name TEXT,
  device_uid TEXT NOT NULL UNIQUE,
  hardware_id TEXT,
  mac_address TEXT,
  model TEXT,
  agent_version TEXT,
  token TEXT NOT NULL UNIQUE,
  online INTEGER DEFAULT 0,
  last_seen TEXT,
  battery INTEGER,
  status_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (school_id, tablet_number)
);

CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  params_json TEXT,
  status TEXT DEFAULT 'pending',
  result_json TEXT,
  issued_by TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  package_name TEXT NOT NULL,
  label TEXT,
  note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (device_id, package_name)
);

CREATE TABLE IF NOT EXISTS app_controllist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  package_name TEXT NOT NULL,
  label TEXT,
  policy TEXT NOT NULL DEFAULT 'block',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (device_id, package_name)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_devices_school ON devices(school_id);
CREATE INDEX IF NOT EXISTS idx_commands_device ON commands(device_id);
CREATE INDEX IF NOT EXISTS idx_watch_device ON app_watchlist(device_id);
CREATE INDEX IF NOT EXISTS idx_control_device ON app_controllist(device_id);
`);

// --- Lightweight migration: add newer columns to older databases. ---
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    console.log(`Migrated: added ${table}.${column}`);
  }
}
ensureColumn('devices', 'tablet_name', 'tablet_name TEXT');
ensureColumn('devices', 'hardware_id', 'hardware_id TEXT');
ensureColumn('devices', 'mac_address', 'mac_address TEXT');
ensureColumn('devices', 'model', 'model TEXT');
ensureColumn('devices', 'agent_version', 'agent_version TEXT');
ensureColumn('commands', 'issued_by', 'issued_by TEXT');
db.exec(`CREATE INDEX IF NOT EXISTS idx_devices_hardware ON devices(hardware_id);`);

// --- Role migration: legacy 'full' -> 'master' (top tier of the new 3-tier model). ---
const legacyFulls = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'full'`).get().n;
if (legacyFulls > 0) {
  db.prepare(`UPDATE users SET role = 'master' WHERE role = 'full'`).run();
  console.log(`Migrated: ${legacyFulls} 'full' account(s) -> 'master' (master control).`);
}

// --- One-time bootstrap: first 'master' account from env vars, if none exist. ---
const userCount = db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n;
if (userCount === 0) {
  const bootstrapUser = process.env.BOOTSTRAP_ADMIN_USERNAME || 'admin';
  const bootstrapPass = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (bootstrapPass) {
    const hash = bcrypt.hashSync(bootstrapPass, 10);
    db.prepare(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'master')`)
      .run(bootstrapUser, hash);
    console.log(`Created initial master-control account "${bootstrapUser}" from BOOTSTRAP_ADMIN_PASSWORD.`);
  } else {
    console.warn(
      'No user accounts exist yet, and BOOTSTRAP_ADMIN_PASSWORD is not set in .env -- ' +
      'nobody will be able to log in. Set BOOTSTRAP_ADMIN_USERNAME/BOOTSTRAP_ADMIN_PASSWORD ' +
      'and restart, or insert a user row directly.'
    );
  }
}

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function getSetting(key) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

module.exports = { db, generateToken, getSetting, setSetting };
