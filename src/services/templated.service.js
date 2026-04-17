const TEMPLATED_API = 'https://api.templated.io/v1';

function getHeaders() {
  if (!process.env.TEMPLATED_API_KEY) throw new Error('TEMPLATED_API_KEY is not set in .env');
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.TEMPLATED_API_KEY}`
  };
}

// Platform-specific sizes
const PLATFORM_SIZES = {
  instagram: { width: 1080, height: 1080 },
  'instagram-story': { width: 1080, height: 1920 },
  facebook: { width: 1200, height: 630 },
  linkedin: { width: 1200, height: 627 },
  default: { width: 1080, height: 1080 }
};

/**
 * List available templates from your Templated.io account
 */
async function listTemplates() {
  const res = await fetch(`${TEMPLATED_API}/templates`, {
    headers: getHeaders()
  });
  if (!res.ok) throw new Error(`Templated list error: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Render an image from a template
 * @param {string} templateId - Templated.io template ID
 * @param {object} layers - Layer overrides (text, images, etc.)
 * @param {object} options - Additional options (format, width, height)
 */
async function renderTemplate(templateId, layers = {}, options = {}) {
  const platform = options.platform || 'default';
  const size = PLATFORM_SIZES[platform] || PLATFORM_SIZES.default;

  const body = {
    template: templateId,
    layers,
    format: options.format || 'jpg',
    ...(options.width ? { width: options.width } : { width: size.width }),
    ...(options.height ? { height: options.height } : { height: size.height })
  };

  const res = await fetch(`${TEMPLATED_API}/render`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error(`Templated render error: ${res.status} ${await res.text()}`);
  const data = await res.json();

  return {
    url: data.url,
    id: data.id,
    width: data.width,
    height: data.height,
    format: data.format
  };
}

/**
 * Render a video from a template
 * @param {string} templateId - Templated.io template ID
 * @param {object} layers - Layer overrides with animation
 * @param {object} options - Video options (duration, fps)
 */
async function renderVideo(templateId, layers = {}, options = {}) {
  const body = {
    template: templateId,
    layers,
    format: 'mp4',
    duration: options.duration || 15000, // 15 seconds default
    fps: options.fps || 30,
    ...(options.width && { width: options.width }),
    ...(options.height && { height: options.height })
  };

  // Videos are async by default
  body.async = true;
  if (options.webhookUrl) body.webhook_url = options.webhookUrl;

  const res = await fetch(`${TEMPLATED_API}/render`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error(`Templated video error: ${res.status} ${await res.text()}`);
  const data = await res.json();

  // If async, poll for completion
  if (data.status === 'pending' || data.status === 'processing') {
    return await pollRender(data.id);
  }

  return {
    url: data.url,
    id: data.id,
    format: 'mp4'
  };
}

/**
 * Poll for async render completion
 */
async function pollRender(renderId, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(`${TEMPLATED_API}/renders/${renderId}`, {
      headers: getHeaders()
    });
    const data = await res.json();

    if (data.status === 'completed' || data.url) {
      return { url: data.url, id: data.id, format: data.format };
    }
    if (data.status === 'failed') throw new Error(`Templated render failed: ${JSON.stringify(data)}`);

    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('Templated render timeout');
}

module.exports = { listTemplates, renderTemplate, renderVideo, PLATFORM_SIZES };
