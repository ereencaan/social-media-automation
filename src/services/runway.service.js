const https = require('https');

const RUNWAY_API = 'https://api.dev.runwayml.com/v1';

function getKey() {
  if (!process.env.RUNWAY_API_KEY) throw new Error('Video generation requires a Runway API key. Get one at dev.runwayml.com and add RUNWAY_API_KEY to .env');
  return process.env.RUNWAY_API_KEY;
}

const RATIOS = {
  instagram:      '720:1280',
  facebook:       '1280:720',
  linkedin:       '1280:720',
  // Same 9:16 vertical that IG Reels uses — TikTok and YouTube Shorts
  // share the spec, so the orchestrator's per-platform pass can ask
  // Runway for one render that satisfies all three.
  tiktok:         '720:1280',
  youtube_shorts: '720:1280',
  default:        '720:1280',
};

function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const fullPath = `/v1${path}`;
    const options = {
      method,
      hostname: 'api.dev.runwayml.com',
      path: fullPath,
      headers: {
        'Authorization': `Bearer ${getKey()}`,
        'Content-Type': 'application/json',
        'X-Runway-Version': '2024-11-06'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(`Runway API ${res.statusCode}: ${data}`));
          else resolve(parsed);
        } catch (e) {
          reject(new Error(`Runway parse error: ${data}`));
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function generateVideo(prompt, platform = 'instagram', duration = 5) {
  const ratio = RATIOS[platform] || RATIOS.default;

  // Runway gen4.5 has a hard time honoring "no text" when the prompt
  // mentions a brand or platform names — it ends up rendering misspelled
  // signage / fake UI screens in-scene. Two-pronged defence:
  //   1. Strip brand/platform tokens from the incoming prompt
  //      (defence-in-depth — Claude sometimes slips brand names back in).
  //   2. Compact no-text directive bolted to the end so we don't bust
  //      Runway's 1000-char promptText cap. The brand logo + contact
  //      strip are added as a video-overlay pass *after* Runway, so we
  //      want a clean visual canvas underneath.
  const SUFFIX = ' Photorealistic, cinematic. NO text, NO letters, NO logos, NO watermarks, NO mockup UI on any screen.';
  const HARD_CAP = 1000;
  let sanitised = stripBrandTokens(prompt);
  // Reserve room for the suffix; trim the prompt body if it would push us
  // past Runway's 1000-char ceiling. Trimming on a sentence boundary
  // when possible so we don't end mid-clause.
  const room = HARD_CAP - SUFFIX.length;
  if (sanitised.length > room) {
    const cut = sanitised.lastIndexOf('.', room);
    sanitised = sanitised.slice(0, cut > room - 200 ? cut + 1 : room).trim();
  }
  const promptText = sanitised + SUFFIX;

  console.log('[Runway] generateVideo start ratio=%s duration=%s', ratio, duration);
  const task = await apiRequest('POST', '/text_to_video', {
    model: 'gen4.5',
    promptText,
    ratio,
    duration,
  });
  console.log('[Runway] task created id=%s', task.id);

  const result = await pollTask(task.id);
  console.log('[Runway] task done id=%s status=%s url=%s', task.id, result.status, result.url ? 'present' : 'missing');
  return result;
}

// Strip the obvious brand-name and platform-name tokens that cause
// Runway to bake misspelled text into the scene. We run this both on
// the caller's pre-processed prompt and inside generateVideo so a
// brand name that slips through Claude is still scrubbed before the
// model sees it. Replaces the token with "the brand" so the sentence
// stays grammatical.
function stripBrandTokens(prompt) {
  if (!prompt || typeof prompt !== 'string') return prompt;
  // Common platform names that also leak into prompts and become fake UI.
  const PLATFORMS = ['Instagram', 'Facebook', 'LinkedIn', 'TikTok', 'YouTube', 'Twitter', 'Threads'];
  let out = prompt;
  // Replace the configured business name (set by caller as RUNWAY_STRIP env)
  // — the env hook lets ops tighten the filter without a redeploy.
  const extra = (process.env.RUNWAY_STRIP_TOKENS || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  for (const token of extra) {
    out = out.replace(new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), 'the brand');
  }
  // Soften platform mentions so Runway doesn't mock up an Instagram feed
  // when the operator says "show our content as Instagram-ready".
  for (const p of PLATFORMS) {
    out = out.replace(new RegExp(`\\b${p}\\b`, 'g'), 'social');
  }
  return out;
}

async function generateVideoFromImage(imageUrl, prompt, platform = 'instagram', duration = 5) {
  const ratio = RATIOS[platform] || RATIOS.default;

  const task = await apiRequest('POST', '/image_to_video', {
    model: 'gen4',
    promptImage: imageUrl,
    promptText: prompt,
    ratio,
    duration
  });

  return await pollTask(task.id);
}

async function pollTask(taskId, maxAttempts = 60) {
  for (let i = 0; i < maxAttempts; i++) {
    const task = await apiRequest('GET', `/tasks/${taskId}`);

    if (task.status === 'SUCCEEDED') {
      return {
        url: task.output[0],
        taskId: task.id,
        status: 'success'
      };
    }

    if (task.status === 'FAILED') {
      throw new Error(`Runway video generation failed: ${task.failure || 'Unknown error'}`);
    }

    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Runway video generation timeout');
}

module.exports = { generateVideo, generateVideoFromImage };
