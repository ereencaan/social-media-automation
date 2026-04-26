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
  facebook:  'friendly, conversational, community-oriented',
  linkedin:  'professional, insightful, industry-focused, no excessive emojis',
};

// Build the "who we are" block that teaches Claude about the business.
// If nothing useful is set, returns null and the model works freestyle.
function buildBusinessBlock(business) {
  if (!business) return null;
  const lines = [];
  if (business.business_name)        lines.push(`Business name: ${business.business_name}`);
  if (business.industry)             lines.push(`Industry / vertical: ${business.industry}`);
  if (business.business_description) lines.push(`What the business does: ${business.business_description}`);
  if (business.target_audience)      lines.push(`Target audience: ${business.target_audience}`);
  if (business.tone_of_voice)        lines.push(`Preferred tone of voice: ${business.tone_of_voice}`);
  if (business.content_language)     lines.push(`Write the content in: ${business.content_language}`);
  // Contact / handles — explicit so Claude can append them to captions.
  if (business.website)              lines.push(`Website: ${business.website}`);
  if (business.phone)                lines.push(`Phone: ${business.phone}`);
  if (business.whatsapp)             lines.push(`WhatsApp: ${business.whatsapp}`);
  if (business.instagram_handle)     lines.push(`Instagram: @${String(business.instagram_handle).replace(/^@/, '')}`);
  if (business.facebook_handle)      lines.push(`Facebook: ${business.facebook_handle}`);
  if (business.linkedin_handle)      lines.push(`LinkedIn: ${business.linkedin_handle}`);
  return lines.length ? lines.join('\n') : null;
}

// Pull just the contact-info subset (used to instruct Claude to append a
// reach-out block at the end of every caption). Both phone and WhatsApp
// are shown when filled — the user may legitimately have a separate
// landline and mobile.
function buildContactBlock(business) {
  if (!business) return null;
  const parts = [];
  if (business.website)          parts.push(`🌐 ${business.website}`);
  if (business.phone)            parts.push(`📞 ${business.phone}`);
  if (business.whatsapp)         parts.push(`📲 WhatsApp ${business.whatsapp}`);
  if (business.instagram_handle) parts.push(`📷 @${String(business.instagram_handle).replace(/^@/, '')}`);
  return parts.length ? parts.join('  ·  ') : null;
}

/**
 * Generate post content.
 * @param {string} prompt             — topic / brief from the user
 * @param {string[]} platforms
 * @param {object} [opts]
 * @param {object} [opts.business]    — brand_settings row with business profile
 * @param {boolean} [opts.onBrand=true] — when false, ignore the business context
 */
async function generateContent(prompt, platforms = ['instagram'], opts = {}) {
  const anthropic = getClient();
  const platformList = platforms.join(', ');
  const toneGuide = platforms.map(p => `${p}: ${PLATFORM_TONES[p] || 'neutral'}`).join('\n');

  const businessBlock = opts.onBrand === false ? null : buildBusinessBlock(opts.business);

  const systemParts = [
    'You are a senior social media strategist and copywriter.',
    'You craft scroll-stopping posts that feel authentic to the brand voice and obviously come from a real business — never generic stock copy.',
  ];
  if (businessBlock) {
    systemParts.push(
      'CRITICAL: The content MUST reflect the following business. Every post, caption, hashtag, and image prompt must be clearly connected to what this business actually does and who it serves. Do not output generic content disconnected from the business. If the user\'s topic is seasonal or general, connect it back to the business.',
      '\n--- BUSINESS PROFILE ---\n' + businessBlock + '\n--- END BUSINESS PROFILE ---',
      // Force specifics — generic IT / SaaS clichés get the post rejected.
      'BANNED phrases (too generic): "we deliver quality", "industry-leading", "world-class", "best in class", "let us help you", "transform your business". Use specific outcomes (numbers, named services, named workflow steps) drawn from the business description.',
      'HASHTAG RULE: Hashtags MUST be niche to this business or its industry. ' +
      'NO broad single-word tags like #technology, #business, #UK, #marketing. ' +
      'Use 8–12 specific tags (e.g. for a workflow-automation firm: #workflowAutomation #SaaSIntegration #processOptimization #lowCodeUK).',
      'IMAGE PROMPT RULE: Describe a scene that visibly depicts THIS business — its product, its service in action, or its branded environment. ' +
      'CRITICAL: DO NOT include any logos, brand marks, written brand names, or any text/typography in the image. The real logo is overlaid in post-processing — if the image already contains a fake logo or brand text, it conflicts. Just describe the scene, lighting, subjects, mood. ' +
      'NO stock-photo developer-at-laptop scenes unless that is literally the business.',
    );
    if (opts.business && opts.business.content_language) {
      systemParts.push(
        `LANGUAGE: All caption + hashtag + platform copy MUST be in ${opts.business.content_language}. The user's prompt may be in another language — translate / interpret it but write the output in ${opts.business.content_language}. Do NOT mix languages.`,
      );
    }
    const contact = buildContactBlock(opts.business);
    if (contact) {
      systemParts.push(
        'CONTACT BLOCK: End every caption with a single short line that gives the reader an obvious way to reach the business. Use exactly this content (you may reformat the icons but keep the values verbatim, do not invent any details that are not listed):\n' + contact,
      );
    }
  }

  const userMessage = `Topic / brief from the user:
"${prompt}"

Target platforms: ${platformList}

Tone guide per platform:
${toneGuide}

Respond with ONLY raw JSON (no markdown fences) matching this schema:
{
  "caption": "The main caption (universal tone if multiple platforms).",
  "hashtags": ["tag1","tag2", ...up to 15 relevant hashtags, without the # prefix],
  "platformCaptions": {
    "instagram": "...",
    "facebook":  "...",
    "linkedin":  "..."
  },
  "imagePrompt": "A detailed image-generation prompt that visually fits this post AND clearly evokes the business. Describe subject, style, composition, lighting, and mood — avoid text in the image."
}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1400,
    system: systemParts.join('\n\n'),
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content[0].text.trim();
  // Strip accidental ```json fences just in case
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const parsed = JSON.parse(cleaned);
  return appendContactBlock(parsed, opts.business, opts.onBrand !== false);
}

// Server-side guarantee: stamp the brand contact line on every caption
// (and every per-platform caption) before we return. Claude was treating
// the system-prompt instruction as a soft suggestion and dropping it.
function appendContactBlock(content, business, onBrand) {
  if (!onBrand || !business || !content) return content;
  const contact = buildContactBlock(business);
  if (!contact) return content;
  // Skip if Claude already included the contact line (avoid double-stamping).
  const alreadyHas = (s) => typeof s === 'string'
    && (
      (business.website && s.includes(business.website)) ||
      (business.phone && s.includes(business.phone)) ||
      (business.whatsapp && s.includes(business.whatsapp))
    );
  const stamp = (s) => (typeof s === 'string' && !alreadyHas(s))
    ? s.trimEnd() + '\n\n' + contact
    : s;
  if (content.caption) content.caption = stamp(content.caption);
  if (content.platformCaptions && typeof content.platformCaptions === 'object') {
    for (const k of Object.keys(content.platformCaptions)) {
      content.platformCaptions[k] = stamp(content.platformCaptions[k]);
    }
  }
  return content;
}

/**
 * Rewrite an existing post based on a critique. Used by the orchestrator's
 * refine step. Preserves the business context and platform-tailoring logic
 * from generateContent, but frames the request as an improvement pass.
 */
async function refineContent({ previous, critique, prompt, platforms = ['instagram'], business, onBrand = true }) {
  const anthropic = getClient();
  const businessBlock = onBrand === false ? null : buildBusinessBlock(business);

  const systemParts = [
    'You are a senior social media strategist and copywriter.',
    'You previously produced a draft post. An independent reviewer has now critiqued it. ' +
    'Rewrite the post to address every issue in the critique while keeping the parts the reviewer liked.',
  ];
  if (businessBlock) {
    systemParts.push(
      'CRITICAL: The content MUST still clearly reflect this business:\n--- BUSINESS PROFILE ---\n' +
      businessBlock + '\n--- END BUSINESS PROFILE ---',
    );
    const contact = buildContactBlock(business);
    if (contact) {
      systemParts.push(
        'CONTACT BLOCK: End every caption with a single short line giving the reader an obvious way to reach the business. Use exactly this content (icons may be reformatted, values must remain verbatim):\n' + contact,
      );
    }
  }

  const userMessage = `Original topic:
"${prompt}"

Target platforms: ${platforms.join(', ')}

Previous draft (JSON):
${JSON.stringify(previous, null, 2)}

Reviewer critique (JSON):
${JSON.stringify(critique, null, 2)}

Produce an improved version using the same schema as before:
{
  "caption": "...",
  "hashtags": [...],
  "platformCaptions": { "instagram": "...", "facebook": "...", "linkedin": "..." },
  "imagePrompt": "..."
}

Return ONLY raw JSON.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1400,
    system: systemParts.join('\n\n'),
    messages: [{ role: 'user', content: userMessage }],
  });
  const text = response.content[0].text.trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const parsed = JSON.parse(cleaned);
  return appendContactBlock(parsed, business, onBrand);
}

module.exports = { generateContent, refineContent };
