// Review rubric registry. A rubric defines the axes a reviewer grades an
// artifact on. Each rubric is owned by a single artifact_type so we can add
// new types (email, automation-script, landing-page copy, ...) without
// changing the reviewer code itself.

const RUBRICS = {
  // Social media post: caption + hashtags + platform variants + image prompt
  social_post: {
    axes: [
      { key: 'brand_fit',        label: 'Brand fit',        weight: 0.35,
        desc: 'How obviously this post comes from the specific business profile. A generic post scores low.' },
      { key: 'engagement',       label: 'Engagement',       weight: 0.25,
        desc: 'Likelihood to stop the scroll and earn reactions on the target platforms.' },
      { key: 'clarity',          label: 'Clarity',          weight: 0.15,
        desc: 'Is the message and CTA unambiguous? Tight copy, no filler?' },
      { key: 'hashtag_quality',  label: 'Hashtags',         weight: 0.10,
        desc: 'Relevance, mix of broad + niche tags, no spam, no all-generics.' },
      { key: 'image_prompt',     label: 'Image prompt',     weight: 0.15,
        desc: 'How well the image description evokes the specific business (not just the topic).' },
    ],
    systemExtras: [
      'Penalize HEAVILY when the content is generic and could have come from any business.',
      'Penalize when the imagePrompt describes something disconnected from the business.',
      'Penalize hashtag mixes that are all top-level generics without any business-specific or industry-specific tags.',
    ],
  },

  // Outbound lead email (future use by lead management flow)
  lead_email: {
    axes: [
      { key: 'brand_fit',   label: 'Brand fit',   weight: 0.30,
        desc: 'Does the copy feel like it comes from the sender\'s business and fit the tone of voice?' },
      { key: 'relevance',   label: 'Relevance',   weight: 0.30,
        desc: 'Is the pitch relevant to this specific lead (their industry, role, inferred interests)?' },
      { key: 'clarity',     label: 'Clarity',     weight: 0.15,
        desc: 'Clear subject, tight intro, obvious next step.' },
      { key: 'cta',         label: 'CTA',         weight: 0.15,
        desc: 'Single, specific call-to-action. No vague "let me know if interested".' },
      { key: 'risk',        label: 'Risk / spamminess', weight: 0.10,
        desc: 'Lower if the email reads spammy, over-promises, or could trigger spam filters. Higher = safer.' },
    ],
    systemExtras: [
      'Treat this as a cold or warm outbound email. Flag manipulative/spammy phrasing.',
      'Penalize generic templates that make no reference to the specific lead\'s business.',
    ],
  },

  // Monthly content plan — not a single post but a whole calendar
  content_plan: {
    axes: [
      { key: 'distribution',   label: 'Distribution', weight: 0.20,
        desc: 'Are the posts well-spread across the month? Not clustered, not gappy. Weekends used appropriately.' },
      { key: 'variety',        label: 'Variety',      weight: 0.25,
        desc: 'Mix of themes (educational/promotional/community/seasonal/behind-the-scenes). No repetition of the same topic angle.' },
      { key: 'brand_fit',      label: 'Brand fit',    weight: 0.30,
        desc: 'Every item obviously ties to THIS business\'s services and audience. No generic fillers.' },
      { key: 'special_day_use',label: 'Special days', weight: 0.15,
        desc: 'Relevant holidays/industry days are used — once each, in a way that connects to the business. Irrelevant ones are skipped.' },
      { key: 'platform_fit',   label: 'Platform fit', weight: 0.10,
        desc: 'Platform mix matches the request. Each topic picked a sensible platform for its format.' },
    ],
    systemExtras: [
      'You are grading a monthly content calendar as a whole, not individual posts.',
      'Penalize clumping (3 posts on Monday, nothing Tues-Thu).',
      'Penalize forced holiday tie-ins (e.g. a B2B SaaS posting about Valentine\'s day with no clear business angle).',
      'Penalize when most items could have been written for any business in the same industry.',
    ],
  },

  // User prompt pre-analysis (check before an expensive generation)
  prompt_quality: {
    axes: [
      { key: 'clarity',      label: 'Clarity',      weight: 0.35,
        desc: 'Is the user\'s request clear and actionable? No ambiguous pronouns, contradictions, or missing subjects.' },
      { key: 'specificity',  label: 'Specificity',  weight: 0.35,
        desc: 'Does the prompt include enough concrete detail (audience, offer, constraints) to produce good content?' },
      { key: 'fit',          label: 'Business fit', weight: 0.20,
        desc: 'Does it naturally connect to the business profile, or is it totally off-topic?' },
      { key: 'safety',       label: 'Safety',       weight: 0.10,
        desc: 'Free of claims that would be legally or ethically risky for the business to publish.' },
    ],
    systemExtras: [
      'You are helping the user BEFORE they burn tokens on generation. Be constructive: if the prompt is weak, say specifically what to add.',
    ],
  },
};

function getRubric(type) {
  const r = RUBRICS[type];
  if (!r) throw new Error(`Unknown rubric type: ${type}`);
  return r;
}

// Shared system prompt seed; each reviewer flavors this with its own
// prologue (e.g. "You are Claude acting as a brand editor...").
function buildSharedInstructions(rubric) {
  const axisLines = rubric.axes.map(a =>
    `- ${a.key} (${Math.round(a.weight * 100)}%): ${a.desc}`
  ).join('\n');

  return [
    ...rubric.systemExtras,
    '',
    'Grade the artifact on these axes, each 0-100:',
    axisLines,
    '',
    'Return STRICT JSON only (no markdown, no prose outside JSON), matching exactly:',
    '{',
    '  "scores": {',
    ...rubric.axes.map(a => `    "${a.key}": <0-100>,`),
    '  },',
    '  "overall":     <0-100, weighted by the percentages above>,',
    '  "issues":      [ "concise issue", "..." ],',
    '  "suggestions": [ "specific, actionable suggestion", "..." ],',
    '  "verdict":     "<one short sentence>"',
    '}',
  ].join('\n');
}

function buildUserPayload({ artifact, context, rubric }) {
  return `CONTEXT (what the reviewer needs to know about the business / target):
${JSON.stringify(context || {}, null, 2)}

ARTIFACT TO GRADE (JSON):
${JSON.stringify(artifact, null, 2)}

${buildSharedInstructions(rubric)}`;
}

module.exports = { RUBRICS, getRubric, buildSharedInstructions, buildUserPayload };
