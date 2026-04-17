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

async function pollResult(key, taskId, maxAttempts = 60) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(`${BFL_API}/get_result?id=${taskId}`, {
      headers: { 'X-Key': key }
    });

    const data = await res.json();

    if (data.status === 'Ready') {
      return {
        url: data.result.sample,
        revisedPrompt: null
      };
    }

    if (data.status === 'Error' || data.status === 'Failed') {
      throw new Error(`Flux generation failed: ${JSON.stringify(data)}`);
    }

    // Wait 2 seconds between polls
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Flux generation timeout');
}

module.exports = { generateImage };
