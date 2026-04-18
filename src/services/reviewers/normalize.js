// Normalize a raw review JSON from any model into our standard shape.
// Also recomputes `overall` using the rubric's weights if the model
// forgot (or returned a wildly inconsistent) value.

function clamp100(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function weightedOverall(scores, rubric) {
  let sum = 0;
  for (const a of rubric.axes) sum += (scores[a.key] || 0) * a.weight;
  return Math.round(sum);
}

function normalizeReview(raw, rubric, modelLabel) {
  const rawScores = (raw && raw.scores) || {};
  const scores = {};
  for (const a of rubric.axes) scores[a.key] = clamp100(rawScores[a.key]);

  let overall = clamp100(raw && raw.overall);
  const computed = weightedOverall(scores, rubric);
  // If the model's overall disagrees substantially with the weighted sum,
  // trust the math. This protects against models that forget the formula.
  if (!overall || Math.abs(overall - computed) > 10) overall = computed;

  return {
    model:       modelLabel,
    scores,
    overall,
    issues:      Array.isArray(raw && raw.issues)      ? raw.issues.slice(0, 6).map(String)      : [],
    suggestions: Array.isArray(raw && raw.suggestions) ? raw.suggestions.slice(0, 6).map(String) : [],
    verdict:     typeof (raw && raw.verdict) === 'string' ? raw.verdict.slice(0, 300) : '',
  };
}

module.exports = { normalizeReview, weightedOverall, clamp100 };
