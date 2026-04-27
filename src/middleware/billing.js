// Billing middleware — gates routes on plan tier and monthly quota.
//
// Two factories:
//   * requirePlan('pro')   → 402 Payment Required when org's plan rank < target
//   * enforceQuota('posts') → 402 when this month's counter ≥ plan limit
//
// We return 402 (not 403) so the frontend can distinguish "you need to pay"
// from "you can't access this period". The 402 body always includes the
// triggering plan/metric so the upgrade modal can render the right CTA.

const { prepare } = require('../config/database');
const { getPlan, meetsTier, isUnlimited } = require('../config/plans');
const usage = require('../services/usage.service');

function getOrg(orgId) {
  return prepare(
    `SELECT id, plan, plan_status, trial_ends_at FROM orgs WHERE id = ?`
  ).get(orgId);
}

/** True if the trial is still active (set + future). */
function isInTrial(org) {
  if (!org?.trial_ends_at) return false;
  return new Date(org.trial_ends_at).getTime() > Date.now();
}

/**
 * 402 if the org's plan tier is below `minPlan`. Trialing orgs pass —
 * during trial they get the plan they signed up to, just unpaid.
 */
function requirePlan(minPlan) {
  return function (req, res, next) {
    const org = getOrg(req.user?.orgId);
    if (!org) return res.status(401).json({ error: 'No org' });

    if (!meetsTier(org.plan, minPlan)) {
      return res.status(402).json({
        error: 'Upgrade required',
        code: 'plan_required',
        currentPlan: org.plan,
        requiredPlan: minPlan,
      });
    }

    // Block past_due / canceled regardless of tier — Stripe will have stopped
    // collecting and the user needs to fix billing before generating more.
    if (org.plan_status === 'past_due' || org.plan_status === 'canceled') {
      return res.status(402).json({
        error: 'Subscription requires attention',
        code: 'plan_inactive',
        planStatus: org.plan_status,
        currentPlan: org.plan,
      });
    }

    next();
  };
}

/**
 * 402 if the active period's counter for `metric` has hit the plan's quota.
 * Caller is responsible for calling usage.increment(metric) AFTER the action
 * succeeds — we only check here, we don't pre-claim. That means a perfectly
 * timed double-click can over-shoot by 1, which we accept as a tradeoff
 * against rolling back partial AI work.
 */
function enforceQuota(metric) {
  return function (req, res, next) {
    const org = getOrg(req.user?.orgId);
    if (!org) return res.status(401).json({ error: 'No org' });

    const plan = getPlan(org.plan);
    const limit = plan.quotas?.[metric];
    if (limit === undefined) {
      // Unknown metric in this plan — fail open rather than break the route.
      return next();
    }
    if (isUnlimited(limit)) return next();

    const used = usage.getCount(org.id, metric);
    if (used >= limit) {
      return res.status(402).json({
        error: 'Monthly quota exceeded',
        code: 'quota_exceeded',
        metric,
        limit,
        used,
        currentPlan: org.plan,
        resetsAt: nextMonthStartIso(),
      });
    }

    // Stash for downstream code (e.g. usage indicators on responses).
    req.billing = { plan: plan.id, used, limit, metric };
    next();
  };
}

function nextMonthStartIso() {
  const now = new Date();
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() + 1,
    1, 0, 0, 0
  )).toISOString();
}

module.exports = {
  requirePlan,
  enforceQuota,
  isInTrial,
};
