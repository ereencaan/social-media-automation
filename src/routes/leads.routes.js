const express = require('express');
const router = express.Router();
const svc = require('../services/leads.service');
const intake = require('../services/intake.service');
const { prepare } = require('../config/database');
const { draftAndReview, draftEmail } = require('../services/lead-email.service');
const { enforceQuota } = require('../middleware/billing');
const usage = require('../services/usage.service');

// All routes here assume requireAuth has already attached req.user.
// Org scoping is derived from req.user.orgId — never from the request body.

// Intake token management (authenticated — so the user can reveal / rotate
// the token for their own workspace). The public ingest endpoint lives
// at POST /api/intake/:token under its own router.
router.get('/intake/token', (req, res) => {
  try {
    const token = intake.getOrCreateToken(req.user.orgId);
    res.json({ token, url: buildIntakeUrl(req, token) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/intake/token/rotate', (req, res) => {
  try {
    const token = intake.regenerateToken(req.user.orgId);
    res.json({ token, url: buildIntakeUrl(req, token) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function buildIntakeUrl(req, token) {
  const base = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/$/, '')}/api/intake/${token}`;
}

router.get('/', (req, res) => {
  try {
    const { status, limit, offset } = req.query;
    const leads = svc.listLeads(req.user.orgId, { status, limit, offset });
    res.json(leads);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/', enforceQuota('leads'), (req, res) => {
  try {
    const lead = svc.createLead(req.user.orgId, req.body);
    usage.increment(req.user.orgId, 'leads');
    res.status(201).json(lead);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id', (req, res) => {
  const lead = svc.getLead(req.user.orgId, req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  res.json(lead);
});

router.put('/:id', (req, res) => {
  try {
    const lead = svc.updateLead(req.user.orgId, req.params.id, req.body);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(lead);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  const ok = svc.deleteLead(req.user.orgId, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Lead not found' });
  res.json({ ok: true });
});

// ---- activities ---------------------------------------------------------
router.get('/:id/activities', (req, res) => {
  const activities = svc.listActivities(req.user.orgId, req.params.id);
  if (activities === null) return res.status(404).json({ error: 'Lead not found' });
  res.json(activities);
});

// ---- AI email flow -----------------------------------------------------
// POST /api/leads/:id/emails/draft  — generate a draft + multi-model review.
//     body: { goal?: 'intro'|'followup'|'meeting'|'reactivate'|'proposal'|'custom',
//             extra?: string }
router.post('/:id/emails/draft', enforceQuota('ai_calls'), async (req, res) => {
  try {
    const lead = svc.getLead(req.user.orgId, req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const brand = prepare('SELECT * FROM brand_settings WHERE org_id = ?').get(req.user.orgId);
    const goal = (req.body && req.body.goal) || 'intro';
    const extra = (req.body && req.body.extra) || '';
    const result = await draftAndReview({ business: brand, lead, goal, extra });
    usage.increment(req.user.orgId, 'ai_calls');
    res.json(result);
  } catch (err) {
    console.error('[LeadEmailDraft]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/:id/emails/log  — persist the (possibly edited) email as
// an activity of type 'email'. This is what 'Save' does in the UI. We also
// stash the quality report in metadata so it shows up in the timeline.
router.post('/:id/emails/log', (req, res) => {
  try {
    const { subject, body, quality, goal } = req.body || {};
    if (!subject || !body) return res.status(400).json({ error: 'subject and body are required' });
    const activity = svc.addActivity(req.user.orgId, req.params.id, req.user.id, {
      type:    'email',
      content: `${String(subject).trim()}\n\n${String(body).trim()}`,
      metadata: {
        email: { subject: String(subject).trim(), body: String(body).trim() },
        goal:  goal || null,
        quality: quality || null,
        generated_by_ai: true,
      },
    });
    if (!activity) return res.status(404).json({ error: 'Lead not found' });
    res.status(201).json(activity);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/activities', (req, res) => {
  try {
    const activity = svc.addActivity(
      req.user.orgId,
      req.params.id,
      req.user.id,
      req.body || {}
    );
    if (!activity) return res.status(404).json({ error: 'Lead not found' });
    res.status(201).json(activity);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
