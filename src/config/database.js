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
      org_id             TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
      logo_url           TEXT,
      logo_cloudinary_id TEXT,
      phone              TEXT,
      whatsapp           TEXT,
      website            TEXT,
      instagram_handle   TEXT,
      facebook_handle    TEXT,
      linkedin_handle    TEXT,
      overlay_position   TEXT,
      primary_color      TEXT,
      updated_at         TEXT DEFAULT (datetime('now'))
    )
  `);
  // Idempotent migration: add columns that may be missing on older DBs
  const existingCols = new Set(
    db.exec("PRAGMA table_info(brand_settings)")[0]?.values.map(r => r[1]) || []
  );
  const wantedCols = [
    ['logo_cloudinary_id',   'TEXT'],
    ['whatsapp',             'TEXT'],
    ['instagram_handle',     'TEXT'],
    ['facebook_handle',      'TEXT'],
    ['linkedin_handle',      'TEXT'],
    ['overlay_position',     'TEXT'],
    ['primary_color',        'TEXT'],
    // Business profile — used to steer content generation
    ['business_name',        'TEXT'],
    ['industry',             'TEXT'],
    ['business_description', 'TEXT'],
    ['target_audience',      'TEXT'],
    ['tone_of_voice',        'TEXT'],
    ['content_language',     'TEXT'],
  ];
  for (const [name, type] of wantedCols) {
    if (!existingCols.has(name)) {
      db.run(`ALTER TABLE brand_settings ADD COLUMN ${name} ${type}`);
    }
  }

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

  // Idempotent migration for orchestrator quality fields
  const existingPostCols = new Set(
    db.exec("PRAGMA table_info(posts)")[0]?.values.map(r => r[1]) || []
  );
  const wantedPostCols = [
    ['quality_score',  'INTEGER'],
    ['quality_report', 'TEXT'],    // JSON blob: { breakdown, issues, suggestions, verdict, refined, ... }
  ];
  for (const [name, type] of wantedPostCols) {
    if (!existingPostCols.has(name)) {
      db.run(`ALTER TABLE posts ADD COLUMN ${name} ${type}`);
    }
  }

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

  // ---- content planning (calendar-driven + quota-driven post scheduling) --
  db.run(`
    CREATE TABLE IF NOT EXISTS content_plans (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      month         TEXT NOT NULL,         -- YYYY-MM
      target_count  INTEGER NOT NULL,
      mode          TEXT NOT NULL,         -- 'calendar' | 'quota' | 'hybrid'
      strategy      TEXT,                  -- JSON: platform mix, constraints, country
      status        TEXT NOT NULL DEFAULT 'draft', -- draft|active|completed|archived
      auto_publish  INTEGER NOT NULL DEFAULT 0,    -- 0=off (safe default), 1=trust mode
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_plans_org_month ON content_plans(org_id, month)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS content_plan_items (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      plan_id       TEXT NOT NULL REFERENCES content_plans(id) ON DELETE CASCADE,
      scheduled_for TEXT NOT NULL,         -- ISO datetime UTC
      theme         TEXT,                  -- 'valentines' | 'weekly_tip' | ...
      topic_brief   TEXT NOT NULL,         -- prompt fed to /generate when the day arrives
      platforms     TEXT DEFAULT '[]',
      status        TEXT NOT NULL DEFAULT 'planned',
           -- planned | generating | draft | approved | published | failed | skipped
      post_id       TEXT REFERENCES posts(id) ON DELETE SET NULL,
      reasoning     TEXT,                  -- AI's one-line justification
      error         TEXT,                  -- last failure reason, if any
      generated_at  TEXT,
      published_at  TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_plan_items_plan         ON content_plan_items(plan_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_plan_items_org_status   ON content_plan_items(org_id, status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_plan_items_schedule     ON content_plan_items(scheduled_for)`);

  // Idempotent: add 'attempts' column for auto-retry on failed items
  const planItemCols = new Set(
    db.exec("PRAGMA table_info(content_plan_items)")[0]?.values.map(r => r[1]) || []
  );
  if (!planItemCols.has('attempts')) {
    db.run(`ALTER TABLE content_plan_items ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`);
  }

  // Business-specific important dates (company anniversary, launches, etc).
  // These flow into the content planner the same way country/industry days do.
  db.run(`
    CREATE TABLE IF NOT EXISTS brand_special_dates (
      id         TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      month      INTEGER NOT NULL,        -- 1..12
      day        INTEGER NOT NULL,        -- 1..31
      name       TEXT NOT NULL,
      note       TEXT,                    -- free-form context for the AI
      tier       INTEGER NOT NULL DEFAULT 1,  -- 1=must-consider, 2=strong, 3=nice
      annual     INTEGER NOT NULL DEFAULT 1,  -- 0=one-off, 1=every year
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_brand_dates_org ON brand_special_dates(org_id)`);

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
