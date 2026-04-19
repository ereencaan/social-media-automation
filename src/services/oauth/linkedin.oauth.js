// LinkedIn OAuth 2.0 (OIDC) flow.
//
// We ask for:
//   - openid / profile / email — to learn who the user is
//   - w_member_social          — permission to post on their behalf
//
// LinkedIn's token endpoint returns refresh_token when the "Share on
// LinkedIn" product is enabled on the app (and the user grants). Access
// tokens last 60 days, refresh tokens 1 year.

const AUTH_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';

const SCOPES = ['openid', 'profile', 'email', 'w_member_social'];

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function getClientId()     { return env('LINKEDIN_CLIENT_ID'); }
function getClientSecret() { return env('LINKEDIN_CLIENT_SECRET'); }

function getRedirectUri() {
  // Dev: http://localhost:3000/api/connect/linkedin/callback
  // Set LINKEDIN_REDIRECT_URI in prod to your HTTPS URL.
  return process.env.LINKEDIN_REDIRECT_URI
      || `${process.env.APP_BASE_URL || 'http://localhost:3000'}/api/connect/linkedin/callback`;
}

/** Build the URL we redirect the user to. `state` must be set by caller. */
function buildAuthorizeUrl(state) {
  const u = new URL(AUTH_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', getClientId());
  u.searchParams.set('redirect_uri', getRedirectUri());
  u.searchParams.set('scope', SCOPES.join(' '));
  u.searchParams.set('state', state);
  return u.toString();
}

/** Exchange the authorization code for tokens. */
async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: getRedirectUri(),
    client_id: getClientId(),
    client_secret: getClientSecret(),
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`LinkedIn token exchange failed: ${res.status} ${JSON.stringify(data)}`);
  // Shape: { access_token, expires_in, refresh_token?, refresh_token_expires_in?, scope }
  return data;
}

/** Refresh an access token using the refresh_token. */
async function refreshToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: getClientId(),
    client_secret: getClientSecret(),
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`LinkedIn refresh failed: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

/** Fetch the user's profile so we can store a nice display name. */
async function fetchUserInfo(accessToken) {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`LinkedIn userinfo failed: ${res.status} ${JSON.stringify(data)}`);
  // Shape: { sub (the stable URN suffix), name, given_name, family_name, email, picture }
  return data;
}

module.exports = {
  SCOPES,
  buildAuthorizeUrl,
  exchangeCode,
  refreshToken,
  fetchUserInfo,
  getRedirectUri,
};
