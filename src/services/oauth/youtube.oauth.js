// Google OAuth 2.0 flow for YouTube Data API v3.
//
// Doc: https://developers.google.com/identity/protocols/oauth2/web-server
//      https://developers.google.com/youtube/v3/docs/channels/list
//
// We ask for:
//   - openid / email / profile  — minimum identity (display name, avatar)
//   - youtube.readonly          — read the channel's public details so the
//                                  Settings → Connections card can show
//                                  "@channelHandle" and the channel thumb
//   - youtube.upload            — upload videos / Shorts to the channel
//
// Google issues both an access token (1h) and — when access_type=offline +
// prompt=consent are set on the authorize URL — a refresh token that
// survives indefinitely (until revoked). We persist both so we don't
// have to bounce the user through OAuth on every upload.
//
// Quota note: the YouTube Data API has a default 10,000 units/day quota.
// videos.insert costs 1,600 units, so out of the box we get ~6 uploads
// per day across all customers using this app's project. Production
// usage will require a quota-increase request to Google before we can
// onboard real volume.

const AUTH_URL    = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL   = 'https://oauth2.googleapis.com/token';
const CHANNEL_URL = 'https://www.googleapis.com/youtube/v3/channels';

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.upload',
];

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function getClientId()     { return env('GOOGLE_OAUTH_CLIENT_ID'); }
function getClientSecret() { return env('GOOGLE_OAUTH_CLIENT_SECRET'); }

function getRedirectUri() {
  // Must match exactly the URI registered in the Google Cloud Console
  // OAuth client. Override per-environment via env if needed.
  return process.env.GOOGLE_OAUTH_REDIRECT_URI
      || `${(process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')}/api/connect/youtube/callback`;
}

/** Build the authorize URL. Forces consent screen so we always get a refresh_token. */
function buildAuthorizeUrl(state) {
  const u = new URL(AUTH_URL);
  u.searchParams.set('client_id', getClientId());
  u.searchParams.set('redirect_uri', getRedirectUri());
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPES.join(' '));        // space-separated for Google
  u.searchParams.set('state', state);
  // access_type=offline returns a refresh_token; prompt=consent forces the
  // consent screen so we get a fresh refresh_token even if the user
  // previously authorised the app (Google otherwise omits refresh_token
  // on subsequent grants and the upload flow eventually 401s).
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'true');
  return u.toString();
}

/** Exchange the authorization code for tokens. */
async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id:     getClientId(),
    client_secret: getClientSecret(),
    code,
    grant_type:    'authorization_code',
    redirect_uri:  getRedirectUri(),
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Google token exchange failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

/** Refresh an access token using a stored refresh_token. */
async function refreshToken(rt) {
  const body = new URLSearchParams({
    client_id:     getClientId(),
    client_secret: getClientSecret(),
    grant_type:    'refresh_token',
    refresh_token: rt,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Google refresh failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Fetch the connecting user's YouTube channel so we can display a name +
 * thumbnail in the connection card. Returns null if the account has no
 * channel (e.g. brand-new Google account that hasn't created one yet).
 *
 * Channel id is stable per channel — that's what we pin the credential
 * row on, so reconnects update the same row.
 */
async function fetchChannelInfo(accessToken) {
  const u = new URL(CHANNEL_URL);
  u.searchParams.set('part', 'snippet,contentDetails');
  u.searchParams.set('mine', 'true');
  const res = await fetch(u, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`YouTube channels.list failed: ${res.status} ${JSON.stringify(data)}`);
  }
  if (!data.items || !data.items.length) return null;
  const ch = data.items[0];
  return {
    id:          ch.id,
    title:       ch.snippet && ch.snippet.title,
    handle:      ch.snippet && ch.snippet.customUrl, // "@channelhandle"
    description: ch.snippet && ch.snippet.description,
    thumbnail:   ch.snippet && ch.snippet.thumbnails
                  && (ch.snippet.thumbnails.medium || ch.snippet.thumbnails.default || {}).url,
    country:     ch.snippet && ch.snippet.country,
  };
}

module.exports = {
  SCOPES,
  buildAuthorizeUrl,
  exchangeCode,
  refreshToken,
  fetchChannelInfo,
  getRedirectUri,
};
