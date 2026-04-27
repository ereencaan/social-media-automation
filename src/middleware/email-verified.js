// Gate AI / spend-burning routes on email verification.
//
// Free signups can still log in, browse, and configure their workspace.
// They just can't burn AI tokens until they prove they own the inbox they
// signed up with. This kills the "spam 100 disposable emails to farm 100×
// the AI quota" attack while staying invisible to legit users (their email
// is verified within seconds of signup).
//
// Enterprise / domain-restricted SSO users in the future may want to skip
// this — wire that up via the user's role rather than an env flag.

const { isEmailVerified } = require('../services/auth.service');

function requireVerifiedEmail(req, res, next) {
  if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
  if (!isEmailVerified(req.user.id)) {
    return res.status(403).json({
      error: 'Please verify your email before generating content.',
      code: 'email_unverified',
    });
  }
  next();
}

module.exports = { requireVerifiedEmail };
