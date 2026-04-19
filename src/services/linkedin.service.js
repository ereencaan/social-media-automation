const LINKEDIN_API = 'https://api.linkedin.com';
const credsService = require('./social-credentials.service');

async function getLinkedInPersonId(token) {
  const res = await fetch(`${LINKEDIN_API}/v2/userinfo`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await res.json();
  if (!data.sub) throw new Error(`LinkedIn userinfo error: ${JSON.stringify(data)}`);
  return data.sub;
}

function resolveCredential(callerOrgId) {
  if (callerOrgId) {
    const row = credsService.getActive(callerOrgId, 'linkedin');
    if (row) return {
      token: row.access_token,
      personUrnSuffix: row.account_id || null,
      orgId: null,
      credId: row.id,
    };
  }
  if (process.env.LINKEDIN_ACCESS_TOKEN) {
    return {
      token: process.env.LINKEDIN_ACCESS_TOKEN,
      personUrnSuffix: null,
      orgId: process.env.LINKEDIN_ORGANIZATION_ID || null,
      credId: null,
    };
  }
  return null;
}

async function postToLinkedIn(imageUrl, text, opts = {}) {
  const cred = resolveCredential(opts.orgId);
  if (!cred) throw new Error('No LinkedIn credential — connect LinkedIn in Settings → Connections');
  const token = cred.token;
  const orgId = cred.orgId;

  // Determine author. If the DB credential already captured the person URN,
  // use that. Otherwise try organization (legacy env flow) then fallback.
  let author;
  try {
    if (cred.personUrnSuffix) {
      author = `urn:li:person:${cred.personUrnSuffix}`;
    } else if (orgId) {
      author = `urn:li:organization:${orgId}`;
      const testRes = await fetch(`${LINKEDIN_API}/rest/images?action=initializeUpload`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'LinkedIn-Version': '202401',
          'X-Restli-Protocol-Version': '2.0.0',
        },
        body: JSON.stringify({ initializeUploadRequest: { owner: author } }),
      });
      if (!testRes.ok) {
        const personId = await getLinkedInPersonId(token);
        author = `urn:li:person:${personId}`;
      } else {
        const registerData = await testRes.json();
        const { uploadUrl, image: imageUrn } = registerData.value;
        return await completeLinkedInPost(token, author, imageUrl, text, uploadUrl, imageUrn);
      }
    } else {
      const personId = await getLinkedInPersonId(token);
      author = `urn:li:person:${personId}`;
    }
  } catch {
    const personId = await getLinkedInPersonId(token);
    author = `urn:li:person:${personId}`;
  }

  // 1. Register image upload
  const registerRes = await fetch(`${LINKEDIN_API}/rest/images?action=initializeUpload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'LinkedIn-Version': '202401',
      'X-Restli-Protocol-Version': '2.0.0'
    },
    body: JSON.stringify({
      initializeUploadRequest: { owner: author }
    })
  });

  const registerData = await registerRes.json();
  if (!registerData.value) throw new Error(`LinkedIn register error: ${JSON.stringify(registerData)}`);

  const { uploadUrl, image: imageUrn } = registerData.value;
  try {
    return await completeLinkedInPost(token, author, imageUrl, text, uploadUrl, imageUrn);
  } catch (err) {
    if (cred.credId && /401|invalid_token|expired|REVOKED_ACCESS_TOKEN/i.test(err.message)) {
      credsService.markNeedsReauth(cred.credId, err.message);
    }
    throw err;
  }
}

async function completeLinkedInPost(token, author, imageUrl, text, uploadUrl, imageUrn) {
  // 2. Download image and upload to LinkedIn
  const imageRes = await fetch(imageUrl);
  const imageBuffer = await imageRes.arrayBuffer();

  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'image/jpeg'
    },
    body: Buffer.from(imageBuffer)
  });

  if (!uploadRes.ok) throw new Error(`LinkedIn upload error: ${uploadRes.status}`);

  // 3. Create post
  const postRes = await fetch(`${LINKEDIN_API}/rest/posts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'LinkedIn-Version': '202401',
      'X-Restli-Protocol-Version': '2.0.0'
    },
    body: JSON.stringify({
      author,
      commentary: text,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: []
      },
      content: {
        media: {
          title: 'Post Image',
          id: imageUrn
        }
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false
    })
  });

  if (!postRes.ok) {
    const err = await postRes.text();
    throw new Error(`LinkedIn post error: ${err}`);
  }

  const postId = postRes.headers.get('x-restli-id');
  return { postId, platform: 'linkedin' };
}

module.exports = { postToLinkedIn };
