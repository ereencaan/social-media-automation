// Content planner. Turns a user request ("15 posts for April, 60% IG / 40%
// LinkedIn") into a reviewed monthly content calendar of plan items:
//   [{ scheduled_for, theme, topic_brief, platforms, reasoning }, ...]
//
// Pipeline:
//   1. Collect the month's special days (country + industry + custom).
//   2. Ask Claude to draft a plan, grounded in the business profile and
//      the special-days list.
//   3. Run the draft plan through the multi-reviewer with a new
//      'content_plan' rubric — if the plan scores poorly (imbalance,
//      topic repetition, platform mismatch), show the user the critique.
//   4. Return { plan, quality } for preview / edit / approval.

const Anthropic = require('@anthropic-ai/sdk');
const { getSpecialDaysForMonth } = require('./special-days.service');
const { reviewArtifact } = require('./multi-reviewer.service');

let anthropicClient = null;
function getAnthropic() {
  if (!anthropicClient) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

function businessCtx(b) {
  if (!b) return null;
  return {
    business_name:        b.business_name || null,
    industry:             b.industry || null,
    business_description: b.business_description || null,
    target_audience:      b.target_audience || null,
    tone_of_voice:        b.tone_of_voice || null,
    content_language:     b.content_language || 'English',
  };
}

function inferCountry(business) {
  // Explicit user choice always wins (set on Brand profile). Fall back to
  // a domain TLD heuristic for legacy orgs that signed up before the
  // country picker existed.
  if (business && business.country) return String(business.country).toUpperCase();
  const site = (business && business.website) || '';
  if (/\.co\.uk\b/i.test(site)) return 'GB';
  if (/\.com\.tr\b|\.tr\b/i.test(site)) return 'TR';
  if (/\.de\b/i.test(site)) return 'DE';
  return 'GB';
}

function nextMonthISO(month /* YYYY-MM */) {
  const [y, m] = month.split('-').map(Number);
  return { year: y, month: m };
}

// Build the system + user prompt for Claude's plan draft. We deliberately
// name every field so the model returns clean JSON we can trust.
function buildDraftPrompt({ business, month, targetCount, platformMix, specialDays, mode, constraints }) {
  const biz = businessCtx(business);
  const daysBlock = specialDays.days.length
    ? specialDays.days.map(d =>
        `  - ${d.date} · ${d.name} · tier ${d.tier} · ${d.type} (${(d.sources || [d.source]).join(', ')})`
      ).join('\n')
    : '  (none)';

  const system = `You are a senior social media content strategist.
You build monthly content calendars that feel authentic to the specific
business and are grounded in what is actually happening in that month.

Strict rules:
- Every plan item MUST clearly connect to the business_profile. No generic
  content that could come from any business.
- When a special day is relevant to the business or audience, use it — but
  do not force-tie unrelated days (e.g. don't tie a software company to a
  cooking holiday).
- Spread items through the month (avoid 3 posts in one day or 10-day gaps).
- Vary themes: mix of educational / promotional / behind-the-scenes /
  seasonal / community posts.
- Respect the platform mix.
- Output STRICT JSON only — no markdown, no prose.`;

  const user = `BUSINESS PROFILE:
${JSON.stringify(biz, null, 2)}

TARGET MONTH: ${month}  (${mode} mode)
TARGET NUMBER OF POSTS: ${targetCount}

PLATFORM MIX REQUESTED (roughly, across the ${targetCount} posts):
${JSON.stringify(platformMix || { instagram: 1 }, null, 2)}

SPECIAL DAYS IN THIS MONTH (country + industry + business-specific):
${daysBlock}

EXTRA CONSTRAINTS FROM THE USER:
${JSON.stringify(constraints || {}, null, 2)}

Produce a calendar of exactly ${targetCount} plan items.
Each item:
{
  "scheduled_for": "YYYY-MM-DDTHH:mm:00.000Z",   -- UTC. Prefer business-hours posting. Spread across the month.
  "theme":         "short slug: 'weekly_tip' | 'product_highlight' | 'customer_story' | 'holiday:xmas' | 'awareness:cybersecurity' | ...",
  "topic_brief":   "1-2 sentence brief you'd hand to a copywriter. Concrete, business-grounded, includes any special-day tie-in.",
  "platforms":     ["instagram" | "linkedin" | "facebook"],
  "reasoning":     "One short sentence explaining why this date + topic + platform make sense for THIS business."
}

Output exactly this shape:
{ "items": [ ... ] }

IMPORTANT:
- scheduled_for must be within the target month.
- If a special day is relevant, tie exactly one item to it (not several).
- Don't pile all items on the same weekday; include weekends sparingly.`;

  return { system, user };
}

async function draftPlan(args) {
  const { system, user } = buildDraftPrompt(args);
  const anthropic = getAnthropic();

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 3500,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const raw = resp.content[0].text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '');
  const parsed = JSON.parse(raw);
  const items = Array.isArray(parsed.items) ? parsed.items : [];

  // Sanity / defensive normalization
  const normalized = items
    .filter((it) => it && it.scheduled_for && it.topic_brief)
    .map((it) => ({
      scheduled_for: String(it.scheduled_for),
      theme:         String(it.theme || 'general').slice(0, 80),
      topic_brief:   String(it.topic_brief).slice(0, 1000),
      platforms:     Array.isArray(it.platforms) && it.platforms.length
                       ? it.platforms.map(String).slice(0, 4)
                       : ['instagram'],
      reasoning:     String(it.reasoning || '').slice(0, 400),
    }));

  // Sort by date for a clean preview
  normalized.sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for));
  return normalized;
}

/**
 * End-to-end plan preview — does NOT persist anything.
 *
 * @param {object} opts
 * @param {object} opts.business
 * @param {string} opts.month       - 'YYYY-MM'
 * @param {number} opts.targetCount - how many posts the user wants
 * @param {string} [opts.mode]      - 'calendar' | 'quota' | 'hybrid'
 * @param {object} [opts.platformMix] - e.g. { instagram: 0.6, linkedin: 0.4 }
 * @param {object} [opts.constraints] - free-form
 * @param {Array}  [opts.customDays]  - extra business-specific dates
 * @param {string} [opts.country]     - override auto-inferred country
 * @returns {{ plan, quality, specialDays }}
 */
async function planMonth({
  business, month, targetCount,
  mode = 'hybrid', platformMix, constraints, customDays, country,
}) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('month must be YYYY-MM');
  if (!Number.isFinite(targetCount) || targetCount < 1 || targetCount > 60) {
    throw new Error('targetCount must be between 1 and 60');
  }

  const { year, month: mm } = nextMonthISO(month);
  const specialDays = getSpecialDaysForMonth({
    year, month: mm,
    country: country || inferCountry(business),
    industry: business && business.industry,
    custom: customDays || [],
  });

  const planItems = await draftPlan({
    business, month, targetCount, platformMix, specialDays, mode, constraints,
  });

  // Multi-reviewer grade of the whole plan (uses the content_plan rubric)
  let quality = null;
  try {
    quality = await reviewArtifact({
      artifact:     { items: planItems, target_count: targetCount, platform_mix: platformMix || {} },
      artifactType: 'content_plan',
      context: {
        business:       businessCtx(business),
        month,
        target_count:   targetCount,
        special_days:   specialDays.days,
        constraints:    constraints || {},
      },
    });
  } catch (err) {
    console.error('[planner] review failed:', err.message);
    // Non-fatal — we still return the plan, just without quality
  }

  return { plan: planItems, quality, specialDays };
}

module.exports = { planMonth, draftPlan };
