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

  // Idempotent migration: per-org intake_token for the public webhook.
  // This is the shared secret for POST /api/intake/:token — anyone with
  // the URL can file a lead into that workspace, so we rotate it on
  // demand from Settings.
  const existingOrgCols = new Set(
    db.exec("PRAGMA table_info(orgs)")[0]?.values.map(r => r[1]) || []
  );
  if (!existingOrgCols.has('intake_token')) {
    db.run(`ALTER TABLE orgs ADD COLUMN intake_token TEXT`);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_orgs_intake_token ON orgs(intake_token) WHERE intake_token IS NOT NULL`);
  }

  // Per-org Tawk webhook secret. Tawk sets a Secret Key per webhook in
  // its dashboard, then HMAC-signs every payload it sends us. Until
  // multi-tenant landed we shared a single TAWK_WEBHOOK_SECRET env var
  // across every customer — fine for dogfood, broken for SaaS (every
  // customer's webhook would have to be configured with OUR secret,
  // and a leak in one tenant burns all of them).
  //
  // Per-org secret: generated lazily on first reveal from Settings →
  // Tawk card, rotatable from the same screen. The intake route still
  // honours the env var as a fallback so existing Hitratech setup
  // keeps working until we re-key it.
  if (!existingOrgCols.has('tawk_webhook_secret')) {
    db.run(`ALTER TABLE orgs ADD COLUMN tawk_webhook_secret TEXT`);
  }

  // P1 billing columns. plan_status mirrors Stripe subscription state so the
  // app can show "past_due" banners without round-tripping to Stripe on every
  // request. trial_ends_at is set at signup time even if the user hasn't
  // attached a card yet — gives us a clean countdown banner to drive upgrades.
  const billingOrgCols = [
    ['plan',                 "TEXT NOT NULL DEFAULT 'free'"],
    ['plan_status',          "TEXT NOT NULL DEFAULT 'active'"],   // active|trialing|past_due|canceled|incomplete
    ['plan_interval',        'TEXT'],                              // monthly|yearly|null
    ['trial_ends_at',        'TEXT'],
    ['stripe_customer_id',   'TEXT'],
    ['stripe_subscription_id', 'TEXT'],
    ['plan_updated_at',      'TEXT'],
  ];
  for (const [name, type] of billingOrgCols) {
    if (!existingOrgCols.has(name)) {
      db.run(`ALTER TABLE orgs ADD COLUMN ${name} ${type}`);
    }
  }
  db.run(`CREATE INDEX IF NOT EXISTS idx_orgs_stripe_customer ON orgs(stripe_customer_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_orgs_stripe_sub      ON orgs(stripe_subscription_id)`);

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

  // Idempotent migration: 2FA + security columns on older DBs.
  const existingUserCols = new Set(
    db.exec("PRAGMA table_info(users)")[0]?.values.map(r => r[1]) || []
  );
  const wantedUserCols = [
    ['totp_secret',          'TEXT'],
    ['totp_enabled',         'INTEGER NOT NULL DEFAULT 0'],
    ['totp_backup_codes',    'TEXT'],           // JSON array of bcrypt-hashed backup codes
    ['last_login_at',        'TEXT'],
    ['failed_login_count',   'INTEGER NOT NULL DEFAULT 0'],
    ['locked_until',         'TEXT'],           // ISO datetime while account is temp-locked
    // Email verification (P1 anti-abuse). Null verified_at = not verified yet.
    // Free-tier signups can browse the app but can't burn AI calls until they
    // click the link, which kills the disposable-email-spray attack.
    ['email_verified_at',    'TEXT'],
    ['email_verify_token',   'TEXT'],
    ['email_verify_expires_at', 'TEXT'],
    // Password reset (P2). Same pattern: short-lived token + expiry.
    ['password_reset_token',      'TEXT'],
    ['password_reset_expires_at', 'TEXT'],
    // Email change (P2). new_email is what we'll switch to once the user
    // clicks the confirmation link sent to that address.
    ['email_change_new',          'TEXT'],
    ['email_change_token',        'TEXT'],
    ['email_change_expires_at',   'TEXT'],
    // Soft-delete: 30-day grace before purge so users can recover their org.
    ['deleted_at',           'TEXT'],
    ['delete_purge_at',      'TEXT'],   // ISO datetime when hard-delete fires
  ];
  for (const [name, type] of wantedUserCols) {
    if (!existingUserCols.has(name)) {
      db.run(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
    }
  }

  // ---- brand settings (one row per org) ---------------------------------
  db.run(`
    CREATE TABLE IF NOT EXISTS brand_settings (
      -- Multi-brand schema: each row is one brand profile, multiple per
      -- org are allowed (workspace can carry e.g. an IT-consultancy
      -- brand AND a SaaS-product brand). Exactly one row per org has
      -- is_default=1 — it's the brand the post pipeline auto-uses when
      -- the caller doesn't pass an explicit brand_id.
      id                 TEXT PRIMARY KEY,
      org_id             TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      name               TEXT,
      is_default         INTEGER NOT NULL DEFAULT 0,
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
  db.run('CREATE INDEX IF NOT EXISTS idx_brand_settings_org ON brand_settings(org_id)');

  // Legacy schema upgrade: prior versions used (org_id PRIMARY KEY) which
  // capped the workspace at one brand. Detect by the absence of an `id`
  // column on the existing table and rebuild — copy data into a new
  // table with the current schema, drop the old, rename. This runs once;
  // subsequent boots see `id` and skip the rebuild.
  const preBrandCols = db.exec("PRAGMA table_info(brand_settings)")[0]?.values.map(r => r[1]) || [];
  if (!preBrandCols.includes('id')) {
    db.run('ALTER TABLE brand_settings RENAME TO brand_settings_legacy');
    db.run(`
      CREATE TABLE brand_settings (
        id                 TEXT PRIMARY KEY,
        org_id             TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        name               TEXT,
        is_default         INTEGER NOT NULL DEFAULT 0,
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
    db.run('CREATE INDEX IF NOT EXISTS idx_brand_settings_org ON brand_settings(org_id)');
    // Use only the columns that exist on the legacy table — handlers added
    // various optional columns (whatsapp, *_handle, business_*, country,
    // founding_date, overlay_contact_enabled) in different orders, so the
    // shared-set approach is the only one that doesn't break a half-
    // upgraded database.
    const legacyCols = db.exec('PRAGMA table_info(brand_settings_legacy)')[0]
      .values.map((r) => r[1]);
    const newCols = db.exec('PRAGMA table_info(brand_settings)')[0]
      .values.map((r) => r[1]);
    const shared = legacyCols.filter((c) => newCols.includes(c) && c !== 'id');
    const colList = shared.join(', ');
    db.run(`
      INSERT INTO brand_settings (id, ${colList})
      SELECT lower(hex(randomblob(16))) AS id, ${colList}
        FROM brand_settings_legacy
    `);
    db.run('DROP TABLE brand_settings_legacy');
  }
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
    // P4 platform expansion: Phase 1 shipped just the captures (handle on
    // brand profile + chip on posts/calendar). Phase 2 will wire OAuth +
    // publishing for these two.
    ['tiktok_handle',        'TEXT'],
    ['youtube_handle',       'TEXT'],
    ['overlay_position',     'TEXT'],
    ['primary_color',        'TEXT'],
    // Business profile — used to steer content generation
    ['business_name',        'TEXT'],
    ['industry',             'TEXT'],
    ['business_description', 'TEXT'],
    ['target_audience',      'TEXT'],
    ['tone_of_voice',        'TEXT'],
    ['content_language',     'TEXT'],
    // Calendar inputs — country drives public-holiday lookup, founding
    // date seeds an "anniversary" entry without the user adding it by hand.
    ['country',              'TEXT'],   // ISO 3166-1 alpha-2 (e.g. 'GB','TR','US')
    ['founding_date',        'TEXT'],   // ISO date (YYYY-MM-DD)
    // Overlay toggles — let the user opt out of the auto-stamped contact
    // strip on rendered images / videos. Default 1 (on).
    ['overlay_contact_enabled', 'INTEGER NOT NULL DEFAULT 1'],
    // Multi-brand support — an org can carry multiple brand profiles
    // (e.g. Hitratech IT consultancy + Hitrapost SaaS in the same
    // workspace). brand_settings rows are no longer 1:1 with orgs;
    // each row is one brand and `is_default` flags which one fills
    // the auto-context when a post / plan item doesn't specify one.
    // `name` is the human label shown in the brand switcher.
    ['name',       'TEXT'],
    ['is_default', "INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [name, type] of wantedCols) {
    if (!existingCols.has(name)) {
      db.run(`ALTER TABLE brand_settings ADD COLUMN ${name} ${type}`);
    }
  }

  // Multi-brand backfill: every org needs at least one brand row flagged
  // as default. We seed name='Default' for any nameless rows and promote
  // the first row of each org to is_default=1 so the existing pre-multi
  // workspaces keep working without an extra UI step.
  db.run("UPDATE brand_settings SET name = COALESCE(name, business_name, 'Default') WHERE name IS NULL OR name = ''");
  // Promote one brand per org to default — pick the lowest-id row so the
  // assignment is deterministic across reboots. We only fix orgs that
  // don't already have a default flagged, so re-running the migration
  // is a no-op on already-migrated databases.
  db.run(`
    UPDATE brand_settings
       SET is_default = 1
     WHERE id IN (
       SELECT MIN(id) FROM brand_settings
        GROUP BY org_id
        HAVING SUM(is_default) = 0
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

  // Idempotent migration for orchestrator quality fields
  const existingPostCols = new Set(
    db.exec("PRAGMA table_info(posts)")[0]?.values.map(r => r[1]) || []
  );
  const wantedPostCols = [
    ['quality_score',  'INTEGER'],
    ['quality_report', 'TEXT'],    // JSON blob: { breakdown, issues, suggestions, verdict, refined, ... }
    // Multi-brand: which brand profile this post should be measured /
    // captioned / overlaid against. NULL means "use the org's default
    // brand at evaluation time" — keeps legacy posts working without
    // a backfill, and the posts.routes generator now stamps brand_id
    // explicitly when one is selected on the form.
    ['brand_id',       'TEXT'],
    // Per-platform render variants. JSON: { square: url, landscape: url,
    // vertical: url }. When a post targets multiple platforms with
    // different aspect ratios (IG square + TikTok vertical) we render
    // one image per distinct aspect group and stash the URLs here so
    // each publisher can pick the right one. NULL on older posts and
    // single-aspect posts — publishers fall back to `image_url` /
    // `drive_url` in that case.
    ['image_variants', 'TEXT'],
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
  // and 'brand_id' so calendar plan items can target a specific brand
  // profile when a workspace has more than one. NULL = default brand.
  const planItemCols = new Set(
    db.exec("PRAGMA table_info(content_plan_items)")[0]?.values.map(r => r[1]) || []
  );
  if (!planItemCols.has('attempts')) {
    db.run(`ALTER TABLE content_plan_items ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`);
  }
  if (!planItemCols.has('brand_id')) {
    db.run(`ALTER TABLE content_plan_items ADD COLUMN brand_id TEXT`);
  }
  // content_plans (the parent record) also gets a default brand so a
  // newly-created plan stamps every item it spawns with the same brand.
  const planCols = new Set(
    db.exec("PRAGMA table_info(content_plans)")[0]?.values.map(r => r[1]) || []
  );
  if (!planCols.has('brand_id')) {
    db.run(`ALTER TABLE content_plans ADD COLUMN brand_id TEXT`);
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

  // ---- Billing / usage counters --------------------------------------------
  // One row per (org, period_month). Reset on the 1st of each month by a
  // dedicated cron — see services/billing.service.js. We INSERT OR IGNORE
  // on first hit and then UPDATE...+1, so the counters survive restarts and
  // never produce a NULL row.
  db.run(`
    CREATE TABLE IF NOT EXISTS usage_counters (
      org_id            TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      period_month      TEXT NOT NULL,             -- YYYY-MM (UTC)
      posts_created     INTEGER NOT NULL DEFAULT 0,
      ai_calls_count    INTEGER NOT NULL DEFAULT 0,
      leads_count       INTEGER NOT NULL DEFAULT 0,
      updated_at        TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (org_id, period_month)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_usage_counters_period ON usage_counters(period_month)`);

  // Stripe webhook event log for idempotency. Stripe retries delivery on any
  // non-2xx, so we MUST dedupe on event.id or we'll double-credit/double-bill
  // on every retry. Tiny table, indexed by primary key only.
  db.run(`
    CREATE TABLE IF NOT EXISTS stripe_webhook_events (
      id           TEXT PRIMARY KEY,             -- Stripe's evt_xxx
      type         TEXT NOT NULL,
      received_at  TEXT DEFAULT (datetime('now')),
      processed_at TEXT,
      error        TEXT
    )
  `);

  // ---- Per-org social platform credentials --------------------------------
  // Replaces the single-tenant .env-based tokens. Each customer runs OAuth
  // against their own IG / FB / LinkedIn account and we store the result
  // here, one row per (org, platform, account). 'account_id' distinguishes
  // multiple pages / accounts — e.g. an agency with 3 FB pages would have
  // 3 rows.
  db.run(`
    CREATE TABLE IF NOT EXISTS social_credentials (
      id                 TEXT PRIMARY KEY,
      org_id             TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      platform           TEXT NOT NULL,            -- 'facebook' | 'instagram' | 'linkedin'
      account_id         TEXT,                     -- page_id (FB), ig_business_id (IG), person urn (LI)
      account_name       TEXT,                     -- display name in UI
      account_handle     TEXT,                     -- @handle / username
      account_avatar_url TEXT,
      access_token       TEXT NOT NULL,
      refresh_token      TEXT,
      token_type         TEXT,                     -- 'bearer' | 'page' | 'long_lived_user' | ...
      expires_at         TEXT,                     -- ISO datetime, NULL = never expires (some FB page tokens)
      refresh_expires_at TEXT,
      scopes             TEXT,                     -- space-separated
      status             TEXT NOT NULL DEFAULT 'active',  -- active | expired | revoked | needs_reauth
      connected_at       TEXT DEFAULT (datetime('now')),
      last_refreshed_at  TEXT,
      last_used_at       TEXT,
      last_error         TEXT,
      UNIQUE(org_id, platform, account_id)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_social_creds_org       ON social_credentials(org_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_social_creds_org_plat  ON social_credentials(org_id, platform)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_social_creds_expiry    ON social_credentials(expires_at)`);

  flush();
  return db;
}

async function getDb() {
  if (db) return db;
  if (!initPromise) initPromise = init();
  db = await initPromise;
  return db;
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
