// Per-org monthly usage counters.
//
// Counters live in `usage_counters` keyed on (org_id, period_month). The
// period is YYYY-MM in UTC — we don't try to honour each org's local time
// zone because Stripe also bills on UTC and a 1-hour drift on the resets
// isn't worth the complexity.
//
// On the 1st of every month the billing.service cron resets all counters
// to zero. The middleware reads `getCurrent(orgId)` on every quota check;
// we lazy-create the row on first increment so we never need a separate
// "ensure row exists" step.

const { prepare } = require('../config/database');

function currentPeriod(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

const COUNTER_COLUMNS = {
  posts:     'posts_created',
  ai_calls:  'ai_calls_count',
  leads:     'leads_count',
};

/** Read the row for the active period, creating a zero row if missing. */
function getCurrent(orgId) {
  const period = currentPeriod();
  let row = prepare(
    'SELECT * FROM usage_counters WHERE org_id = ? AND period_month = ?'
  ).get(orgId, period);

  if (!row) {
    prepare(`
      INSERT OR IGNORE INTO usage_counters (org_id, period_month)
      VALUES (?, ?)
    `).run(orgId, period);
    row = prepare(
      'SELECT * FROM usage_counters WHERE org_id = ? AND period_month = ?'
    ).get(orgId, period);
  }

  return row;
}

/**
 * Atomically increment one counter by `n` (default 1). Returns the new value.
 * Caller is responsible for calling enforceQuota first — this function only
 * counts.
 */
function increment(orgId, metric, n = 1) {
  const col = COUNTER_COLUMNS[metric];
  if (!col) throw new Error(`Unknown usage metric: ${metric}`);
  const period = currentPeriod();

  // INSERT OR IGNORE then UPDATE keeps this race-safe under sql.js (which
  // serializes anyway, but this pattern is portable to Postgres later).
  prepare(`
    INSERT OR IGNORE INTO usage_counters (org_id, period_month) VALUES (?, ?)
  `).run(orgId, period);

  prepare(`
    UPDATE usage_counters
    SET ${col} = ${col} + ?, updated_at = datetime('now')
    WHERE org_id = ? AND period_month = ?
  `).run(n, orgId, period);

  const row = prepare(
    `SELECT ${col} AS v FROM usage_counters WHERE org_id = ? AND period_month = ?`
  ).get(orgId, period);
  return row?.v ?? 0;
}

/** Read the value of one counter for the active period. */
function getCount(orgId, metric) {
  const col = COUNTER_COLUMNS[metric];
  if (!col) throw new Error(`Unknown usage metric: ${metric}`);
  const row = getCurrent(orgId);
  return row[col] || 0;
}

/** Cron entry point — wipe the previous period. Idempotent. */
function resetAllForNewMonth() {
  const period = currentPeriod();
  // Insert a zero row for every org for the new period. Old rows stay as
  // historical record (could be useful for owner analytics in P8).
  const orgs = prepare('SELECT id FROM orgs').all();
  for (const { id } of orgs) {
    prepare(`
      INSERT OR IGNORE INTO usage_counters (org_id, period_month)
      VALUES (?, ?)
    `).run(id, period);
  }
  return { period, orgsTouched: orgs.length };
}

module.exports = {
  currentPeriod,
  getCurrent,
  getCount,
  increment,
  resetAllForNewMonth,
  COUNTER_COLUMNS,
};
