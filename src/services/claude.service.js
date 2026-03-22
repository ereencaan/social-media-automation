const Anthropic = require('@anthropic-ai/sdk');

let client = null;

function getClient() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in .env');
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

const PLATFORM_TONES = {
  instagram: 'casual, engaging, emoji-friendly, short and punchy',
  facebook: 'friendly, conversational, community-oriented',
  linkedin: 'professional, insightful, industry-focused, no excessive emojis'
};

async function generateContent(prompt, platforms = ['instagram']) {
  const anthropic = getClient();
  const platformList = platforms.join(', ');
  const toneGuide = platforms.map(p => `${p}: ${PLATFORM_TONES[p] || 'neutral'}`).join('\n');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are a social media content expert. Generate post content based on this prompt:

"${prompt}"

Target platforms: ${platformList}

Tone guide per platform:
${toneGuide}

Respond in JSON format ONLY (no markdown):
{
  "caption": "The main caption text (use the most universal tone if multiple platforms)",
  "hashtags": ["tag1", "tag2", ...up to 15 relevant hashtags without # symbol],
  "platformCaptions": {
    "instagram": "Instagram-specific caption",
    "facebook": "Facebook-specific caption",
    "linkedin": "LinkedIn-specific caption"
  },
  "imagePrompt": "A detailed DALL-E prompt to generate a matching visual for this post"
}`
    }]
  });

  const text = response.content[0].text;
  return JSON.parse(text);
}

module.exports = { generateContent };
