const LINKEDIN_API = 'https://api.linkedin.com';

async function postToLinkedIn(imageUrl, text) {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  const orgId = process.env.LINKEDIN_ORGANIZATION_ID;

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
      initializeUploadRequest: {
        owner: `urn:li:organization:${orgId}`
      }
    })
  });

  const registerData = await registerRes.json();
  if (!registerData.value) throw new Error(`LinkedIn register error: ${JSON.stringify(registerData)}`);

  const { uploadUrl, image: imageUrn } = registerData.value;

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
      author: `urn:li:organization:${orgId}`,
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
