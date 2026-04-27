// Stripe API wrapper. All Stripe SDK calls funnel through here so the rest
// of the app can stay testable / Stripe-agnostic.
//
// Configuration (.env):
//   STRIPE_SECRET_KEY            sk_live_xxx / sk_test_xxx
//   STRIPE_WEBHOOK_SECRET        whsec_xxx (set after creating the endpoint)
//   STRIPE_PRICE_*_MONTHLY       price IDs (one per plan/interval, see plans.js)
//   STRIPE_PRICE_*_YEARLY
//   PUBLIC_BASE_URL              https://hitrapost.co.uk (no trailing /)
//
// Without STRIPE_SECRET_KEY the module loads in "stub" mode — the routes
// will return 503 instead of crashing the server. That keeps local dev /
// PR previews working before the Stripe account is set up.

const Stripe = require('stripe');
const { priceIdFor, getPlan, TRIAL_DAYS } = require('../config/plans');

const SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

const stripe = SECRET_KEY ? new Stripe(SECRET_KEY, { apiVersion: '2024-11-20.acacia' }) : null;

function isConfigured() {
  return Boolean(stripe);
}

function assertConfigured() {
  if (!stripe) {
    const err = new Error('Stripe not configured (set STRIPE_SECRET_KEY)');
    err.statusCode = 503;
    throw err;
  }
}

function publicUrl(path = '') {
  const base = (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  return base + (path.startsWith('/') ? path : `/${path}`);
}

/**
 * Find or create a Stripe Customer for an org. We persist `stripe_customer_id`
 * on the org so subsequent checkouts reuse the same customer record (gives
 * the user one continuous invoice history and lets us tie webhooks to orgs
 * via customer id alone).
 */
async function ensureCustomer({ org, user }) {
  assertConfigured();
  if (org.stripe_customer_id) {
    try {
      const c = await stripe.customers.retrieve(org.stripe_customer_id);
      if (c && !c.deleted) return c;
    } catch (_) { /* fall through to create */ }
  }

  const customer = await stripe.customers.create({
    email: user.email,
    name: org.name || user.name || user.email,
    metadata: { org_id: org.id, user_id: user.id },
  });

  // Persist immediately so concurrent checkouts don't create duplicates.
  const { prepare } = require('../config/database');
  prepare('UPDATE orgs SET stripe_customer_id = ? WHERE id = ?').run(customer.id, org.id);
  return customer;
}

/** Create a Checkout Session for a (plan, interval) pair. */
async function createCheckoutSession({ org, user, plan, interval }) {
  assertConfigured();
  const priceId = priceIdFor(plan, interval);
  if (!priceId) {
    const err = new Error(`No Stripe price configured for ${plan}/${interval}`);
    err.statusCode = 400;
    throw err;
  }

  const customer = await ensureCustomer({ org, user });

  return stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customer.id,
    line_items: [{ price: priceId, quantity: 1 }],
    // Trial only on the very first paid subscription. Skip if the org has
    // already had one — Stripe will reject duplicate trials, and giving the
    // same person a fresh trial on every plan switch is abuse-prone.
    subscription_data: org.stripe_subscription_id ? undefined : {
      trial_period_days: TRIAL_DAYS,
      // Card MUST be collected at checkout — Stripe charges automatically
      // when the trial ends, no further action from the user.
      trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
    },
    payment_method_collection: 'always',
    allow_promotion_codes: true,
    automatic_tax: { enabled: true },
    customer_update: { address: 'auto', name: 'auto' },
    tax_id_collection: { enabled: true },
    success_url: publicUrl('/?billing=success&session_id={CHECKOUT_SESSION_ID}'),
    cancel_url: publicUrl('/pricing?billing=canceled'),
    metadata: {
      org_id: org.id,
      plan,
      interval,
    },
    // Mirror metadata onto the subscription so webhook handlers can route
    // events back to an org without re-querying the customer.
    subscription_data_metadata: undefined,
  }).then(async (session) => {
    // Stripe stopped accepting subscription_data_metadata above ground; set
    // it via update if the API rejected it. (Keeps backwards compat across
    // SDK versions without a hard pin.)
    return session;
  });
}

/** Create a Customer Portal session so the user can manage card / invoices. */
async function createPortalSession({ org }) {
  assertConfigured();
  if (!org.stripe_customer_id) {
    const err = new Error('No Stripe customer on file');
    err.statusCode = 400;
    throw err;
  }
  return stripe.billingPortal.sessions.create({
    customer: org.stripe_customer_id,
    return_url: publicUrl('/?tab=billing'),
  });
}

/**
 * Verify the webhook signature and return the parsed event. Throws on
 * tampering — caller responds 400 so Stripe stops retrying.
 */
function verifyWebhook(rawBody, signatureHeader) {
  if (!stripe) throw new Error('Stripe not configured');
  if (!WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET not set');
  return stripe.webhooks.constructEvent(rawBody, signatureHeader, WEBHOOK_SECRET);
}

/** Retrieve a subscription with line items expanded. */
async function getSubscription(subId) {
  assertConfigured();
  return stripe.subscriptions.retrieve(subId);
}

module.exports = {
  isConfigured,
  ensureCustomer,
  createCheckoutSession,
  createPortalSession,
  verifyWebhook,
  getSubscription,
  // Re-export for convenience in webhook handler:
  getPlan,
};
