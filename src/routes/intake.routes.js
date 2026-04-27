// Public webhook intake — POST /api/intake/:token
//
// This endpoint is the ONLY public write path in the app, so it carries
// the fattest rate-limit and does no auth beyond the token lookup. Callers
// (Typeform, Zapier, custom HTML forms) POST JSON or form-encoded data.
//
// The token-in-URL design is intentional: it lets us hand a single
// copy-pasteable URL to the customer. The token rotates from Settings
// when it leaks.

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const intake = require('../services/intake.service');

// Accept form-encoded bodies in addition to JSON (HTML forms, some older
// webhook senders). Scope the parser to this router so we don't widen
// the attack surface of the rest of the API.
router.use(express.urlencoded({ extended: false, limit: '64kb' }));

// 60 submissions per minute per IP per token. A customer's Zapier zap
// can burst higher than a normal form; if it becomes a problem we scope
// the limiter per-token instead of per-IP.
const intakeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded' },
});

router.post('/:token', intakeLimiter, (req, res) => {
  try {
    const org = intake.getOrgByToken(req.params.token);
    if (!org) return res.status(404).json({ error: 'Invalid intake token' });
    const lead = intake.ingest(org.id, req.body || {});
    // Count toward the monthly leads quota but do NOT block — webhook senders
    // (Zapier, custom forms) usually don't retry on 402, and silently dropping
    // a customer's lead is the worst possible failure mode here. The UI shows
    // a "you're over quota" banner so the owner upgrades; we just keep
    // ingesting in the meantime.
    try { require('../services/usage.service').increment(org.id, 'leads'); } catch (_) {}
    res.status(201).json({ ok: true, leadId: lead.id });
  } catch (err) {
    const status = err.status || 400;
    res.status(status).json({ error: err.message });
  }
});

// Health: lets a customer verify their URL works before setting up the zap.
router.get('/:token/ping', (req, res) => {
  const org = intake.getOrgByToken(req.params.token);
  if (!org) return res.status(404).json({ error: 'Invalid intake token' });
  res.json({ ok: true, workspace: org.name });
});

module.exports = router;
