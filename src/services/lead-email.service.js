// Lead email composer. Drafts an outbound email to a specific lead, then
// runs it through the multi-reviewer with the `lead_email` rubric.
//
// This is the second customer-facing use of the shared review infra —
// once you have this pattern working for emails, "review any artifact
// against context" becomes the SaaS's core AI loop.

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

const GOAL_HINTS = {
  intro:        'An initial outreach — introduce our services and hint at specific value for them',
  followup:     'A polite follow-up to a prior thread — refer back, surface new value, nudge gently',
  meeting:      'Request a short call/meeting — propose a concrete time window and next step',
  reactivate:   'Re-engage a cold lead — reference anything we know about them and give a reason to reply',
  proposal:     'Share a proposal or pricing — frame it around outcomes, not features',
  custom:       'Use the caller-supplied extra instructions as the primary goal',
};

function sanitize(str, max = 2000) {
  return String(str ?? '').trim().slice(0, max);
}

function buildContext({ business, lead, goal, extra }) {
  return {
    business: business ? {
      business_name:        business.business_name || null,
      industry:             business.industry || null,
      business_description: business.business_description || null,
      target_audience:      business.target_audience || null,
      tone_of_voice:        business.tone_of_voice || 'professional',
      content_language:     business.content_language || 'English',
      sender_phone:         business.phone || null,
      sender_website:       business.website || null,
    } : null,
    lead: lead ? {
      name:   lead.name || null,
      email:  lead.email || null,
      phone:  lead.phone || null,
      source: lead.source || null,
      stage:  lead.stage || null,
      status: lead.status || null,
      notes:  lead.notes || null,
    } : null,
    goal,
    goal_description: GOAL_HINTS[goal] || GOAL_HINTS.custom,
    caller_extra_instructions: extra || null,
  };
}

/**
 * Draft an email (subject + body) for the given lead + business + goal.
 * No tool calls, no critique — just fast generation.
 */
async function draftEmail({ business, lead, goal = 'intro', extra = '' }) {
  const anthropic = getAnthropic();
  const ctx = buildContext({ business, lead, goal, extra: sanitize(extra) });

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 800,
    system:
      'You write professional outbound emails. You ground every email in the sender\'s business profile and what is known about the specific lead. ' +
      'You never invent facts. If something is unknown, you write around it cleanly. ' +
      'Your emails are short, specific, and end with ONE concrete call-to-action. ' +
      'Output ONLY strict JSON.',
    messages: [{
      role: 'user',
      content: `CONTEXT:
${JSON.stringify(ctx, null, 2)}

Draft an email. Rules:
- Keep it under 130 words total.
- Subject line ≤ 60 characters, no clickbait.
- Greeting uses the lead's first name if available, otherwise "Hi there".
- Body must reference the BUSINESS's actual services and what's known about the LEAD. Do not write anything generic that could be sent to anyone.
- If the goal is "custom", use the caller_extra_instructions as the primary guidance.
- Include one specific CTA (book a call, reply with a time, try a demo, etc.)
- Tone should match business.tone_of_voice.
- Language: ${ctx.business?.content_language || 'English'}.

Return exactly:
{
  "subject": "...",
  "body":    "Plain text email body with line breaks. No HTML."
}`,
    }],
  });

  const text = resp.content[0].text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '');
  const parsed = JSON.parse(text);
  return {
    subject: sanitize(parsed.subject, 140),
    body:    sanitize(parsed.body, 5000),
  };
}

/**
 * Review an email draft against the lead's business context using the
 * lead_email rubric and the shared multi-reviewer infrastructure.
 */
async function reviewEmail({ email, business, lead, goal }) {
  return reviewArtifact({
    artifact:     { subject: email.subject, body: email.body },
    artifactType: 'lead_email',
    context:      buildContext({ business, lead, goal }),
  });
}

/**
 * One-shot draft + review. Used by the main endpoint.
 */
async function draftAndReview({ business, lead, goal = 'intro', extra = '' }) {
  const email = await draftEmail({ business, lead, goal, extra });
  const quality = await reviewEmail({ email, business, lead, goal });
  return { email, quality };
}

module.exports = { draftEmail, reviewEmail, draftAndReview, GOAL_HINTS };
