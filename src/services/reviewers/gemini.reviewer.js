// Gemini reviewer — plays a data-driven analytical critic role.
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getRubric, buildUserPayload } = require('./rubrics');
const { normalizeReview } = require('./normalize');

const MODEL = 'gemini-2.5-flash';
const MODEL_LABEL = 'gemini';

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
    client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return client;
}

async function review({ artifact, artifactType, context }) {
  const rubric = getRubric(artifactType);
  const genAI = getClient();

  const model = genAI.getGenerativeModel({
    model: MODEL,
    systemInstruction:
      'You are Gemini acting as a data-driven brand editor. ' +
      'Grade strictly, be specific, and output ONLY raw JSON — no prose outside the JSON.',
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
    },
  });

  const result = await model.generateContent(buildUserPayload({ artifact, context, rubric }));
  const text = result.response.text().trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '');
  const raw = JSON.parse(text);
  return normalizeReview(raw, rubric, MODEL_LABEL);
}

module.exports = { review, MODEL_LABEL };
