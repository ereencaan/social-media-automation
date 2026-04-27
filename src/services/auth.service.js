const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { prepare } = require('../config/database');
const { generateId } = require('../utils/helpers');
const { isDisposable } = require('../utils/disposable-emails');
const email = require('./email.service');

const SALT_ROUNDS = 10;
const VERIFY_TOKEN_TTL_HOURS = 24;
const RESET_TOKEN_TTL_MIN    = 60;

async function register({ email: rawEmail, password, name, orgName }) {
  if (!rawEmail || !password) throw new Error('Email and password are required');
  if (password.length < 8) throw new Error('Password must be at least 8 characters');

  const normEmail = String(rawEmail).trim().toLowerCase();
  // Disposable email blocklist — this catches the bulk of automated abuse
  // without affecting legit signups. We refuse before hashing the password
  // so we don't burn CPU on doomed registrations.
  if (isDisposable(normEmail)) {
    throw new Error('Please use a permanent email address (disposable providers are not allowed).');
  }

  const existing = prepare('SELECT id FROM users WHERE email = ?').get(normEmail);
  if (existing) throw new Error('Email already registered');

  const orgId = generateId();
  const userId = generateId();
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  // Verification token. Plain random hex — short enough to fit in a URL and
  // wide enough that brute force is infeasible. Stored in plaintext because
  // the row already lives behind WHERE token = ? and the column is indexed
  // only by user, not searchable globally.
  const verifyToken   = crypto.randomBytes(24).toString('hex');
  const verifyExpires = new Date(Date.now() + VERIFY_TOKEN_TTL_HOURS * 3600 * 1000).toISOString();

  prepare('INSERT INTO orgs (id, name) VALUES (?, ?)').run(orgId, orgName || `${normEmail}'s workspace`);
  prepare(`
    INSERT INTO users (
      id, org_id, email, password_hash, name, role,
      email_verify_token, email_verify_expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, orgId, normEmail, passwordHash, name || null, 'owner', verifyToken, verifyExpires);
  prepare('INSERT INTO brand_settings (org_id) VALUES (?)').run(orgId);

  // Send verification email — fire-and-forget. A failed send must not block
  // signup; the user can request a resend from Settings.
  email.sendVerificationEmail({ to: normEmail, name, token: verifyToken })
    .catch(err => console.warn('[auth] verify email send failed:', err.message));

  return { id: userId, orgId, email: normEmail, name, role: 'owner', emailVerified: false };
}

/**
 * Activate a user's email verification token. Idempotent: re-running with a
 * consumed token is a no-op (returns false, not an error) so the user can
 * safely click the link twice.
 */
function verifyEmailToken(token) {
  if (!token) return false;
  const user = prepare(
    'SELECT id, email_verify_expires_at, email_verified_at FROM users WHERE email_verify_token = ?'
  ).get(token);
  if (!user) return false;
  if (user.email_verified_at) return true;  // already done
  if (user.email_verify_expires_at && new Date(user.email_verify_expires_at).getTime() < Date.now()) {
    return false;
  }
  prepare(`
    UPDATE users
    SET email_verified_at = datetime('now'),
        email_verify_token = NULL,
        email_verify_expires_at = NULL
    WHERE id = ?
  `).run(user.id);
  return true;
}

/** Resend verification — generates a fresh token + new expiry. */
async function resendVerificationEmail(userId) {
  const user = prepare(
    'SELECT id, email, name, email_verified_at FROM users WHERE id = ?'
  ).get(userId);
  if (!user) throw new Error('User not found');
  if (user.email_verified_at) return { alreadyVerified: true };

  const token   = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + VERIFY_TOKEN_TTL_HOURS * 3600 * 1000).toISOString();
  prepare(`
    UPDATE users SET email_verify_token = ?, email_verify_expires_at = ? WHERE id = ?
  `).run(token, expires, userId);
  await email.sendVerificationEmail({ to: user.email, name: user.name, token });
  return { sent: true };
}

function isEmailVerified(userId) {
  const u = prepare('SELECT email_verified_at FROM users WHERE id = ?').get(userId);
  return Boolean(u?.email_verified_at);
}

async function login({ email, password }) {
  if (!email || !password) throw new Error('Email and password are required');
  // Trim email (copy-paste often adds whitespace). Do NOT trim password —
  // users may legitimately use leading/trailing spaces as part of a secret.
  const normEmail = String(email).trim().toLowerCase();
  const user = prepare('SELECT * FROM users WHERE email = ?').get(normEmail);
  if (!user) {
    console.warn('[auth] login miss: no user for email=%j (len=%d)', normEmail, normEmail.length);
    throw new Error('Invalid credentials');
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    console.warn('[auth] login miss: bad password for %s (pwlen=%d)', normEmail, String(password).length);
    throw new Error('Invalid credentials');
  }

  return { id: user.id, orgId: user.org_id, email: user.email, name: user.name, role: user.role };
}

function getUser(userId) {
  const user = prepare(
    'SELECT id, org_id, email, name, role, created_at, email_verified_at FROM users WHERE id = ?'
  ).get(userId);
  if (!user) return null;
  return {
    id: user.id, orgId: user.org_id, email: user.email, name: user.name, role: user.role,
    createdAt: user.created_at,
    emailVerified: Boolean(user.email_verified_at),
  };
}

module.exports = {
  register, login, getUser,
  verifyEmailToken, resendVerificationEmail, isEmailVerified,
};
