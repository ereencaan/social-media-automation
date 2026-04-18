// OpenAI reviewer — plays a conversion-focused copywriter role.
const { chatJSON } = require('../openai.service');
const { getRubric, buildUserPayload } = require('./rubrics');
const { normalizeReview } = require('./normalize');

const MODEL = 'gpt-4o-mini';
const MODEL_LABEL = 'openai';

async function review({ artifact, artifactType, context }) {
  const rubric = getRubric(artifactType);

  const raw = await chatJSON({
    system:
      'You are GPT-4 acting as a senior conversion copywriter. ' +
      'Grade strictly, prioritize whether the artifact drives action, and output ONLY raw JSON.',
    user: buildUserPayload({ artifact, context, rubric }),
    model: MODEL,
    max_tokens: 900,
  });

  return normalizeReview(raw, rubric, MODEL_LABEL);
}

module.exports = { review, MODEL_LABEL };
