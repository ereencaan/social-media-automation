// Social connection routes — OAuth start + callback + list + disconnect.
// All routes are mounted behind requireAuth (see src/app.js) so req.user.orgId
// is trusted.

const express = require('express');
const router = express.Router();
const state = require('../services/oauth/state');
const linkedinOAuth = require('../services/oauth/linkedin.oauth');
const metaOAuth     = require('../services/oauth/meta.oauth');
const credsService  = require('../services/social-credentials.service');

function feBase(req) {
  return process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

// After OAuth completes (success or failure) we land the user back on this
// relative path so the SPA can show them the outcome.
function uiCallbackUrl(req, outcome) {
  return `${feBase(req)}/#settings/connections?${new URLSearchParams(outcome).toString()}`;
}

// ---- List every connection this org has ---------------------------------
router.get('/', (req, res) => {
  const rows = credsService.listForOrg(req.user.orgId).map(credsService.presentSafe);
  res.json(rows);
});

// ---- Disconnect ----------------------------------------------------------
router.delete('/:id', (req, res) => {
  const ok = credsService.remove(req.params.id, req.user.orgId);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// =========================================================================
//   LinkedIn
// =========================================================================
router.get('/linkedin/start', (req, res) => {
  try {
    const token = state.create(req, { platform: 'linkedin', orgId: req.user.orgId });
    const url = linkedinOAuth.buildAuthorizeUrl(token);
    // Returning a URL is friendlier than 302 for SPAs. Client does window.location = url.
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/linkedin/callback', async (req, res) => {
  try {
    if (req.query.error) {
      return res.redirect(uiCallbackUrl(req, { platform: 'linkedin', status: 'error', reason: req.query.error_description || req.query.error }));
    }
    const { platform, orgId } = state.verifyAndConsume(req, req.query.state);
    if (platform !== 'linkedin') throw new Error('State platform mismatch');

    const token = await linkedinOAuth.exchangeCode(req.query.code);
    // Look up the user so we can show a nice "connected as @john" in the UI
    let userInfo = null;
    try { userInfo = await linkedinOAuth.fetchUserInfo(token.access_token); } catch {}

    const expiresAt = token.expires_in
      ? new Date(Date.now() + token.expires_in * 1000).toISOString()
      : null;
    const refreshExpiresAt = token.refresh_token_expires_in
      ? new Date(Date.now() + token.refresh_token_expires_in * 1000).toISOString()
      : null;

    credsService.upsert(orgId, 'linkedin', {
      account_id:         userInfo?.sub || null,
      account_name:       userInfo?.name || null,
      account_handle:     userInfo?.email || null,
      account_avatar_url: userInfo?.picture || null,
      access_token:       token.access_token,
      refresh_token:      token.refresh_token || null,
      token_type:         token.token_type || 'bearer',
      expires_at:         expiresAt,
      refresh_expires_at: refreshExpiresAt,
      scopes:             token.scope || linkedinOAuth.SCOPES.join(' '),
    });
    res.redirect(uiCallbackUrl(req, { platform: 'linkedin', status: 'ok' }));
  } catch (err) {
    console.error('[connect/linkedin/callback]', err);
    res.redirect(uiCallbackUrl(req, { platform: 'linkedin', status: 'error', reason: err.message }));
  }
});

// =========================================================================
//   Meta (Facebook + Instagram together)
// =========================================================================
router.get('/meta/start', (req, res) => {
  try {
    const token = state.create(req, { platform: 'meta', orgId: req.user.orgId });
    const url = metaOAuth.buildAuthorizeUrl(token);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/meta/callback', async (req, res) => {
  try {
    if (req.query.error) {
      return res.redirect(uiCallbackUrl(req, { platform: 'meta', status: 'error', reason: req.query.error_description || req.query.error }));
    }
    const { platform, orgId } = state.verifyAndConsume(req, req.query.state);
    if (platform !== 'meta') throw new Error('State platform mismatch');

    const result = await metaOAuth.finishOAuthFromCode(req.query.code);

    // Upsert one row per FB page + one per linked IG account
    for (const c of result.credentials) {
      credsService.upsert(orgId, c.platform, c);
    }

    const count = result.credentials.length;
    if (!count) {
      return res.redirect(uiCallbackUrl(req, {
        platform: 'meta', status: 'error',
        reason: 'No Facebook pages found. You need a Facebook Page to post via this app.',
      }));
    }
    res.redirect(uiCallbackUrl(req, { platform: 'meta', status: 'ok', count: String(count) }));
  } catch (err) {
    console.error('[connect/meta/callback]', err);
    res.redirect(uiCallbackUrl(req, { platform: 'meta', status: 'error', reason: err.message }));
  }
});

module.exports = router;
