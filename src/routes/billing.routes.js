// Billing routes — authenticated. Mounted under /api/billing.
//
// All routes operate on the *current user's org*. There is no org switcher;
// the session cookie is the source of truth.

const express = require('express');
const router = express.Router();
const { prepare } = require('../config/database');
const stripeService = require('../services/stripe.service');
const billing = require('../services/billing.service');
const { PLANS } = require('../config/plans');

/** GET /api/billing/me — plan + usage for dashboard / settings. */
router.get('/me', (req, res) => {
  const data = billing.getOrgBilling(req.user.orgId);
  if (!data) return res.status(404).json({ error: 'Org not found' });
  res.json({ ...data, stripeConfigured: stripeService.isConfigured() });
});

/** GET /api/billing/plans — public catalog for the pricing page. */
router.get('/plans', (req, res) => {
  // Strip Stripe price ids — the frontend doesn't need them, and exposing
  // them costs nothing but principle.
  const out = {};
  for (const [id, p] of Object.entries(PLANS)) {
    out[id] = {
      id,
      name: p.name,
      rank: p.rank,
      quotas: p.quotas,
      features: p.features,
      priceMonthlyGbp: p.priceMonthlyGbp,
      priceYearlyGbp: p.priceYearlyGbp,
    };
  }
  res.json(out);
});

/**
 * POST /api/billing/checkout
 * body: { plan: 'starter'|'pro'|'agency', interval: 'monthly'|'yearly' }
 * 200 { url } — redirect the browser there.
 */
router.post('/checkout', async (req, res) => {
  try {
    const plan = String(req.body?.plan || '').toLowerCase();
    const interval = String(req.body?.interval || 'monthly').toLowerCase();
    if (!['starter', 'pro', 'agency'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan' });
    }
    if (!['monthly', 'yearly'].includes(interval)) {
      return res.status(400).json({ error: 'Invalid interval' });
    }

    const org = prepare('SELECT * FROM orgs WHERE id = ?').get(req.user.orgId);
    const session = await stripeService.createCheckoutSession({
      org,
      user: req.user,
      plan,
      interval,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[billing] checkout', err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * POST /api/billing/portal — open the Stripe Customer Portal so the user
 * can update card, see invoices, and cancel.
 */
router.post('/portal', async (req, res) => {
  try {
    const org = prepare('SELECT * FROM orgs WHERE id = ?').get(req.user.orgId);
    if (!org?.stripe_customer_id) {
      return res.status(400).json({ error: 'No active subscription. Upgrade first.' });
    }
    const session = await stripeService.createPortalSession({ org });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[billing] portal', err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

module.exports = router;
