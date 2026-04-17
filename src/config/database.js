// SQLite database layer built on sql.js (WASM).
//
// sql.js is synchronous *after* WASM initialization, but init is async.
// Contract:
//   1. `getDb()` must be awaited once at startup (src/app.js does this).
//   2. After that, `prepare(sql)` returns a synchronous Statement with
//      `.get(...params)`, `.all(...params)`, `.run(...params)` — mirroring
//      the better-sqlite3 API, which callers (auth.service, posts.routes,
//      leads.service, ...) depend on.
//   3. Every `.run(...)` that mutates state flushes the DB to disk so a
//      crash doesn't lose work. This is fine for our write volumes; if it
//      ever becomes hot, we can switch to a debounced flush.

const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const storageDir = path.join(__dirname, '../../storage');
if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir, { recursive: true });
}

const DB_PATH = path.join(storageDir, 'posts.db');

let db = null;
let initPromise = null;

function flush() {
  if (!db) return;
  const data = db.export();
  // atomic-ish write: write to tmp, then rename
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(data));
  fs.renameSync(tmp, DB_PATH);
}

async function init() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');

  // ---- multi-tenant core -------------------------------------------------
  db.run(`
    CREATE TABLE IF NOT EXISTS orgs (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name          TEXT,
      role          TEXT NOT NULL DEFAULT 'member',
      created_at    TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id)`);

  // ---- brand settings (one row per org) ---------------------------------
  db.run(`
    CREATE TABLE IF NOT EXISTS brand_settings (
      org_id        TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
      logo_url      TEXT,
      phone         TEXT,
      website       TEXT,
      primary_color TEXT,
      updated_at    TEXT DEFAULT (datetime('now'))
    )
  `);

  // ---- content ----------------------------------------------------------
  db.run(`
    CREATE TABLE IF NOT EXISTS posts (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
      prompt        TEXT NOT NULL,
      caption       TEXT,
      hashtags      TEXT,
      image_url     TEXT,
      drive_url     TEXT,
      drive_file_id TEXT,
      platforms     TEXT DEFAULT '[]',
      scheduled_at  TEXT,
      status        TEXT DEFAULT 'draft',
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_posts_org        ON posts(org_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_posts_org_status ON posts(org_id, status)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS post_logs (
      id          TEXT PRIMARY KEY,
      post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      platform    TEXT NOT NULL,
      status      TEXT NOT NULL,
      message     TEXT,
      external_id TEXT,
      posted_at   TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_post_logs_post ON post_logs(post_id)`);

  // ---- CRM / leads ------------------------------------------------------
  db.run(`
    CREATE TABLE IF NOT EXISTS leads (
      id          TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      source      TEXT,                   -- 'instagram_dm', 'linkedin', 'manual', ...
      source_ref  TEXT,                   -- external id (IG thread id, LI urn, ...)
      name        TEXT,
      email       TEXT,
      phone       TEXT,
      status      TEXT NOT NULL DEFAULT 'new',   -- new|contacted|qualified|won|lost
      stage       TEXT,                   -- free-form pipeline stage
      assigned_to TEXT REFERENCES users(id) ON DELETE SET NULL,
      notes       TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_leads_org        ON leads(org_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_leads_org_status ON leads(org_id, status)`);
  // Prevent duplicate intake of the same external source+ref within an org.
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_org_source_ref
    ON leads(org_id, source, source_ref)
    WHERE source IS NOT NULL AND source_ref IS NOT NULL
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS lead_activities (
      id         TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      lead_id    TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
      type       TEXT NOT NULL,          -- note|email|call|message|status_change|...
      content    TEXT,
      metadata   TEXT,                    -- JSON string
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_lead_activities_lead ON lead_activities(lead_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_lead_activities_org  ON lead_activities(org_id)`);

  flush();
  return db;
}

async function getDb() {
  if (db) return db;
  if (!initPromise) initPromise = init();
  return initPromise;
}

// ---- synchronous statement wrapper (better-sqlite3-compatible API) ------
//
// Every caller assumes the DB is already initialized. We assert that here
// instead of silently returning bogus empty results.
function rowsFromStatement(stmt) {
  const cols = stmt.getColumnNames();
  const rows = [];
  while (stmt.step()) {
    const values = stmt.get();
    const obj = {};
    for (let i = 0; i < cols.length; i++) obj[cols[i]] = values[i];
    rows.push(obj);
  }
  return rows;
}

function prepare(sql) {
  if (!db) {
    throw new Error('Database not initialized — await getDb() before calling prepare()');
  }
  const isMutation = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);

  return {
    get(...params) {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params);
        if (!stmt.step()) return undefined;
        const cols = stmt.getColumnNames();
        const values = stmt.get();
        const obj = {};
        for (let i = 0; i < cols.length; i++) obj[cols[i]] = values[i];
        return obj;
      } finally {
        stmt.free();
      }
    },
    all(...params) {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params);
        return rowsFromStatement(stmt);
      } finally {
        stmt.free();
      }
    },
    run(...params) {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params);
        stmt.step();
      } finally {
        stmt.free();
      }
      const changes = db.getRowsModified();
      // Only pay the disk-write cost when a mutation actually changed rows
      // (skips flush for UPDATE/DELETE that matched nothing).
      if (isMutation && changes > 0) flush();
      return { changes };
    },
  };
}

module.exports = { getDb, prepare, flush };
