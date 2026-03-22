const META_API = 'https://graph.facebook.com/v21.0';

async function postToFacebook(imageUrl, message) {
  const pageId = process.env.FACEBOOK_PAGE_ID;
  const token = process.env.META_ACCESS_TOKEN;

  const res = await fetch(`${META_API}/${pageId}/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: imageUrl,
      message,
      access_token: token
    })
  });

  const result = await res.json();
  if (result.error) throw new Error(`Facebook error: ${result.error.message}`);

  return { postId: result.post_id || result.id, platform: 'facebook' };
}

module.exports = { postToFacebook };
