// Meta (Facebook + Instagram) OAuth flow.
//
// One user flow produces credentials for BOTH Facebook pages AND Instagram
// business accounts connected to them. The sequence:
//
//   1. Redirect user to Facebook login / consent.
//   2. Callback gives us a short-lived user access token (1 hour).
//   3. Exchange for a long-lived user token (60 days).
//   4. GET /me/accounts with that long-lived token -> list of pages.
//      Each page comes with its OWN page access token (often
//      never-expiring when derived from a long-lived user token with the
//      right scopes — "pages_show_list", "pages_manage_posts", etc.)
//   5. For each page, GET /{page_id}?fields=instagram_business_account to
//      discover if there's an IG Business account linked.
//   6. We store one row per FB page and one row per linked IG account
//      in social_credentials.

const GRAPH = 'https://graph.facebook.com/v22.0';
const OAUTH_AUTHORIZE = 'https://www.facebook.com/v22.0/dialog/oauth';

// Scopes we request. `business_management` is optional but lets the user
// choose a Business Manager-owned page more reliably.
const SCOPES = [
  'pages_show_list',
  'pages_manage_posts',
  'pages_read_engagement',
  'business_management',
  'instagram_basic',
  'instagram_content_publish',
];

function env(n) { const v = process.env[n]; if (!v) throw new Error(`${n} is not set`); return v; }
function getAppId()     { return env('META_APP_ID'); }
function getAppSecret() { return env('META_APP_SECRET'); }
function getRedirectUri() {
  return process.env.META_REDIRECT_URI
      || `${process.env.APP_BASE_URL || 'http://localhost:3000'}/api/connect/meta/callback`;
}

/** Where to send the user for consent. `state` supplied by caller. */
function buildAuthorizeUrl(state) {
  const u = new URL(OAUTH_AUTHORIZE);
  u.searchParams.set('client_id', getAppId());
  u.searchParams.set('redirect_uri', getRedirectUri());
  u.searchParams.set('state', state);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPES.join(','));
  return u.toString();
}

async function graphGet(path, params = {}) {
  const u = new URL(GRAPH + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u.toString());
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`Meta graph error ${res.status}: ${JSON.stringify(data.error || data)}`);
  return data;
}

/** Step 2 — exchange auth code for a SHORT-lived user access token. */
async function exchangeCode(code) {
  const data = await graphGet('/oauth/access_token', {
    client_id: getAppId(),
    redirect_uri: getRedirectUri(),
    client_secret: getAppSecret(),
    code,
  });
  return data; // { access_token, token_type, expires_in }
}

/** Step 3 — exchange short-lived user token for LONG-lived (60d). */
async function exchangeForLongLived(shortToken) {
  const data = await graphGet('/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: getAppId(),
    client_secret: getAppSecret(),
    fb_exchange_token: shortToken,
  });
  return data; // { access_token, token_type, expires_in (~5184000 = 60d) }
}

/** Refresh a still-valid long-lived token for another 60 days. */
async function refreshLongLived(currentLongLivedToken) {
  return exchangeForLongLived(currentLongLivedToken);
}

/** Step 4 — list the pages this user manages, each with its own page token. */
async function fetchPages(userAccessToken) {
  const data = await graphGet('/me/accounts', {
    access_token: userAccessToken,
    fields: 'id,name,username,access_token,category,tasks,picture{url}',
  });
  return (data.data || []);
}

/** Step 5 — does this page have an IG Business account linked? */
async function fetchInstagramBusinessAccount(pageId, pageAccessToken) {
  try {
    const data = await graphGet(`/${pageId}`, {
      access_token: pageAccessToken,
      fields: 'instagram_business_account{id,username,name,profile_picture_url}',
    });
    return data.instagram_business_account || null;
  } catch {
    return null;
  }
}

/** One-shot "finish the OAuth" — returns a structured list of credentials to persist. */
async function finishOAuthFromCode(code) {
  const short = await exchangeCode(code);
  const long  = await exchangeForLongLived(short.access_token);

  const pages = await fetchPages(long.access_token);
  const expiresAt = long.expires_in
    ? new Date(Date.now() + (long.expires_in * 1000)).toISOString()
    : null;

  const credentialsToSave = [];
  for (const p of pages) {
    // FB page credential — page_access_token (can be non-expiring when
    // derived from a long-lived user token with the right scopes).
    credentialsToSave.push({
      platform: 'facebook',
      account_id:         p.id,
      account_name:       p.name,
      account_handle:     p.username || null,
      account_avatar_url: p.picture?.data?.url || null,
      access_token:       p.access_token,
      token_type:         'page',
      expires_at:         null,   // page tokens don't expire in this setup
      scopes:             SCOPES.join(' '),
    });

    // If there's an IG business account on this page, store it too.
    const ig = await fetchInstagramBusinessAccount(p.id, p.access_token);
    if (ig && ig.id) {
      credentialsToSave.push({
        platform: 'instagram',
        account_id:         ig.id,
        account_name:       ig.name || ig.username || null,
        account_handle:     ig.username || null,
        account_avatar_url: ig.profile_picture_url || null,
        // IG Graph API uses the parent page's access token
        access_token:       p.access_token,
        token_type:         'page',
        expires_at:         null,
        scopes:             SCOPES.join(' '),
      });
    }
  }

  return {
    userToken:   long.access_token,
    userExpiresAt: expiresAt,
    credentials: credentialsToSave,
  };
}

module.exports = {
  SCOPES,
  buildAuthorizeUrl,
  exchangeCode,
  exchangeForLongLived,
  refreshLongLived,
  fetchPages,
  fetchInstagramBusinessAccount,
  finishOAuthFromCode,
  getRedirectUri,
};
