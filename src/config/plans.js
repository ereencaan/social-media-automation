// Hitrapost subscription plans — single source of truth.
//
// Limits here are checked at runtime by the enforceQuota middleware.
// Stripe Price IDs are read from env so staging / prod can use different
// catalogs without code changes; create the products in Stripe Dashboard
// and paste the IDs into .env (see .env.example).
//
// Tier ordering matters — `requirePlan('pro')` admits anything ≥ pro.

const TIER_RANK = { free: 0, starter: 1, pro: 2, agency: 3, enterprise: 4 };

const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    rank: TIER_RANK.free,
    // The post-signup default before a plan is chosen. Generous enough to
    // try the product, tight enough that it isn't a usable production tier.
    quotas: { posts: 5, ai_calls: 25, leads: 50 },
    features: { socials: 1, seats: 1, video: 0, white_label: false },
    priceMonthlyGbp: 0,
    priceYearlyGbp: 0,
    stripePriceMonthly: null,
    stripePriceYearly: null,
  },

  starter: {
    id: 'starter',
    name: 'Starter',
    rank: TIER_RANK.starter,
    quotas: { posts: 30, ai_calls: 100, leads: 500 },
    features: { socials: 3, seats: 1, video: 0, white_label: false },
    priceMonthlyGbp: 29,
    priceYearlyGbp: 290,
    stripePriceMonthly: process.env.STRIPE_PRICE_STARTER_MONTHLY || null,
    stripePriceYearly:  process.env.STRIPE_PRICE_STARTER_YEARLY  || null,
  },

  pro: {
    id: 'pro',
    name: 'Pro',
    rank: TIER_RANK.pro,
    quotas: { posts: 120, ai_calls: 500, leads: 5000 },
    features: { socials: 10, seats: 1, video: 5, white_label: false },
    priceMonthlyGbp: 79,
    priceYearlyGbp: 790,
    stripePriceMonthly: process.env.STRIPE_PRICE_PRO_MONTHLY || null,
    stripePriceYearly:  process.env.STRIPE_PRICE_PRO_YEARLY  || null,
  },

  agency: {
    id: 'agency',
    name: 'Agency',
    rank: TIER_RANK.agency,
    // Unlimited = -1 sentinel so the middleware can short-circuit.
    quotas: { posts: -1, ai_calls: -1, leads: 50000 },
    features: { socials: 50, seats: 5, video: 50, white_label: true },
    priceMonthlyGbp: 199,
    priceYearlyGbp: 1990,
    stripePriceMonthly: process.env.STRIPE_PRICE_AGENCY_MONTHLY || null,
    stripePriceYearly:  process.env.STRIPE_PRICE_AGENCY_YEARLY  || null,
  },

  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    rank: TIER_RANK.enterprise,
    // Quotas managed manually via the admin tools / contract terms.
    quotas: { posts: -1, ai_calls: -1, leads: -1 },
    features: { socials: -1, seats: -1, video: -1, white_label: true, sso: true, sla: true },
    priceMonthlyGbp: null,    // custom
    priceYearlyGbp: null,
    stripePriceMonthly: null,
    stripePriceYearly: null,
  },
};

const TRIAL_DAYS = 14;

function getPlan(planId) {
  return PLANS[planId] || PLANS.free;
}

function isUnlimited(quotaValue) {
  return quotaValue === -1;
}

/** True if `actualPlan` meets or exceeds `minPlan` (e.g. requirePlan('pro')). */
function meetsTier(actualPlan, minPlan) {
  return getPlan(actualPlan).rank >= getPlan(minPlan).rank;
}

/**
 * Resolve a Stripe price id for a (planId, interval) pair. Returns null if
 * the plan isn't billable on Stripe (free / enterprise) or the env var
 * isn't configured.
 */
function priceIdFor(planId, interval) {
  const plan = getPlan(planId);
  if (interval === 'yearly')  return plan.stripePriceYearly;
  if (interval === 'monthly') return plan.stripePriceMonthly;
  return null;
}

/** Reverse lookup: given a Stripe price id, return the plan it belongs to. */
function planForPriceId(priceId) {
  if (!priceId) return null;
  for (const plan of Object.values(PLANS)) {
    if (plan.stripePriceMonthly === priceId || plan.stripePriceYearly === priceId) {
      return plan.id;
    }
  }
  return null;
}

module.exports = {
  PLANS,
  TIER_RANK,
  TRIAL_DAYS,
  getPlan,
  isUnlimited,
  meetsTier,
  priceIdFor,
  planForPriceId,
};
