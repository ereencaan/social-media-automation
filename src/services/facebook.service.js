const META_API = 'https://graph.facebook.com/v22.0';
const credsService = require('./social-credentials.service');

function resolveCredential(orgId) {
  if (orgId) {
    const row = credsService.getActive(orgId, 'facebook');
    if (row) return { pageId: row.account_id, token: row.access_token, credId: row.id };
  }
  // Legacy single-tenant path
  if (process.env.FACEBOOK_PAGE_ID && process.env.META_ACCESS_TOKEN) {
    return { pageId: process.env.FACEBOOK_PAGE_ID, token: process.env.META_ACCESS_TOKEN, credId: null };
  }
  return null;
}

async function postToFacebook(imageUrl, message, opts = {}) {
  const cred = resolveCredential(opts.orgId);
  if (!cred) throw new Error('No Facebook credential — connect Facebook in Settings → Connections');

  try {
    const res = await fetch(`${META_API}/${cred.pageId}/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: imageUrl, message, access_token: cred.token }),
    });
    const result = await res.json();
    if (result.error) throw new Error(`Facebook error: ${result.error.message}`);
    return { postId: result.post_id || result.id, platform: 'facebook' };
  } catch (err) {
    if (cred.credId && /OAuthException|token|expired|invalid/i.test(err.message)) {
      credsService.markNeedsReauth(cred.credId, err.message);
    }
    throw err;
  }
}

module.exports = { postToFacebook };
