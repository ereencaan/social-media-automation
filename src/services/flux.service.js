const BFL_API = 'https://api.bfl.ai/v1';

function getKey() {
  if (!process.env.BFL_API_KEY) throw new Error('BFL_API_KEY is not set in .env');
  return process.env.BFL_API_KEY;
}

const SIZES = {
  instagram: { width: 1024, height: 1024 },
  facebook: { width: 1024, height: 768 },
  linkedin: { width: 1024, height: 768 },
  default: { width: 1024, height: 1024 }
};

async function generateImage(prompt, platform = 'default') {
  const key = getKey();
  const size = SIZES[platform] || SIZES.default;

  // 1. Submit generation request
  const res = await fetch(`${BFL_API}/flux-2-pro`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Key': key
    },
    body: JSON.stringify({
      prompt: `${prompt}. Do NOT include any text, words, letters or typography in the image. Pure visual design only.`,
      width: size.width,
      height: size.height
    })
  });

  if (!res.ok) throw new Error(`Flux API error: ${res.status} ${await res.text()}`);
  const { id } = await res.json();

  // 2. Poll for result
  return await pollResult(key, id);
}

// BFL's flux-2-pro latency is usually 30-90s but can spike above 2 min when
// the shared queue is busy. We wait up to ~5 min before giving up.
async function pollResult(key, taskId, maxAttempts = 150) {
  const startMs = Date.now();
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(`${BFL_API}/get_result?id=${taskId}`, {
      headers: { 'X-Key': key }
    });
    const data = await res.json();

    if (data.status === 'Ready') {
      return { url: data.result.sample, revisedPrompt: null };
    }
    if (data.status === 'Error' || data.status === 'Failed') {
      throw new Error(`Flux generation failed: ${JSON.stringify(data)}`);
    }

    // Progressive backoff: 2s for the first minute, 3s after.
    const delay = i < 30 ? 2000 : 3000;
    await new Promise(r => setTimeout(r, delay));
  }
  const waited = Math.round((Date.now() - startMs) / 1000);
  throw new Error(`Flux generation timeout (waited ${waited}s, status was still pending)`);
}

module.exports = { generateImage };
