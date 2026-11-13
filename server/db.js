'use strict';

/**
 * Storage layer.
 *
 * The platform runs on SQLite (compiled to WebAssembly by sql.js) so the whole
 * backend works without a native build step. The schema below is a 1:1 mirror of
 * `supabase/schema.sql`, which is the production PostgreSQL schema including Row
 * Level Security. When SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are configured,
 * apply supabase/schema.sql and point the data layer at PostgreSQL; the SQL used
 * by the application is intentionally portable (no SQLite-only syntax outside the
 * partial index, which PostgreSQL also supports).
 */

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'creator' CHECK (role IN ('creator','admin')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_addresses (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  network TEXT NOT NULL DEFAULT 'BEP20',
  updated_at TEXT NOT NULL
);

/* Advertising revenue, one row per day per source. Rows synced from the AdSense
   Management API have is_manual = 0; administrator entries are always 1 so they
   can never be mistaken for verified Google revenue. */
CREATE TABLE IF NOT EXISTS ad_revenue_daily (
  period_date TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'adsense',
  currency TEXT NOT NULL DEFAULT 'USD',
  estimated_earnings REAL NOT NULL DEFAULT 0,
  finalized_earnings REAL NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  page_views INTEGER NOT NULL DEFAULT 0,
  is_manual INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (period_date, source)
);

CREATE TABLE IF NOT EXISTS adsense_sync_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  message TEXT,
  rows_upserted INTEGER NOT NULL DEFAULT 0
);

/* OAuth tokens are stored encrypted (AES-256-GCM) and never returned to clients. */
CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider TEXT PRIMARY KEY,
  refresh_token_enc TEXT,
  access_token_enc TEXT,
  access_token_expires_at TEXT,
  scope TEXT,
  account_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS creator_metrics_daily (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_date TEXT NOT NULL,
  eligible_views INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, period_date)
);

/* One earning row per creator per month: UNIQUE(user_id, period) is what makes
   revenue credits idempotent and prevents duplicate creator credits. */
CREATE TABLE IF NOT EXISTS creator_earnings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  gross_pool REAL NOT NULL,
  share_rate REAL NOT NULL,
  amount REAL NOT NULL,
  eligible_views INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'finalized' CHECK (state IN ('estimated','finalized')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, period)
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  address TEXT NOT NULL,
  network TEXT NOT NULL DEFAULT 'BEP20',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','processing','paid','failed','rejected')),
  tx_hash TEXT,
  provider_ref TEXT,
  rejection_reason TEXT,
  verification_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  verified_at TEXT
);

/* A blockchain transaction hash can only ever settle one withdrawal. */
CREATE UNIQUE INDEX IF NOT EXISTS ux_withdrawals_tx
  ON withdrawals(tx_hash) WHERE tx_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

/* Video records managed by the administrator. views/watch_seconds are only ever
   incremented by real playback, never seeded with invented numbers. */
CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_url TEXT,
  thumbnail_url TEXT,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','unlisted','private')),
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','hidden','removed')),
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  watch_seconds INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_videos_created ON videos(created_at);
CREATE INDEX IF NOT EXISTS ix_videos_user ON videos(user_id);

/* Livestream monitoring: one row per stream, state changes are real transitions. */
CREATE TABLE IF NOT EXISTS livestreams (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','ended','blocked')),
  viewers INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_livestreams_status ON livestreams(status);
`;

let SQL = null;
let db = null;
let dbFile = null;

function persist() {
  if (!db || !dbFile) return;
  const tmp = `${dbFile}.tmp`;
  fs.writeFileSync(tmp, Buffer.from(db.export()));
  fs.renameSync(tmp, dbFile);
}

async function open(file) {
  SQL = await initSqlJs();
  dbFile = file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = fs.existsSync(file) ? new SQL.Database(fs.readFileSync(file)) : new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  db.run(SCHEMA);
  persist();
  return api;
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

function get(sql, params = []) {
  return all(sql, params)[0];
}

function run(sql, params = []) {
  db.run(sql, params);
  const changes = db.getRowsModified();
  persist();
  return { changes };
}

/** Run several statements atomically; rolls back on any error. */
function tx(fn) {
  db.run('BEGIN');
  try {
    const result = fn();
    db.run('COMMIT');
    persist();
    return result;
  } catch (err) {
    try {
      db.run('ROLLBACK');
    } catch {
      /* rollback best effort */
    }
    throw err;
  }
}

function isUniqueError(err) {
  return /UNIQUE constraint failed|constraint failed/i.test(String(err && err.message));
}

function close() {
  if (db) db.close();
  db = null;
}

const api = { open, all, get, run, tx, persist, isUniqueError, close, SCHEMA };

module.exports = api;
