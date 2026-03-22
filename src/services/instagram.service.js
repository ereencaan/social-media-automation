const META_API = 'https://graph.facebook.com/v21.0';

async function postToInstagram(imageUrl, caption) {
  const accountId = process.env.INSTAGRAM_ACCOUNT_ID;
  const token = process.env.META_ACCESS_TOKEN;

  // 1. Create media container
  const containerRes = await fetch(`${META_API}/${accountId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_url: imageUrl,
      caption,
      access_token: token
    })
  });

  const container = await containerRes.json();
  if (container.error) throw new Error(`Instagram container error: ${container.error.message}`);

  // 2. Wait for container to be ready (can take a few seconds)
  await waitForContainer(accountId, container.id, token);

  // 3. Publish
  const publishRes = await fetch(`${META_API}/${accountId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      creation_id: container.id,
      access_token: token
    })
  });

  const result = await publishRes.json();
  if (result.error) throw new Error(`Instagram publish error: ${result.error.message}`);

  return { postId: result.id, platform: 'instagram' };
}

async function waitForContainer(accountId, containerId, token, maxAttempts = 15) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(
      `${META_API}/${containerId}?fields=status_code&access_token=${token}`
    );
    const data = await res.json();

    if (data.status_code === 'FINISHED') return;
    if (data.status_code === 'ERROR') throw new Error('Instagram container processing failed');

    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Instagram container timeout');
}

module.exports = { postToInstagram };
