// Public billing endpoints — no auth required.
// Mounted at /api/public/billing.
//
// Only exposes the read-only plans catalog (for the /pricing page,
// pre-signup). Anything that mutates state lives in billing.routes.js
// behind requireAuth.

const express = require('express');
const router = express.Router();
const { PLANS } = require('../config/plans');

router.get('/plans', (req, res) => {
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

module.exports = router;
