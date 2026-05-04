// Storage layer for per-org social platform credentials.
//
// The publish services (instagram/facebook/linkedin) call getActive() to
// retrieve the right token for the target org+platform. The OAuth callback
// handlers call upsert() after a successful authorize. Refresh cron calls
// listNearExpiry() + markRefreshed()/markExpired().

const { prepare } = require('../config/database');
const { generateId } = require('../utils/helpers');

function nowIso() { return new Date().toISOString(); }

/** Insert or update a credential. Uniqueness is (org_id, platform, account_id). */
function upsert(orgId, platform, input) {
  const {
    account_id = null, account_name = null, account_handle = null, account_avatar_url = null,
    access_token, refresh_token = null, token_type = 'bearer',
    expires_at = null, refresh_expires_at = null,
    scopes = null,
  } = input;

  if (!access_token) throw new Error('access_token required');

  const existing = prepare(
    'SELECT id FROM social_credentials WHERE org_id = ? AND platform = ? AND account_id IS ?'
  ).get(orgId, platform, account_id);

  if (existing) {
    prepare(`
      UPDATE social_credentials
      SET account_name = ?, account_handle = ?, account_avatar_url = ?,
          access_token = ?, refresh_token = ?, token_type = ?,
          expires_at = ?, refresh_expires_at = ?,
          scopes = ?,
          status = 'active', last_refreshed_at = datetime('now'),
          last_error = NULL
      WHERE id = ?
    `).run(
      account_name, account_handle, account_avatar_url,
      access_token, refresh_token, token_type,
      expires_at, refresh_expires_at, scopes,
      existing.id,
    );
    return prepare('SELECT * FROM social_credentials WHERE id = ?').get(existing.id);
  }

  const id = generateId();
  prepare(`
    INSERT INTO social_credentials
      (id, org_id, platform, account_id, account_name, account_handle, account_avatar_url,
       access_token, refresh_token, token_type, expires_at, refresh_expires_at, scopes, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(
    id, orgId, platform, account_id, account_name, account_handle, account_avatar_url,
    access_token, refresh_token, token_type, expires_at, refresh_expires_at, scopes,
  );
  return prepare('SELECT * FROM social_credentials WHERE id = ?').get(id);
}

/** Used by publish services — return the first active credential for this org+platform. */
function getActive(orgId, platform) {
  const row = prepare(`
    SELECT * FROM social_credentials
    WHERE org_id = ? AND platform = ? AND status = 'active'
    ORDER BY connected_at DESC
    LIMIT 1
  `).get(orgId, platform);
  if (!row) return null;
  // Touch last_used_at so we know the credential is alive in telemetry
  prepare("UPDATE social_credentials SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
  return row;
}

function listForOrg(orgId) {
  return prepare(
    'SELECT * FROM social_credentials WHERE org_id = ? ORDER BY platform, connected_at DESC'
  ).all(orgId);
}

function remove(id, orgId) {
  const res = prepare('DELETE FROM social_credentials WHERE id = ? AND org_id = ?').run(id, orgId);
  return !!res.changes;
}

function markExpired(id, reason) {
  prepare(`
    UPDATE social_credentials
    SET status = 'expired', last_error = ?
    WHERE id = ?
  `).run(String(reason || '').slice(0, 500), id);
}

function markNeedsReauth(id, reason) {
  prepare(`
    UPDATE social_credentials
    SET status = 'needs_reauth', last_error = ?
    WHERE id = ?
  `).run(String(reason || '').slice(0, 500), id);
}

/**
 * Rotate the access_token in place after a refresh-token exchange. Keeps
 * every other field on the row intact (account_id, name, handle, avatar,
 * scopes, refresh_token) so the rotated row stays equivalent to what
 * upsert would have produced. Used by publish services that lazily
 * refresh expired tokens before each call rather than running a cron.
 */
function updateAccessToken(id, { access_token, expires_at = null, refresh_token, scopes = null }) {
  if (!access_token) throw new Error('access_token required');
  // refresh_token is optional — Google omits it on refresh responses, so
  // we keep whatever was already stored. Pass an explicit string to
  // overwrite (some providers do issue a new refresh_token on each refresh).
  const sets = ['access_token = ?', 'expires_at = ?',
                "status = 'active'", "last_refreshed_at = datetime('now')",
                'last_error = NULL'];
  const vals = [access_token, expires_at];
  if (scopes != null)        { sets.splice(2, 0, 'scopes = ?');        vals.splice(2, 0, scopes); }
  if (refresh_token != null) { sets.splice(2, 0, 'refresh_token = ?'); vals.splice(2, 0, refresh_token); }
  vals.push(id);
  prepare(`UPDATE social_credentials SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return prepare('SELECT * FROM social_credentials WHERE id = ?').get(id);
}

/** Credentials that will expire within `days` days — used by refresh cron. */
function listNearExpiry(days = 7) {
  const cutoff = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  return prepare(`
    SELECT * FROM social_credentials
    WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?
  `).all(cutoff);
}

// Strip sensitive fields before returning to the UI
function presentSafe(row) {
  if (!row) return null;
  const {
    access_token, refresh_token, ...safe
  } = row;
  // Show a short hint so the user knows *which* token it is
  safe.token_hint = access_token ? access_token.slice(0, 6) + '…' : null;
  // Boolean flag for the UI to decide whether to show a meaningful
  // countdown (no refresh = the access-token expiry IS the death clock)
  // or "Active" forever (refresh token can be redeemed for new access
  // tokens for as long as the provider allows). Keeps the secret out
  // of the response while letting the frontend reason about lifecycle.
  safe.has_refresh_token = !!refresh_token;
  return safe;
}

module.exports = {
  upsert, getActive, listForOrg, remove,
  markExpired, markNeedsReauth, updateAccessToken, listNearExpiry,
  presentSafe,
};
