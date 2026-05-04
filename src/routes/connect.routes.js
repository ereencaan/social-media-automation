// Social connection routes — OAuth start + callback + list + disconnect.
// All routes are mounted behind requireAuth (see src/app.js) so req.user.orgId
// is trusted.

const express = require('express');
const router = express.Router();
const state = require('../services/oauth/state');
const linkedinOAuth = require('../services/oauth/linkedin.oauth');
const metaOAuth     = require('../services/oauth/meta.oauth');
const tiktokOAuth   = require('../services/oauth/tiktok.oauth');
const youtubeOAuth  = require('../services/oauth/youtube.oauth');
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

// =========================================================================
//   TikTok (Login Kit + Content Posting API — Inbox mode for sandbox apps)
// =========================================================================
router.get('/tiktok/start', (req, res) => {
  try {
    // Surface a friendly message when the operator hasn't wired the TikTok
    // app credentials yet. Saves a confusing "TIKTOK_CLIENT_KEY is not set"
    // crash on the client.
    if (!process.env.TIKTOK_CLIENT_KEY || !process.env.TIKTOK_CLIENT_SECRET) {
      return res.status(503).json({
        error: 'TikTok integration is not configured on this server. Set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET.',
      });
    }
    const stateToken = state.create(req, { platform: 'tiktok', orgId: req.user.orgId });
    const url = tiktokOAuth.buildAuthorizeUrl(stateToken);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/tiktok/callback', async (req, res) => {
  try {
    if (req.query.error) {
      return res.redirect(uiCallbackUrl(req, {
        platform: 'tiktok', status: 'error',
        reason: req.query.error_description || req.query.error,
      }));
    }
    const { platform, orgId } = state.verifyAndConsume(req, req.query.state);
    if (platform !== 'tiktok') throw new Error('State platform mismatch');

    const token = await tiktokOAuth.exchangeCode(req.query.code);

    // open_id is the stable per-app user identifier — that's what we pin
    // the credential row on (so reconnects update the same row).
    let userInfo = null;
    try { userInfo = await tiktokOAuth.fetchUserInfo(token.access_token); } catch (_) { /* non-fatal */ }

    const expiresAt = token.expires_in
      ? new Date(Date.now() + token.expires_in * 1000).toISOString()
      : null;
    const refreshExpiresAt = token.refresh_expires_in
      ? new Date(Date.now() + token.refresh_expires_in * 1000).toISOString()
      : null;

    credsService.upsert(orgId, 'tiktok', {
      account_id:         token.open_id || (userInfo && userInfo.open_id) || null,
      account_name:       (userInfo && userInfo.display_name) || null,
      account_handle:     (userInfo && userInfo.username) ? `@${userInfo.username}` : null,
      account_avatar_url: (userInfo && userInfo.avatar_url) || null,
      access_token:       token.access_token,
      refresh_token:      token.refresh_token || null,
      token_type:         token.token_type || 'Bearer',
      expires_at:         expiresAt,
      refresh_expires_at: refreshExpiresAt,
      scopes:             token.scope || tiktokOAuth.SCOPES.join(','),
    });

    res.redirect(uiCallbackUrl(req, { platform: 'tiktok', status: 'ok' }));
  } catch (err) {
    console.error('[connect/tiktok/callback]', err);
    res.redirect(uiCallbackUrl(req, {
      platform: 'tiktok', status: 'error', reason: err.message,
    }));
  }
});

// =========================================================================
//   YouTube (Google OAuth + YouTube Data API v3 — upload Shorts)
// =========================================================================
router.get('/youtube/start', (req, res) => {
  try {
    if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
      return res.status(503).json({
        error: 'YouTube integration is not configured on this server. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.',
      });
    }
    const stateToken = state.create(req, { platform: 'youtube', orgId: req.user.orgId });
    const url = youtubeOAuth.buildAuthorizeUrl(stateToken);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/youtube/callback', async (req, res) => {
  try {
    if (req.query.error) {
      return res.redirect(uiCallbackUrl(req, {
        platform: 'youtube', status: 'error',
        reason: req.query.error_description || req.query.error,
      }));
    }
    const { platform, orgId } = state.verifyAndConsume(req, req.query.state);
    if (platform !== 'youtube') throw new Error('State platform mismatch');

    const token = await youtubeOAuth.exchangeCode(req.query.code);

    // Fetch the user's YouTube channel for the display card. Some Google
    // accounts have no channel yet — surface that as a clear error rather
    // than silently storing a credential the upload flow can't use.
    let channel = null;
    try { channel = await youtubeOAuth.fetchChannelInfo(token.access_token); } catch (_) { /* non-fatal */ }
    if (!channel) {
      return res.redirect(uiCallbackUrl(req, {
        platform: 'youtube', status: 'error',
        reason: 'No YouTube channel found on this Google account. Create one at youtube.com first, then reconnect.',
      }));
    }

    const expiresAt = token.expires_in
      ? new Date(Date.now() + token.expires_in * 1000).toISOString()
      : null;

    credsService.upsert(orgId, 'youtube', {
      account_id:         channel.id,
      account_name:       channel.title || null,
      account_handle:     channel.handle || null,
      account_avatar_url: channel.thumbnail || null,
      access_token:       token.access_token,
      // Google only returns refresh_token on the first consent (with
      // prompt=consent forcing it). If we somehow got an empty one we
      // null it out so the refresh flow loudly fails rather than
      // sending an empty string to the token endpoint.
      refresh_token:      token.refresh_token || null,
      token_type:         token.token_type || 'Bearer',
      expires_at:         expiresAt,
      refresh_expires_at: null, // Google refresh tokens don't expire on a fixed clock
      scopes:             token.scope || youtubeOAuth.SCOPES.join(' '),
    });

    res.redirect(uiCallbackUrl(req, { platform: 'youtube', status: 'ok' }));
  } catch (err) {
    console.error('[connect/youtube/callback]', err);
    res.redirect(uiCallbackUrl(req, {
      platform: 'youtube', status: 'error', reason: err.message,
    }));
  }
});

module.exports = router;
