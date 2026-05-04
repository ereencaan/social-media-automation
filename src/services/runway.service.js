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

  const task = await apiRequest('POST', '/text_to_video', {
    model: 'gen4.5',
    promptText: `Social media reel: ${prompt}. Professional, eye-catching, suitable for ${platform}. No text or words in the video.`,
    ratio,
    duration
  });

  return await pollTask(task.id);
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
