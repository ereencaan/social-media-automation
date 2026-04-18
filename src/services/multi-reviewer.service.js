// Multi-model review service.
//
// Fans an artifact out to Claude + Gemini + OpenAI in parallel, each acting
// as an independent reviewer. Aggregates their grades into a consensus
// report with per-model breakdowns. Degrades gracefully if one reviewer
// fails — we still return the others.
//
// This is THE review abstraction for the whole SaaS. Callers pass only:
//   { artifact, artifactType, context }
// artifactType is a key in reviewers/rubrics.js (e.g. 'social_post',
// 'lead_email', 'prompt_quality'). Adding new types = one rubric entry.

const claudeReviewer = require('./reviewers/claude.reviewer');
const geminiReviewer = require('./reviewers/gemini.reviewer');
const openaiReviewer = require('./reviewers/openai.reviewer');
const { getRubric } = require('./reviewers/rubrics');

const REVIEWERS = [claudeReviewer, geminiReviewer, openaiReviewer];
const DEFAULT_TIMEOUT_MS = 45_000;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Run a review with all enabled models in parallel and aggregate.
 *
 * @param {object} opts
 * @param {object} opts.artifact
 * @param {string} opts.artifactType   — rubric key (social_post / lead_email / prompt_quality / ...)
 * @param {object} [opts.context]      — business profile / lead profile / etc.
 * @param {string[]} [opts.models]     — subset of ['claude','gemini','openai'] (default: all)
 * @param {number} [opts.timeoutMs]    — per-model timeout
 *
 * @returns {{
 *   score, breakdown, issues, suggestions, verdict, needsReview,
 *   perModel: { claude?, gemini?, openai? },
 *   modelsUsed: string[], modelsFailed: { model, error }[],
 * }}
 */
async function reviewArtifact({ artifact, artifactType, context = {}, models, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const rubric = getRubric(artifactType);  // throws early on bad type

  const enabled = REVIEWERS.filter(r => !models || models.includes(r.MODEL_LABEL));
  if (!enabled.length) throw new Error('No reviewers enabled');

  // Fan out in parallel. Settle => keep survivors when one fails.
  const settled = await Promise.allSettled(
    enabled.map((r) =>
      withTimeout(
        r.review({ artifact, artifactType, context }),
        timeoutMs,
        `reviewer ${r.MODEL_LABEL}`,
      ),
    ),
  );

  const perModel = {};
  const succeeded = [];
  const failed = [];
  settled.forEach((s, i) => {
    const label = enabled[i].MODEL_LABEL;
    if (s.status === 'fulfilled') {
      perModel[label] = s.value;
      succeeded.push(s.value);
    } else {
      failed.push({ model: label, error: s.reason.message });
      console.error(`[multi-reviewer] ${label} failed:`, s.reason.message);
    }
  });

  if (!succeeded.length) {
    // All reviewers down — return a transparent degraded report instead of throwing
    return {
      score: 0,
      breakdown: Object.fromEntries(rubric.axes.map(a => [a.key, 0])),
      issues: ['All AI reviewers failed — quality review unavailable.'],
      suggestions: [],
      verdict: 'Review skipped due to reviewer errors.',
      needsReview: true,
      perModel,
      modelsUsed: [],
      modelsFailed: failed,
      degraded: true,
    };
  }

  // ---- Aggregate across models ---------------------------------------------
  // Overall score: mean. Three-way consensus smooths outliers; we could also
  // use median, but with N=3 mean is fine.
  const overallMean = Math.round(
    succeeded.reduce((a, r) => a + r.overall, 0) / succeeded.length,
  );

  // Breakdown: per-axis mean. If only one reviewer is up, this is just its view.
  const breakdown = {};
  for (const axis of rubric.axes) {
    const sum = succeeded.reduce((a, r) => a + (r.scores[axis.key] || 0), 0);
    breakdown[axis.key] = Math.round(sum / succeeded.length);
  }

  // Issues / suggestions: union across reviewers, each tagged with its source
  // so the UI can show "Claude: ...", "OpenAI: ..." and spot consensus.
  const tagged = (arr, tag) => (arr || []).map(t => ({ model: tag, text: String(t).trim() }));
  const issues = succeeded.flatMap(r => tagged(r.issues, r.model));
  const suggestions = succeeded.flatMap(r => tagged(r.suggestions, r.model));
  // Drop near-duplicates (same lowercase start) to avoid repetition clutter
  const dedupe = (items) => {
    const seen = new Set();
    return items.filter((it) => {
      const key = it.text.toLowerCase().slice(0, 48);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  // Verdict: use the highest-scoring reviewer's verdict as the headline,
  // since that reviewer found the most in the artifact to approve of.
  const lead = [...succeeded].sort((a, b) => b.overall - a.overall)[0];

  return {
    score: overallMean,
    breakdown,
    issues: dedupe(issues),
    suggestions: dedupe(suggestions),
    verdict: lead.verdict,
    needsReview: overallMean < 60,
    perModel,
    modelsUsed: succeeded.map(r => r.model),
    modelsFailed: failed,
    degraded: failed.length > 0,
  };
}

module.exports = { reviewArtifact, DEFAULT_TIMEOUT_MS };
