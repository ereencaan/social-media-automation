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
const { reviewArtifact } = require('./multi-reviewer.service');

const REFINE_THRESHOLD = 75;   // below this we try one automated refinement
const MIN_ACCEPTABLE   = 60;   // below this we flag the post for user review

// Adapter: runs a multi-model review of a draft post and returns the legacy
// shape the rest of this file expects. Delegates to multi-reviewer so that
// the same infrastructure powers email review, prompt analysis, etc.
async function critiqueContent({ content, business, prompt, platforms }) {
  const businessCtx = business
    ? {
        business_name:        business.business_name || null,
        industry:             business.industry || null,
        business_description: business.business_description || null,
        target_audience:      business.target_audience || null,
        tone_of_voice:        business.tone_of_voice || null,
        content_language:     business.content_language || null,
      }
    : null;

  const report = await reviewArtifact({
    artifact:     content,
    artifactType: 'social_post',
    context: {
      business: businessCtx,
      user_prompt: prompt,
      target_platforms: platforms,
    },
  });

  // Shape the aggregated report into the same fields the refine / return
  // paths below already read. Keep everything extra (perModel, modelsUsed)
  // so it bubbles up to the client for the UI breakdown.
  return {
    scores:      report.breakdown,
    overall:     report.score,
    issues:      (report.issues      || []).map(i => (typeof i === 'string' ? i : i.text)),
    suggestions: (report.suggestions || []).map(s => (typeof s === 'string' ? s : s.text)),
    verdict:     report.verdict,
    perModel:    report.perModel,
    modelsUsed:  report.modelsUsed,
    modelsFailed: report.modelsFailed,
    degraded:    report.degraded,
    _error:      (!report.modelsUsed || !report.modelsUsed.length) ? 'all_reviewers_failed' : undefined,
  };
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

  // ---- 4. Refine LOOP: keep iterating while score is below threshold ----
  // Up to MAX_REFINE_ROUNDS attempts. Each round feeds the latest critique
  // back to Claude. We keep the best draft seen so far (in case one round
  // regresses), but stop early if any draft hits or exceeds the threshold.
  const MAX_REFINE_ROUNDS = 3;
  let rounds = 0;
  while (
    critique.overall < REFINE_THRESHOLD &&
    critique.suggestions.length &&
    !critique._error &&
    rounds < MAX_REFINE_ROUNDS
  ) {
    rounds++;
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
      // Always promote the candidate with the higher score so we walk uphill.
      if (newCritique.overall > critique.overall) {
        winner = improved;
        refinementNotes = `Refined ×${rounds} based on: ${critique.suggestions.slice(0, 3).join(' | ')}`;
        critique = newCritique;
        refined = true;
        if (newCritique.overall >= REFINE_THRESHOLD) break;
      } else {
        // No improvement this round — the suggestions were exhausted.
        break;
      }
    } catch (err) {
      console.error('[orchestrator] refine round %d failed:', rounds, err.message);
      break;
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
    // Multi-model review metadata (so the UI can show per-model breakdown)
    perModel:      critique.perModel || {},
    modelsUsed:    critique.modelsUsed || [],
    modelsFailed:  critique.modelsFailed || [],
    degraded:      !!critique.degraded,
  };

  return { content: winner, quality };
}

module.exports = {
  orchestrateContent,
  critiqueContent,
  REFINE_THRESHOLD,
  MIN_ACCEPTABLE,
};
