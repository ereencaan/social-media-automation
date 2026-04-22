// TOTP (RFC 6238) 2FA service — enroll, verify, and backup-code handling.
//
// Design notes:
//   * Secret is stored in plaintext in the DB. In a stricter threat model
//     we'd encrypt at rest with a KMS-derived key, but the DB is already
//     the crown jewels (password hashes, OAuth tokens) — one more secret
//     doesn't change the calculus for this tier.
//   * Backup codes are stored as bcrypt hashes — single-use, checked on
//     verify, then removed from the list.
//   * Enrollment flow:
//       1) POST /2fa/setup            -> returns { secret, otpauthUrl, qrDataUrl }
//          (server generates secret, stores it provisionally, but keeps
//           totp_enabled=0 so login still works without 2FA)
//       2) POST /2fa/activate { code } -> verifies a live TOTP code, flips
//          totp_enabled=1, issues 10 backup codes.
//   * Login flow: if totp_enabled, auth.service.login returns a stub that
//     requires a second /2fa/login step with a code.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const { prepare } = require('../config/database');

// RFC 6238 defaults are fine — 30s step, 6 digits, SHA-1.
// Allow ±1 window (i.e. the previous + next step) to tolerate clock skew.
authenticator.options = { window: 1 };

const ISSUER = 'Hitrapost';

function generateSecret() {
  return authenticator.generateSecret();  // base32, 160 bits by default
}

function otpauthUrl(secret, accountLabel) {
  return authenticator.keyuri(accountLabel, ISSUER, secret);
}

async function qrDataUrl(otpauth) {
  return QRCode.toDataURL(otpauth, { margin: 1, width: 240 });
}

function verifyCode(secret, code) {
  if (!secret || !code) return false;
  const clean = String(code).replace(/\s+/g, '');
  try {
    return authenticator.verify({ token: clean, secret });
  } catch {
    return false;
  }
}

// ---- backup codes -------------------------------------------------------

function generateBackupCodes(n = 10) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    // 10 hex chars = ~40 bits, displayed as XXXXX-XXXXX
    const raw = crypto.randomBytes(5).toString('hex');
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

async function hashBackupCodes(codes) {
  const hashes = [];
  for (const c of codes) {
    // low cost (8) — these are single-use and already high-entropy
    hashes.push(await bcrypt.hash(c, 8));
  }
  return hashes;
}

async function consumeBackupCode(userId, code) {
  const user = prepare('SELECT totp_backup_codes FROM users WHERE id = ?').get(userId);
  if (!user?.totp_backup_codes) return false;
  let hashes;
  try { hashes = JSON.parse(user.totp_backup_codes); } catch { return false; }
  if (!Array.isArray(hashes)) return false;
  const clean = String(code).replace(/\s+/g, '').toLowerCase();
  const originalBlob = user.totp_backup_codes;
  for (let i = 0; i < hashes.length; i++) {
    if (await bcrypt.compare(clean, hashes[i])) {
      // bcrypt.compare is async, so another concurrent login could have
      // already spent this code by the time we get here. Use optimistic
      // concurrency: only consume if the stored blob still equals what
      // we read. Zero changes => we lost the race, reject the code.
      const remaining = hashes.slice(0, i).concat(hashes.slice(i + 1));
      const res = prepare(
        'UPDATE users SET totp_backup_codes = ? WHERE id = ? AND totp_backup_codes = ?'
      ).run(JSON.stringify(remaining), userId, originalBlob);
      return res.changes > 0;
    }
  }
  return false;
}

// ---- enrollment ---------------------------------------------------------

async function startEnrollment(userId, email) {
  const secret = generateSecret();
  // Store provisionally but keep totp_enabled = 0 — user must confirm
  // with a live code before 2FA is actually required on login.
  prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?')
    .run(secret, userId);
  const url = otpauthUrl(secret, email);
  const qr = await qrDataUrl(url);
  return { secret, otpauthUrl: url, qrDataUrl: qr };
}

async function activateEnrollment(userId, code) {
  const user = prepare('SELECT totp_secret FROM users WHERE id = ?').get(userId);
  if (!user?.totp_secret) throw new Error('Start 2FA setup first');
  if (!verifyCode(user.totp_secret, code)) throw new Error('Invalid code');

  const codes = generateBackupCodes(10);
  const hashes = await hashBackupCodes(codes);
  prepare('UPDATE users SET totp_enabled = 1, totp_backup_codes = ? WHERE id = ?')
    .run(JSON.stringify(hashes), userId);
  return { backupCodes: codes };   // only returned once — user must save them
}

async function disable2FA(userId, currentCode) {
  const user = prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(userId);
  if (!user?.totp_enabled) return { ok: true };
  // Require a live code or backup code to disable — prevents a stolen
  // session from silently disabling 2FA.
  const viaCode = user.totp_secret && verifyCode(user.totp_secret, currentCode);
  const viaBackup = !viaCode && await consumeBackupCode(userId, currentCode);
  if (!viaCode && !viaBackup) throw new Error('Invalid code');
  prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_backup_codes = NULL WHERE id = ?')
    .run(userId);
  return { ok: true };
}

async function verifyLoginCode(userId, code) {
  const user = prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(userId);
  if (!user?.totp_enabled || !user.totp_secret) return false;
  if (verifyCode(user.totp_secret, code)) return true;
  return await consumeBackupCode(userId, code);
}

function is2FAEnabled(userId) {
  const row = prepare('SELECT totp_enabled FROM users WHERE id = ?').get(userId);
  return !!row?.totp_enabled;
}

module.exports = {
  startEnrollment,
  activateEnrollment,
  disable2FA,
  verifyLoginCode,
  is2FAEnabled,
};
