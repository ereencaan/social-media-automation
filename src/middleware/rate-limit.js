// Rate limiters for auth endpoints.
//
// We use express-rate-limit with the default in-memory store. That is fine
// for a single-process deployment (we run one Node app on one VM). If we
// ever scale horizontally, swap the store for Redis.
//
// Two tiers:
//   * loginLimiter    — tight. 10 attempts / 15 min / IP.
//   * registerLimiter — moderate. 6 new accounts / hour / IP. Stops casual
//                       signup abuse without blocking legit team invites.
//   * twoFaLimiter    — 8 code attempts / 10 min / IP. Matches TOTP usability.
//
// Behind Cloudflare the originating IP arrives via X-Forwarded-For. Express
// won't trust that header by default; we enable `trust proxy` in app.js.

const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  // Don't count successful logins against the limit.
  skipSuccessfulRequests: true,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many signups from this IP. Try again in an hour.' },
});

// Hard ceiling on accounts created from a single IP per 24h. The hourly
// `registerLimiter` above stops bursts; this one stops slow drips. Tuned
// at 3 because a real household / co-working space might legit produce 2
// accounts in a day; 4+ is almost always abuse.
const dailySignupLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Daily signup limit reached for this IP. Try again tomorrow or contact support.' },
});

const twoFaLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many 2FA attempts. Try again in 10 minutes.' },
  skipSuccessfulRequests: true,
});

module.exports = { loginLimiter, registerLimiter, twoFaLimiter, dailySignupLimiter };
