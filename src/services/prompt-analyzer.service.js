// Prompt pre-analysis. Runs BEFORE the user burns tokens on image/video
// generation. Uses the shared multi-reviewer infra with the
// `prompt_quality` rubric.
//
// Two operations:
//   analyzePrompt(prompt, context)        — grade the prompt, return report
//   rewritePrompt(prompt, context, notes) — use Claude to produce an
//                                           improved prompt incorporating
//                                           the analyzer's suggestions.

const Anthropic = require('@anthropic-ai/sdk');
const { reviewArtifact } = require('./multi-reviewer.service');

let anthropicClient = null;
function getAnthropic() {
  if (!anthropicClient) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

function businessCtx(business) {
  if (!business) return null;
  return {
    business_name:        business.business_name || null,
    industry:             business.industry || null,
    business_description: business.business_description || null,
    target_audience:      business.target_audience || null,
    tone_of_voice:        business.tone_of_voice || null,
    content_language:     business.content_language || null,
  };
}

/**
 * Grade a user prompt for clarity, specificity, business fit, and safety.
 * Fast path — defaults to Claude only (single model) since this runs on
 * keystroke-latency budgets. Callers can opt into all 3 with `models`.
 *
 * @returns multi-reviewer report (same shape as social_post reviews)
 */
async function analyzePrompt({ prompt, business, platforms = ['instagram'], models }) {
  if (!prompt || !prompt.trim()) throw new Error('Prompt is required');
  const report = await reviewArtifact({
    artifact:     { prompt: prompt.trim(), platforms },
    artifactType: 'prompt_quality',
    context: {
      business: businessCtx(business),
      target_platforms: platforms,
    },
    // Single-model fast path by default; the caller can override.
    models: models || ['claude'],
  });

  return {
    score: report.score,
    breakdown: report.breakdown,
    issues: report.issues,
    suggestions: report.suggestions,
    verdict: report.verdict,
    needsReview: report.needsReview,
    perModel: report.perModel,
    modelsUsed: report.modelsUsed,
    modelsFailed: report.modelsFailed,
    degraded: report.degraded,
  };
}

/**
 * Rewrite a weak prompt using the analyzer's suggestions + business context.
 * The goal is a prompt the user can send straight into generation.
 */
async function rewritePrompt({ prompt, business, platforms = ['instagram'], suggestions = [] }) {
  if (!prompt || !prompt.trim()) throw new Error('Prompt is required');

  const anthropic = getAnthropic();
  const biz = businessCtx(business);

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system:
      'You rewrite social media content prompts to be clearer, more specific, and better-grounded in the user\'s business. ' +
      'Output ONLY the improved prompt as a single plain string — no markdown, no quotes, no prefix.',
    messages: [{
      role: 'user',
      content: `BUSINESS PROFILE:
${JSON.stringify(biz || {}, null, 2)}

TARGET PLATFORMS: ${platforms.join(', ')}

ORIGINAL PROMPT (written by the user):
"""
${prompt.trim()}
"""

REVIEWER SUGGESTIONS TO ADDRESS:
${suggestions.length ? suggestions.map((s, i) => `${i + 1}. ${typeof s === 'string' ? s : s.text || ''}`).join('\n') : '(none provided — infer what would improve the prompt)'}

Rewrite the prompt so it keeps the user's original intent but is specific, actionable, and clearly tied to the business. Keep it concise (1–3 sentences). Do not invent facts about the business; only use what's in the profile. Output ONLY the rewritten prompt.`,
    }],
  });

  return resp.content[0].text.trim().replace(/^["'`]+|["'`]+$/g, '');
}

module.exports = { analyzePrompt, rewritePrompt };
