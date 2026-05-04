// TikTok Login Kit OAuth 2.0 flow.
//
// Doc: https://developers.tiktok.com/doc/login-kit-web/
//
// We ask for:
//   - user.info.basic   — open_id, union_id, display name, avatar
//   - video.upload      — required to push videos to the user's account
//                         via the Content Posting API in "Inbox" mode
//                         (video lands as a draft for the creator to publish
//                         from their TikTok app). Sandbox-friendly; needs
//                         no audit.
//
// We do NOT ask for `video.publish` here because that scope (which enables
// Direct Post — the video goes live without manual review) requires the
// app to pass TikTok's Production audit. Phase 2 ships with Inbox mode
// today; we can extend SCOPES the day audit clears.
//
// TikTok issues:
//   - access_token   (lifetime 24h)
//   - refresh_token  (lifetime 365d, single-use refresh — every refresh
//                     returns a new refresh token)
//
// The token endpoint accepts the form-encoded body documented at
// https://developers.tiktok.com/doc/login-kit-manage-user-access-tokens/
// and returns JSON shaped roughly like:
//   {
//     access_token, expires_in,
//     refresh_token, refresh_expires_in,
//     open_id, scope, token_type
//   }

const AUTH_URL     = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL    = 'https://open.tiktokapis.com/v2/oauth/token/';
const USERINFO_URL = 'https://open.tiktokapis.com/v2/user/info/';

// `video.upload` is what unlocks the Content Posting API in Inbox mode.
// Adding `video.publish` later (post-audit) lets us drop drafts and
// publish directly. Sandbox apps cannot list `video.publish` until they
// pass audit, so leaving it out keeps the authorize page from erroring.
const SCOPES = ['user.info.basic', 'video.upload'];

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function getClientKey()    { return env('TIKTOK_CLIENT_KEY'); }
function getClientSecret() { return env('TIKTOK_CLIENT_SECRET'); }

function getRedirectUri() {
  // The redirect URI is registered in the TikTok dev portal app config and
  // must match exactly. Production: https://hitrapost.co.uk/api/connect/tiktok/callback
  return process.env.TIKTOK_REDIRECT_URI
      || `${(process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')}/api/connect/tiktok/callback`;
}

/** Build the authorize URL the user is redirected to. */
function buildAuthorizeUrl(state) {
  const u = new URL(AUTH_URL);
  // TikTok's parameter is `client_key` (NOT `client_id` like every other
  // OAuth 2.0 server). Easy mistake — keep this comment.
  u.searchParams.set('client_key', getClientKey());
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPES.join(','));    // comma, not space
  u.searchParams.set('redirect_uri', getRedirectUri());
  u.searchParams.set('state', state);
  return u.toString();
}

/** Exchange the authorization code for tokens. */
async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_key:    getClientKey(),
    client_secret: getClientSecret(),
    code,
    grant_type:    'authorization_code',
    redirect_uri:  getRedirectUri(),
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cache-Control': 'no-cache',
    },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`TikTok token exchange failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

/** Refresh an access token. Single-use refresh — store the new refresh_token. */
async function refreshToken(rt) {
  const body = new URLSearchParams({
    client_key:    getClientKey(),
    client_secret: getClientSecret(),
    grant_type:    'refresh_token',
    refresh_token: rt,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cache-Control': 'no-cache',
    },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`TikTok refresh failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

/** Fetch the user's profile so we can store a display name + avatar. */
async function fetchUserInfo(accessToken) {
  // TikTok requires explicit `fields` query — empty fields = empty response.
  const u = new URL(USERINFO_URL);
  u.searchParams.set('fields', 'open_id,union_id,avatar_url,display_name,username');
  const res = await fetch(u, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`TikTok userinfo failed: ${res.status} ${JSON.stringify(data)}`);
  }
  // Wrapped response: { data: { user: {...} }, error: { code, message, ... } }
  return data.data && data.data.user ? data.data.user : null;
}

module.exports = {
  SCOPES,
  buildAuthorizeUrl,
  exchangeCode,
  refreshToken,
  fetchUserInfo,
  getRedirectUri,
};
