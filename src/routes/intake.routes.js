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
const crypto = require('crypto');
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

// Tawk signs each webhook with HMAC-SHA1(rawBody, webhookSecret) hex in
// the X-Tawk-Signature header. The secret is set per-webhook in the Tawk
// dashboard. We accept TAWK_WEBHOOK_SECRET as a single-tenant env var for
// now; per-org secrets can come later when we land multi-tenant config.
// If no secret is configured, signatures are not enforced — fine for the
// first-run / dogfood phase, but log a warning so we don't forget.
let warnedTawkNoSecret = false;
function verifyTawkSignature(req) {
  const secret = process.env.TAWK_WEBHOOK_SECRET;
  if (!secret) {
    if (!warnedTawkNoSecret) {
      console.warn('[TawkWebhook] TAWK_WEBHOOK_SECRET not set — accepting unsigned webhooks');
      warnedTawkNoSecret = true;
    }
    return true;
  }
  const sig = req.get('X-Tawk-Signature');
  if (!sig) return false;
  const raw = req.rawBody || Buffer.from('');
  const expected = crypto.createHmac('sha1', secret).update(raw).digest('hex');
  if (sig.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// Tawk-specific intake. Tawk's payload is nested (visitor.name, visitor.email,
// chatId, event) and the generic /:token normalizer can't reach those fields,
// so we route Tawk to a dedicated handler that maps the shape and stamps
// source: 'tawk_livechat'.
router.post('/tawk/:token', intakeLimiter, (req, res) => {
  try {
    const org = intake.getOrgByToken(req.params.token);
    if (!org) return res.status(404).json({ error: 'Invalid intake token' });
    if (!verifyTawkSignature(req)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    const lead = intake.ingestTawk(org.id, req.body || {});
    // Always 200 on accepted-but-no-lead so Tawk doesn't retry chat:end etc.
    if (!lead) return res.status(200).json({ ok: true, ignored: true });
    res.status(201).json({ ok: true, leadId: lead.id });
  } catch (err) {
    const status = err.status || 400;
    res.status(status).json({ error: err.message });
  }
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
