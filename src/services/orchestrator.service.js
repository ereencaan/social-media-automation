// Content orchestrator.
//
// Multi-model pipeline that sits between the /api/posts/generate route and
// the individual content/image services:
//
//   1. Generate N variants with Claude (business-aware).
//   2. Critique each variant with OpenAI (JSON-mode).
//   3. Pick the highest-scoring variant.
//   4. If its score is still under REFINE_THRESHOLD, ask Claude to refine
//      it using the critique, then re-critique the result.
//   5. Return the winning content plus a quality report.
//
// The route decides whether to persist the quality report on the post.

const { generateContent, refineContent } = require('./claude.service');
const { chatJSON } = require('./openai.service');

const REFINE_THRESHOLD = 75;   // below this we try one automated refinement
const MIN_ACCEPTABLE   = 60;   // below this we flag the post for user review
const CRITIQUE_MODEL   = 'gpt-4o-mini';

const CRITIQUE_SYSTEM = `You are a senior brand editor and social-media strategist.
You review draft social posts produced by another AI and grade them strictly.

Critical rules:
- Penalize HEAVILY when the content is generic and could have come from any business. On-brand posts must obviously reflect the specific business profile.
- Penalize when the imagePrompt describes something disconnected from the business (e.g. roses for a software company) — the image must reinforce, not contradict, the brand.
- Penalize hashtag mixes that are all top-level generics (#love #sale) without any business-specific or industry-specific tags.
- Reward concrete product/service references, audience-fit language, and platform-appropriate tone.

Output STRICT JSON only, no prose.`;

function buildCritiqueUser({ content, business, prompt, platforms }) {
  const biz = business
    ? JSON.stringify({
        business_name:        business.business_name || null,
        industry:             business.industry || null,
        business_description: business.business_description || null,
        target_audience:      business.target_audience || null,
        tone_of_voice:        business.tone_of_voice || null,
        content_language:     business.content_language || null,
      }, null, 2)
    : 'null (no business profile — do not over-penalize brand fit)';

  return `BUSINESS PROFILE:
${biz}

TOPIC (what the user asked for):
"${prompt}"

TARGET PLATFORMS: ${platforms.join(', ')}

DRAFT POST (JSON):
${JSON.stringify(content, null, 2)}

Grade the draft on these four axes, each 0-100:
- brand_fit:         How obviously this comes from the specific business above. A generic post = low.
- engagement:        How likely it is to stop a scroller and earn reactions on these platforms.
- clarity:           Is the message and CTA unambiguous? Tight copy? No filler?
- hashtag_quality:   Relevance, mix of broad + niche, no spam, no all-generics.

Also rate the image_prompt (0-100) for how well it evokes the business (not just the topic).

Output exactly this JSON shape:
{
  "scores": {
    "brand_fit":       <0-100>,
    "engagement":      <0-100>,
    "clarity":         <0-100>,
    "hashtag_quality": <0-100>,
    "image_prompt":    <0-100>
  },
  "overall":     <0-100 weighted: brand_fit*0.35 + engagement*0.25 + clarity*0.15 + hashtag_quality*0.10 + image_prompt*0.15>,
  "issues":      [ "concise issue 1", "concise issue 2" ],
  "suggestions": [ "specific, actionable suggestion 1", "..." ],
  "verdict":     "<one short sentence>"
}`;
}

async function critiqueContent({ content, business, prompt, platforms }) {
  const user = buildCritiqueUser({ content, business, prompt, platforms });
  const raw = await chatJSON({
    system: CRITIQUE_SYSTEM,
    user,
    model: CRITIQUE_MODEL,
    max_tokens: 900,
  });

  // Normalize / sanity-check the fields we rely on
  const num = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
  };
  const scores = raw.scores || {};
  const normalized = {
    scores: {
      brand_fit:       num(scores.brand_fit),
      engagement:      num(scores.engagement),
      clarity:         num(scores.clarity),
      hashtag_quality: num(scores.hashtag_quality),
      image_prompt:    num(scores.image_prompt),
    },
    overall:     num(raw.overall),
    issues:      Array.isArray(raw.issues)      ? raw.issues.slice(0, 6).map(String)      : [],
    suggestions: Array.isArray(raw.suggestions) ? raw.suggestions.slice(0, 6).map(String) : [],
    verdict:     typeof raw.verdict === 'string' ? raw.verdict.slice(0, 300) : '',
  };

  // If the model forgot the overall, recompute from the weighted sum
  if (!normalized.overall) {
    const s = normalized.scores;
    normalized.overall = Math.round(
      s.brand_fit * 0.35 +
      s.engagement * 0.25 +
      s.clarity * 0.15 +
      s.hashtag_quality * 0.10 +
      s.image_prompt * 0.15
    );
  }
  return normalized;
}

/**
 * End-to-end orchestration. Caller passes the same shape as generateContent
 * plus orchestration knobs.
 *
 * @param {string}   prompt
 * @param {string[]} platforms
 * @param {object}   opts
 * @param {object}   [opts.business]          — brand_settings row
 * @param {boolean}  [opts.onBrand=true]
 * @param {number}   [opts.variants=1]        — 1..3 parallel candidates
 * @param {boolean}  [opts.qualityGate=true]  — enable critique + auto-refine
 * @returns {{ content, quality }}
 */
async function orchestrateContent(prompt, platforms = ['instagram'], opts = {}) {
  const {
    business = null,
    onBrand = true,
    variants = 1,
    qualityGate = true,
  } = opts;

  const n = Math.max(1, Math.min(Number(variants) || 1, 3));
  const variantOpts = { business, onBrand };

  // ---- 1. Generate variants in parallel ---------------------------------
  const drafts = await Promise.all(
    Array.from({ length: n }, () => generateContent(prompt, platforms, variantOpts)),
  );

  if (!qualityGate) {
    // Legacy path — skip critique, return the first draft with no quality report
    return { content: drafts[0], quality: null };
  }

  // ---- 2. Critique each variant (parallel) ------------------------------
  const critiques = await Promise.all(
    drafts.map((c) =>
      critiqueContent({ content: c, business, prompt, platforms })
        .catch((err) => {
          // If the critique model fails, fall back to a neutral score so
          // the pipeline still returns a sensible result instead of 500ing.
          console.error('[orchestrator] critique failed:', err.message);
          return {
            scores: { brand_fit: 0, engagement: 0, clarity: 0, hashtag_quality: 0, image_prompt: 0 },
            overall: 0,
            issues: ['Automatic quality review unavailable'],
            suggestions: [],
            verdict: 'Critique skipped due to error.',
            _error: err.message,
          };
        }),
    ),
  );

  // ---- 3. Pick the best variant -----------------------------------------
  let bestIdx = 0;
  for (let i = 1; i < critiques.length; i++) {
    if (critiques[i].overall > critiques[bestIdx].overall) bestIdx = i;
  }
  let winner   = drafts[bestIdx];
  let critique = critiques[bestIdx];
  let refined  = false;
  let refinementNotes = '';

  // ---- 4. Refine once if the winner is still below the threshold -------
  if (
    critique.overall < REFINE_THRESHOLD &&
    critique.suggestions.length &&
    !critique._error
  ) {
    try {
      const improved = await refineContent({
        previous: winner,
        critique,
        prompt,
        platforms,
        business,
        onBrand,
      });
      const newCritique = await critiqueContent({
        content: improved, business, prompt, platforms,
      });
      // Only accept the refinement if it actually moved the score up —
      // otherwise the original draft was already the best we could do.
      if (newCritique.overall > critique.overall) {
        winner = improved;
        refinementNotes = `Refined based on: ${critique.suggestions.slice(0, 3).join(' | ')}`;
        critique = newCritique;
        refined = true;
      }
    } catch (err) {
      console.error('[orchestrator] refine failed:', err.message);
    }
  }

  // ---- 5. Build the quality report --------------------------------------
  const quality = {
    score:        critique.overall,
    breakdown:    critique.scores,
    issues:       critique.issues,
    suggestions:  critique.suggestions,
    verdict:      critique.verdict,
    refined,
    refinementNotes,
    variantsTried: n,
    needsReview:   critique.overall < MIN_ACCEPTABLE,
  };

  return { content: winner, quality };
}

module.exports = {
  orchestrateContent,
  critiqueContent,
  REFINE_THRESHOLD,
  MIN_ACCEPTABLE,
};
