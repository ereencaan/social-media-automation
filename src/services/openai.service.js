const OpenAI = require('openai');

let openai = null;

function getClient() {
  if (!openai) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set in .env');
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

const SIZES = {
  instagram: '1024x1024',
  facebook: '1792x1024',
  linkedin: '1792x1024',
  default: '1024x1024'
};

async function generateImage(prompt, platform = 'default') {
  const client = getClient();
  const size = SIZES[platform] || SIZES.default;

  const response = await client.images.generate({
    model: 'dall-e-3',
    prompt: `Social media post image: ${prompt}. Professional, clean, eye-catching design suitable for ${platform}. IMPORTANT: Do NOT include any text, words, letters, or typography in the image. Pure visual design only, no text overlays.`,
    n: 1,
    size,
    quality: 'hd'
  });

  return {
    url: response.data[0].url,
    revisedPrompt: response.data[0].revised_prompt
  };
}

module.exports = { generateImage };
