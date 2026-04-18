// Claude reviewer. Plays the role of a senior brand editor.
const Anthropic = require('@anthropic-ai/sdk');
const { getRubric, buildUserPayload } = require('./rubrics');
const { normalizeReview } = require('./normalize');

const MODEL = 'claude-sonnet-4-20250514';
const MODEL_LABEL = 'claude';

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

async function review({ artifact, artifactType, context }) {
  const rubric = getRubric(artifactType);
  const anthropic = getClient();

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 900,
    system: 'You are Claude acting as a meticulous brand editor and strategist. ' +
            'You grade artifacts strictly and output ONLY raw JSON — no prose outside the JSON.',
    messages: [{ role: 'user', content: buildUserPayload({ artifact, context, rubric }) }],
  });

  const text = resp.content[0].text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '');
  const raw = JSON.parse(text);
  return normalizeReview(raw, rubric, MODEL_LABEL);
}

module.exports = { review, MODEL_LABEL };
