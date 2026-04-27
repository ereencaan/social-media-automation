const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const authSvc = require('../services/auth.service');
const { register, login, verifyEmailToken, resendVerificationEmail,
        requestPasswordReset, resetPassword, changePassword,
        requestEmailChange, confirmEmailChange,
        deleteAccount } = authSvc;
const { requireAuth } = require('../middleware/auth');
const { loginLimiter, registerLimiter, twoFaLimiter, dailySignupLimiter } = require('../middleware/rate-limit');
const totp = require('../services/totp.service');

// Tight limit on the password-reset request endpoint — it's a public form
// that emails an arbitrary address, perfect for spamming. 5 / hour / IP is
// plenty for legit users who fat-fingered the form.
const passwordResetRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reset requests. Try again later.' },
});

// Regenerate session to prevent fixation, then set userId.
function startSession(req, res, user, status) {
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.userId = user.id;
    req.session.save((saveErr) => {
      if (saveErr) return res.status(500).json({ error: 'Session error' });
      res.status(status).json(user);
    });
  });
}

// Two limiters: the hourly burst limiter + the 24h daily ceiling. Both must
// pass. The daily one stops slow drips that the hourly one wouldn't catch.
router.post('/register', dailySignupLimiter, registerLimiter, async (req, res) => {
  try {
    const user = await register(req.body);
    startSession(req, res, user, 200);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Email verification --------------------------------------------------
// GET /api/auth/verify-email?token=xxx
//   Public. Successful verification redirects to the app with a toast hint.
//   Failed verification renders a plain text error so we don't loop the user
//   on a stale link.
router.get('/verify-email', (req, res) => {
  const token = String(req.query?.token || '').trim();
  if (!token) return res.status(400).send('Missing token');
  const ok = verifyEmailToken(token);
  if (!ok) return res.status(400).send('This verification link is invalid or expired. Sign in and request a new one.');
  // Land back on the dashboard with a hint the SPA can toast.
  res.redirect('/?verified=1');
});

// POST /api/auth/verify-email/resend (authenticated)
router.post('/verify-email/resend', requireAuth, async (req, res) => {
  try {
    const out = await resendVerificationEmail(req.user.id);
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Login — two-phase if 2FA is enabled.
//   Phase 1: POST /login { email, password }
//     - if 2FA off  → 200 + full session
//     - if 2FA on   → 200 { step: '2fa', pendingUserId } WITHOUT setting session
//   Phase 2: POST /login/2fa { pendingUserId, code }
//     - verifies TOTP or backup code, THEN starts the session
//
// We stash the pending user id in req.session under a short-lived key so
// the client can't forge an arbitrary userId. The session cookie at this
// point carries no `userId` yet, so it grants no privileges.
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const user = await login(req.body);
    if (totp.is2FAEnabled(user.id)) {
      req.session.pending2fa = {
        userId: user.id,
        at: Date.now(),
      };
      return req.session.save((err) => {
        if (err) return res.status(500).json({ error: 'Session error' });
        res.json({ step: '2fa' });
      });
    }
    startSession(req, res, user, 200);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

router.post('/login/2fa', twoFaLimiter, async (req, res) => {
  try {
    const pending = req.session?.pending2fa;
    if (!pending?.userId) return res.status(400).json({ error: 'No pending login' });
    // Pending 2FA challenge expires after 5 minutes.
    if (Date.now() - (pending.at || 0) > 5 * 60 * 1000) {
      delete req.session.pending2fa;
      return res.status(400).json({ error: 'Challenge expired, log in again' });
    }
    const code = String(req.body?.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Code required' });
    const ok = await totp.verifyLoginCode(pending.userId, code);
    if (!ok) return res.status(401).json({ error: 'Invalid code' });

    const { getUser } = require('../services/auth.service');
    const user = getUser(pending.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    delete req.session.pending2fa;
    startSession(req, res, user, 200);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ ...req.user, twoFactorEnabled: totp.is2FAEnabled(req.user.id) });
});

// ---- 2FA management (authenticated) --------------------------------------

router.post('/2fa/setup', requireAuth, async (req, res) => {
  try {
    const out = await totp.startEnrollment(req.user.id, req.user.email);
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/2fa/activate', requireAuth, async (req, res) => {
  try {
    const code = String(req.body?.code || '').trim();
    const out = await totp.activateEnrollment(req.user.id, code);
    res.json(out);   // { backupCodes: [...] } — shown once
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/2fa/disable', requireAuth, async (req, res) => {
  try {
    const code = String(req.body?.code || '').trim();
    const out = await totp.disable2FA(req.user.id, code);
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Password reset (public) --------------------------------------------
router.post('/password/request-reset', passwordResetRequestLimiter, async (req, res) => {
  try {
    await requestPasswordReset(req.body?.email);
    // Always 200 — see service comment about user enumeration.
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/password/reset', async (req, res) => {
  try {
    const token       = String(req.body?.token || '');
    const newPassword = String(req.body?.password || '');
    await resetPassword(token, newPassword);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Password change (authed) -------------------------------------------
router.post('/password/change', requireAuth, async (req, res) => {
  try {
    const cur = String(req.body?.currentPassword || '');
    const nxt = String(req.body?.newPassword || '');
    await changePassword(req.user.id, cur, nxt);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Email change ------------------------------------------------------
router.post('/email/change-request', requireAuth, async (req, res) => {
  try {
    const out = await requestEmailChange(
      req.user.id,
      String(req.body?.currentPassword || ''),
      String(req.body?.newEmail || ''),
    );
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Public confirmation link (clicked from the inbox).
router.get('/email/change-confirm', (req, res) => {
  const token = String(req.query?.token || '').trim();
  if (!token) return res.status(400).send('Missing token');
  const ok = confirmEmailChange(token);
  if (!ok) return res.status(400).send('This link is invalid or expired. Sign in and request a new one.');
  res.redirect('/?email_changed=1');
});

// ---- Account deletion --------------------------------------------------
// Soft-delete with a 30-day grace window. Logs the user out immediately;
// they can email support to restore within the grace period.
router.post('/account/delete', requireAuth, async (req, res) => {
  try {
    const out = await deleteAccount(req.user.id, String(req.body?.currentPassword || ''));
    req.session.destroy(() => {});
    res.clearCookie('connect.sid');
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
