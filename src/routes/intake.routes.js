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
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const intake = require('../services/intake.service');
const emailParser = require('../services/email-parser.service');

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
// the X-Tawk-Signature header. The secret is per-webhook (set in the
// Tawk dashboard when adding the webhook).
//
// Resolution order, most-to-least scoped:
//   1. org.tawk_webhook_secret — per-tenant secret rotated from Settings
//   2. process.env.TAWK_WEBHOOK_SECRET — single-tenant fallback so the
//      Hitratech dogfood install keeps working until we re-key it
//   3. Neither set → accept (warn) so first-run users aren't blocked
//      before they've configured anything
//
// A signature failure at step 1 does NOT fall through to step 2 — once
// the org has a real per-tenant secret, that's the only thing we'll
// accept (otherwise a stale env var would let unauthenticated webhooks
// through for a customer who'd already rotated their secret).
let warnedTawkNoSecret = false;
function verifyTawkSignature(req, org) {
  const orgSecret = org?.tawk_webhook_secret || null;
  const envSecret = process.env.TAWK_WEBHOOK_SECRET || null;
  const secret = orgSecret || envSecret;

  if (!secret) {
    if (!warnedTawkNoSecret) {
      console.warn('[TawkWebhook] no per-org secret + no TAWK_WEBHOOK_SECRET — accepting unsigned webhooks (configure from Settings → Tawk to enforce)');
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

// Email-to-lead intake — receives inbound mail forwarded by an email
// provider (currently SendGrid Inbound Parse). The provider POSTs
// multipart/form-data with parsed `from` / `to` / `subject` / `text` /
// `html` / `headers` fields. We:
//   1. Find the org by the local-part of the `to` address (the per-org
//      forwarding token, e.g. <token>@leads.hitrapost.co.uk).
//   2. Run the email through email-parser → extract name / phone / source.
//   3. Hand off to intake.service.ingestEmail to create / dedupe the lead.
//
// Always replies 200 even when we drop the email (anti-spam, no-token,
// no-identifier) so the provider doesn't keep retrying junk forever.
//
// Auth: when EMAIL_INBOUND_DOMAIN is set, we only accept mails whose
// recipient domain matches it. The token itself is the secondary auth —
// guessing a 32-char base64url string is the same difficulty as guessing
// any other intake token. An optional shared secret can be set with
// EMAIL_INBOUND_SECRET; when set, the provider must include ?key=<secret>
// in the URL or the request is rejected.
const emailUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 5 }, // SendGrid caps at ~30MB total
});

let warnedEmailNoSecret = false;
function checkEmailAuth(req) {
  const secret = process.env.EMAIL_INBOUND_SECRET;
  if (!secret) {
    if (!warnedEmailNoSecret) {
      console.warn('[EmailIntake] EMAIL_INBOUND_SECRET not set — accepting any caller; recipient-domain check is the only auth');
      warnedEmailNoSecret = true;
    }
    return true;
  }
  return req.query.key === secret;
}

router.post(
  '/email',
  intakeLimiter,
  emailUpload.any(),
  (req, res) => {
    try {
      if (!checkEmailAuth(req)) {
        // Don't leak detail. SendGrid retries on non-200; we 401 once and
        // the operator notices in the SendGrid dashboard.
        return res.status(401).json({ error: 'unauthorized' });
      }

      const expectedDomain = process.env.EMAIL_INBOUND_DOMAIN || '';
      const token = emailParser.extractToken(
        req.body && (req.body.to || (req.body.envelope ? safeJsonField(req.body.envelope, 'to') : '')),
        expectedDomain,
      );
      if (!token) {
        // Couldn't find a routable recipient. Drop with 200 to stop retries.
        console.warn('[EmailIntake] no token in to-field, dropping');
        return res.status(200).json({ ok: true, ignored: 'no_token' });
      }

      const org = intake.getOrgByToken(token);
      if (!org) {
        console.warn('[EmailIntake] unknown token, dropping');
        return res.status(200).json({ ok: true, ignored: 'unknown_token' });
      }

      const parsed = emailParser.parseInboundEmail(req.body || {});
      const lead = intake.ingestEmail(org.id, parsed);
      if (!lead) {
        return res.status(200).json({ ok: true, ignored: 'no_identifier' });
      }
      res.status(201).json({ ok: true, leadId: lead.id });
    } catch (err) {
      console.error('[EmailIntake] error:', err && err.message);
      // Still 200 to drop the retry — error is on us, retrying won't help.
      res.status(200).json({ ok: true, ignored: 'error' });
    }
  },
);

// SendGrid sometimes packs the envelope as a JSON string in a form field.
// We can't fully JSON.parse it without crashing on malformed input, so we
// pull the field we need with a tolerant regex (string field "to" → first
// value).
function safeJsonField(jsonStr, key) {
  try {
    const obj = JSON.parse(jsonStr);
    if (Array.isArray(obj[key])) return obj[key].join(',');
    return obj[key] || '';
  } catch (_) {
    return '';
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
    // verifyTawkSignature uses org.tawk_webhook_secret when set, else
    // falls back to the env var. getOrgByToken already returns the full
    // org row so the secret is available without a second lookup.
    if (!verifyTawkSignature(req, org)) {
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
