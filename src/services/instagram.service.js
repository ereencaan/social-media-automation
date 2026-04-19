// Instagram publishing via Meta Graph API.
// Reads the target account's token from the DB (social_credentials) so each
// customer publishes to THEIR OWN Instagram. Falls back to legacy env vars
// for local single-tenant dev use.

const META_API = 'https://graph.facebook.com/v22.0';
const credsService = require('./social-credentials.service');

function resolveCredential(orgId) {
  if (orgId) {
    const row = credsService.getActive(orgId, 'instagram');
    if (row) {
      return { accountId: row.account_id, token: row.access_token, credId: row.id };
    }
  }
  // Legacy single-tenant path
  if (process.env.INSTAGRAM_ACCOUNT_ID && process.env.META_ACCESS_TOKEN) {
    return {
      accountId: process.env.INSTAGRAM_ACCOUNT_ID,
      token:     process.env.META_ACCESS_TOKEN,
      credId:    null,
    };
  }
  return null;
}

async function postToInstagram(imageUrl, caption, opts = {}) {
  const cred = resolveCredential(opts.orgId);
  if (!cred) throw new Error('No Instagram credential — connect Instagram in Settings → Connections');

  try {
    // 1. Create media container
    const containerRes = await fetch(`${META_API}/${cred.accountId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: imageUrl, caption, access_token: cred.token }),
    });
    const container = await containerRes.json();
    if (container.error) throw new Error(`Instagram container error: ${container.error.message}`);

    // 2. Wait for container to be ready
    await waitForContainer(cred.accountId, container.id, cred.token);

    // 3. Publish
    const publishRes = await fetch(`${META_API}/${cred.accountId}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creation_id: container.id, access_token: cred.token }),
    });
    const result = await publishRes.json();
    if (result.error) throw new Error(`Instagram publish error: ${result.error.message}`);
    return { postId: result.id, platform: 'instagram' };
  } catch (err) {
    // If the API told us the token is bad, flag the credential so the UI
    // can prompt the user to reconnect.
    if (cred.credId && /OAuthException|token|expired|invalid/i.test(err.message)) {
      credsService.markNeedsReauth(cred.credId, err.message);
    }
    throw err;
  }
}

async function waitForContainer(accountId, containerId, token, maxAttempts = 15) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(`${META_API}/${containerId}?fields=status_code&access_token=${token}`);
    const data = await res.json();
    if (data.status_code === 'FINISHED') return;
    if (data.status_code === 'ERROR') throw new Error('Instagram container processing failed');
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Instagram container timeout');
}

module.exports = { postToInstagram };
