const LINKEDIN_API = 'https://api.linkedin.com';

async function getLinkedInPersonId(token) {
  const res = await fetch(`${LINKEDIN_API}/v2/userinfo`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await res.json();
  if (!data.sub) throw new Error(`LinkedIn userinfo error: ${JSON.stringify(data)}`);
  return data.sub;
}

async function postToLinkedIn(imageUrl, text) {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  const orgId = process.env.LINKEDIN_ORGANIZATION_ID;

  // Determine author: use organization if w_organization_social scope available, else personal profile
  let author;
  try {
    // Try organization first
    author = `urn:li:organization:${orgId}`;
    const testRes = await fetch(`${LINKEDIN_API}/rest/images?action=initializeUpload`, {
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

    if (!testRes.ok) {
      // Fallback to personal profile
      const personId = await getLinkedInPersonId(token);
      author = `urn:li:person:${personId}`;
    } else {
      // Organization upload worked, use that response
      const registerData = await testRes.json();
      const { uploadUrl, image: imageUrn } = registerData.value;
      return await completeLinkedInPost(token, author, imageUrl, text, uploadUrl, imageUrn);
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
  return await completeLinkedInPost(token, author, imageUrl, text, uploadUrl, imageUrn);
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
