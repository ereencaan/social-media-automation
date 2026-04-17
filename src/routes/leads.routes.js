const express = require('express');
const router = express.Router();
const svc = require('../services/leads.service');

// All routes here assume requireAuth has already attached req.user.
// Org scoping is derived from req.user.orgId — never from the request body.

router.get('/', (req, res) => {
  try {
    const { status, limit, offset } = req.query;
    const leads = svc.listLeads(req.user.orgId, { status, limit, offset });
    res.json(leads);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/', (req, res) => {
  try {
    const lead = svc.createLead(req.user.orgId, req.body);
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
