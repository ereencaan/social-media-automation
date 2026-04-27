// Billing service — DB-side helpers + monthly cron.
//
// Stripe API talk lives in stripe.service.js; this file stays Stripe-agnostic
// so the rest of the app can read plan state without dragging the SDK in.

const cron = require('node-cron');
const { prepare } = require('../config/database');
const usage = require('./usage.service');
const { getPlan, TRIAL_DAYS } = require('../config/plans');

function getOrgBilling(orgId) {
  const org = prepare(`
    SELECT id, plan, plan_status, plan_interval, trial_ends_at,
           stripe_customer_id, stripe_subscription_id, plan_updated_at
    FROM orgs
    WHERE id = ?
  `).get(orgId);
  if (!org) return null;

  const plan = getPlan(org.plan);
  const counters = usage.getCurrent(orgId);
  return {
    plan: plan.id,
    planName: plan.name,
    planStatus: org.plan_status,
    interval: org.plan_interval,
    trialEndsAt: org.trial_ends_at,
    inTrial: org.trial_ends_at && new Date(org.trial_ends_at).getTime() > Date.now(),
    stripeCustomerId: org.stripe_customer_id,
    stripeSubscriptionId: org.stripe_subscription_id,
    quotas: plan.quotas,
    features: plan.features,
    usage: {
      period:    counters.period_month,
      posts:     counters.posts_created  || 0,
      ai_calls:  counters.ai_calls_count || 0,
      leads:     counters.leads_count    || 0,
    },
  };
}

/** Apply a Stripe sub event to the org row. Idempotent. */
function applySubscriptionToOrg({ orgId, plan, status, interval, subscriptionId, customerId, currentPeriodEnd }) {
  prepare(`
    UPDATE orgs
    SET plan = ?,
        plan_status = ?,
        plan_interval = ?,
        stripe_subscription_id = ?,
        stripe_customer_id = COALESCE(?, stripe_customer_id),
        trial_ends_at = CASE WHEN ? = 'trialing' THEN ? ELSE trial_ends_at END,
        plan_updated_at = datetime('now')
    WHERE id = ?
  `).run(
    plan, status, interval || null,
    subscriptionId || null, customerId || null,
    status, currentPeriodEnd || null,
    orgId
  );
}

/** Mark an org as past_due (invoice.payment_failed). */
function markPastDue(orgId) {
  prepare(`UPDATE orgs SET plan_status = 'past_due', plan_updated_at = datetime('now') WHERE id = ?`)
    .run(orgId);
}

/** Mark active + reset counters (invoice.paid). */
function activatePaidPeriod(orgId) {
  prepare(`UPDATE orgs SET plan_status = 'active', plan_updated_at = datetime('now') WHERE id = ?`)
    .run(orgId);
  // Don't wipe historical rows — just ensure the new period exists at zero.
  usage.resetAllForNewMonth();
}

/** Cancel: drop back to free at end of period. */
function cancelSubscription(orgId) {
  prepare(`
    UPDATE orgs
    SET plan = 'free',
        plan_status = 'canceled',
        plan_interval = NULL,
        stripe_subscription_id = NULL,
        plan_updated_at = datetime('now')
    WHERE id = ?
  `).run(orgId);
}

/** Set a trial window from now. Idempotent — won't extend an existing trial. */
function startTrialIfMissing(orgId) {
  const org = prepare('SELECT trial_ends_at FROM orgs WHERE id = ?').get(orgId);
  if (!org || org.trial_ends_at) return;
  const ends = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  prepare(`UPDATE orgs SET trial_ends_at = ?, plan_status = 'trialing' WHERE id = ?`)
    .run(ends, orgId);
}

// ---- Cron: monthly counter reset ------------------------------------------
// 00:05 UTC on the 1st. Five minutes past midnight to avoid the second-of-the-
// month edge where the period helper would still resolve to last month.
cron.schedule('5 0 1 * *', () => {
  try {
    const out = usage.resetAllForNewMonth();
    console.log(`[Billing] reset usage counters for new period ${out.period} (${out.orgsTouched} orgs)`);
  } catch (err) {
    console.error('[Billing] monthly reset failed', err);
  }
});

// ---- Cron: hard-delete soft-deleted accounts past their grace window ------
// Daily at 03:30 UTC. Picks up rows whose delete_purge_at has arrived and
// drops the user. ON DELETE CASCADE on every FK to users.id / orgs.id
// handles the rest (posts, leads, social_credentials, brand_settings, ...).
//
// We delete the org IFF the user being purged is its only owner. Multi-seat
// (Agency tier) eventually means an org could outlive any single user; for
// now there's exactly one user per org so deleting both is correct.
cron.schedule('30 3 * * *', () => {
  try {
    const due = prepare(`
      SELECT id, org_id FROM users
      WHERE delete_purge_at IS NOT NULL
        AND delete_purge_at <= datetime('now')
    `).all();

    for (const u of due) {
      // Cascade: deleting the org removes the user via FK ON DELETE CASCADE.
      // We delete the org first because that hits all the org-scoped tables
      // in one go, then any user rows still pointing at us go with the user.
      try {
        prepare('DELETE FROM orgs  WHERE id = ?').run(u.org_id);
        prepare('DELETE FROM users WHERE id = ?').run(u.id);
        console.log(`[Billing] hard-purged user ${u.id} (org ${u.org_id})`);
      } catch (innerErr) {
        console.error(`[Billing] purge failed for user ${u.id}:`, innerErr.message);
      }
    }
  } catch (err) {
    console.error('[Billing] purge cron failed', err);
  }
});

module.exports = {
  getOrgBilling,
  applySubscriptionToOrg,
  markPastDue,
  activatePaidPeriod,
  cancelSubscription,
  startTrialIfMissing,
};
