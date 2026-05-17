// Stripe webhook receiver.
//
// Mount at /webhooks/stripe (public — auth is the HMAC signature).
//
// IMPORTANT: signature verification needs the EXACT raw bytes Stripe sent.
// Our global express.json() middleware in app.js stashes those on
// req.rawBody before parsing, so we reuse that here.
//
// Idempotency: Stripe retries any non-2xx for up to 3 days. We dedupe on
// event.id via stripe_webhook_events table, so retries are cheap no-ops.

const express = require('express');
const router = express.Router();
const { prepare } = require('../config/database');
const stripeService = require('../services/stripe.service');
const billing = require('../services/billing.service');
const { planForPriceId, getPlan } = require('../config/plans');
const emailService = require('../services/email.service');

router.post('/', async (req, res) => {
  const sig = req.get('stripe-signature');
  if (!sig) return res.status(400).send('missing signature');
  if (!req.rawBody) return res.status(400).send('missing raw body');

  let event;
  try {
    event = stripeService.verifyWebhook(req.rawBody, sig);
  } catch (err) {
    console.warn('[stripe-webhook] signature verify failed:', err.message);
    return res.status(400).send(`signature: ${err.message}`);
  }

  // Idempotency gate. We INSERT first; if a duplicate event id, we return
  // 200 immediately so Stripe stops retrying. This MUST happen before any
  // side effects — otherwise a retry of a successful event would re-credit.
  const seen = prepare('SELECT id, processed_at FROM stripe_webhook_events WHERE id = ?').get(event.id);
  if (seen?.processed_at) {
    return res.status(200).json({ received: true, deduped: true });
  }
  if (!seen) {
    prepare('INSERT INTO stripe_webhook_events (id, type) VALUES (?, ?)').run(event.id, event.type);
  }

  try {
    await dispatch(event);
    prepare("UPDATE stripe_webhook_events SET processed_at = datetime('now') WHERE id = ?").run(event.id);
    res.status(200).json({ received: true });
  } catch (err) {
    console.error(`[stripe-webhook] ${event.type} failed:`, err);
    prepare('UPDATE stripe_webhook_events SET error = ? WHERE id = ?')
      .run(String(err.message).slice(0, 500), event.id);
    // 500 → Stripe retries with backoff. Good for transient failures.
    res.status(500).send('handler error');
  }
});

// ---- event dispatch -------------------------------------------------------

async function dispatch(event) {
  switch (event.type) {
    case 'checkout.session.completed':
      // Sub was created. We'll get a `customer.subscription.created` right
      // after — handle the actual plan sync there. Here we just attach the
      // customer id to the org if it isn't already.
      return handleCheckoutCompleted(event.data.object);

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      return handleSubscriptionUpsert(event.data.object);

    case 'customer.subscription.deleted':
      return handleSubscriptionDeleted(event.data.object);

    case 'invoice.paid':
      return handleInvoicePaid(event.data.object);

    case 'invoice.payment_failed':
      return handlePaymentFailed(event.data.object);

    case 'customer.subscription.trial_will_end':
      return handleTrialWillEnd(event.data.object);

    default:
      console.log(`[stripe-webhook] ignored ${event.type}`);
  }
}

function orgFromCustomer(customerId) {
  if (!customerId) return null;
  return prepare('SELECT * FROM orgs WHERE stripe_customer_id = ?').get(customerId);
}

async function handleCheckoutCompleted(session) {
  const orgId = session.metadata?.org_id;
  if (!orgId) return;
  if (session.customer && !session.customer.deleted) {
    prepare('UPDATE orgs SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL')
      .run(session.customer, orgId);
  }
}

function intervalFromPrice(price) {
  if (!price?.recurring?.interval) return null;
  return price.recurring.interval === 'year' ? 'yearly' : 'monthly';
}

async function handleSubscriptionUpsert(sub) {
  const org = orgFromCustomer(sub.customer);
  if (!org) {
    console.warn('[stripe-webhook] no org for customer', sub.customer);
    return;
  }

  const item = sub.items?.data?.[0];
  const priceId = item?.price?.id;
  const planId = planForPriceId(priceId);
  if (!planId) {
    console.warn('[stripe-webhook] unknown price id:', priceId);
    return;
  }

  // Map Stripe states → our 5-value enum. Anything we don't explicitly
  // handle gets the raw Stripe status, so the UI can flag "incomplete" etc.
  const stripeStatus = sub.status;
  let planStatus = stripeStatus;
  if (stripeStatus === 'active' || stripeStatus === 'trialing') planStatus = stripeStatus;
  else if (stripeStatus === 'canceled') planStatus = 'canceled';
  else if (stripeStatus === 'past_due' || stripeStatus === 'unpaid') planStatus = 'past_due';

  billing.applySubscriptionToOrg({
    orgId: org.id,
    plan: planId,
    status: planStatus,
    interval: intervalFromPrice(item?.price),
    subscriptionId: sub.id,
    customerId: sub.customer,
    currentPeriodEnd: sub.trial_end
      ? new Date(sub.trial_end * 1000).toISOString()
      : null,
  });
}

async function handleSubscriptionDeleted(sub) {
  const org = orgFromCustomer(sub.customer);
  if (!org) return;
  billing.cancelSubscription(org.id);
}

async function handleInvoicePaid(invoice) {
  const org = orgFromCustomer(invoice.customer);
  if (!org) return;
  // Mark active + ensure the new period row exists so quota checks see 0.
  billing.activatePaidPeriod(org.id);
}

async function handlePaymentFailed(invoice) {
  const org = orgFromCustomer(invoice.customer);
  if (!org) return;
  billing.markPastDue(org.id);

  // Email the org owner so they can update their card. Failure to email
  // must never break the webhook ack — the DB state is the source of
  // truth and a missed email is recoverable.
  const owner = ownerOfOrg(org.id);
  if (owner?.email) {
    try {
      await emailService.sendPaymentFailedEmail({
        to: owner.email,
        name: owner.name,
        amountFormatted: formatStripeMoney(invoice.amount_due, invoice.currency),
        hostedInvoiceUrl: invoice.hosted_invoice_url || null,
      });
    } catch (err) {
      console.warn('[stripe-webhook] payment_failed email send failed:', err.message);
    }
  }
}

async function handleTrialWillEnd(sub) {
  // Stripe fires this once, ~72h before trial ends. Email the owner with
  // a link to manage billing / confirm payment method.
  const org = orgFromCustomer(sub.customer);
  if (!org) {
    console.warn('[stripe-webhook] trial_will_end: no org for customer', sub.customer);
    return;
  }
  const owner = ownerOfOrg(org.id);
  if (!owner?.email) {
    console.warn('[stripe-webhook] trial_will_end: no owner email for org', org.id);
    return;
  }

  const priceId = sub.items?.data?.[0]?.price?.id;
  const planId = planForPriceId(priceId);
  const planName = planId ? getPlan(planId).name : null;
  const trialEndsAt = sub.trial_end ? new Date(sub.trial_end * 1000) : null;

  try {
    await emailService.sendTrialEndingEmail({
      to: owner.email,
      name: owner.name,
      planName,
      trialEndsAt,
    });
  } catch (err) {
    console.warn('[stripe-webhook] trial_will_end email send failed:', err.message);
  }
}

// ---- helpers --------------------------------------------------------------

function ownerOfOrg(orgId) {
  return prepare("SELECT email, name FROM users WHERE org_id = ? AND role = 'owner' LIMIT 1").get(orgId);
}

/** Stripe amounts are in minor units (pence/cents). 1999 GBP → "£19.99". */
function formatStripeMoney(amount, currency) {
  if (amount == null) return null;
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: (currency || 'gbp').toUpperCase(),
    }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${(currency || 'GBP').toUpperCase()}`;
  }
}

module.exports = router;
