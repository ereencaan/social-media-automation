// Fetches a website, strips it down to readable text, and asks Claude to
// extract a business profile. Used by POST /api/brand/autofill-from-website.
//
// Works reliably for static / server-rendered marketing sites. SPA-heavy
// sites that render everything client-side will return thin content; we
// still try and let the model work with meta tags.

const Anthropic = require('@anthropic-ai/sdk');

const FETCH_TIMEOUT_MS = 12_000;
const MAX_HTML_BYTES   = 800_000;   // hard cap on downloaded bytes
const MAX_TEXT_CHARS   = 18_000;    // cap on extracted text fed to Claude

function normalizeUrl(input) {
  if (!input) throw new Error('URL is required');
  let url = String(input).trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let parsed;
  try { parsed = new URL(url); }
  catch { throw new Error('Invalid URL'); }

  // Block private / loopback ranges to avoid SSRF against internal services.
  const host = parsed.hostname.toLowerCase();
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(host);
  const isPrivate =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    (isIp && (
      host.startsWith('10.') ||
      host.startsWith('127.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host === '0.0.0.0'
    ));
  if (isPrivate) throw new Error('Refusing to fetch a private / loopback address');

  // Only allow http(s)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are supported');
  }
  return parsed.toString();
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // Pose as a real browser so sites that gate bots still return HTML
        'User-Agent': 'Mozilla/5.0 (compatible; HitraBot/1.0; +https://hitratech.co.uk)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en,tr;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`Website returned HTTP ${res.status}`);

    const ct = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(ct)) {
      throw new Error(`Unexpected content-type: ${ct || 'unknown'}`);
    }

    // Read with a byte cap so a huge page can't exhaust memory
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_HTML_BYTES) {
        chunks.push(value.slice(0, Math.max(0, MAX_HTML_BYTES - (total - value.byteLength))));
        break;
      }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map(Buffer.from));
    return buf.toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

function extractText(html) {
  // Pull structured signals first
  const get = (re) => { const m = html.match(re); return m ? m[1].trim() : ''; };
  const title = get(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDesc = get(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i)
                || get(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']description["']/i);
  const ogDesc  = get(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
  const ogTitle = get(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i);

  // Strip noisy elements entirely
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  // Keep paragraph / heading boundaries as newlines so structure survives
  body = body.replace(/<\/(p|h[1-6]|li|div|section|article|header|footer|br)\s*>/gi, '\n');
  body = body.replace(/<[^>]+>/g, ' '); // strip remaining tags

  // Decode a few common HTML entities
  body = body
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–');

  // Collapse whitespace
  body = body.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  // Build the condensed text we feed to Claude — structured signals first,
  // then body, clipped to a generous but bounded length.
  const parts = [];
  if (title)    parts.push(`TITLE: ${title}`);
  if (ogTitle && ogTitle !== title) parts.push(`OG_TITLE: ${ogTitle}`);
  if (metaDesc) parts.push(`META_DESCRIPTION: ${metaDesc}`);
  if (ogDesc && ogDesc !== metaDesc) parts.push(`OG_DESCRIPTION: ${ogDesc}`);
  parts.push('\n--- BODY ---');
  parts.push(body);

  let out = parts.join('\n');
  if (out.length > MAX_TEXT_CHARS) out = out.slice(0, MAX_TEXT_CHARS) + '\n…[truncated]';
  return {
    title, metaDesc, ogDesc, ogTitle,
    text: out,
    rawLength: body.length,
  };
}

let anthropicClient = null;
function getAnthropic() {
  if (!anthropicClient) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

async function analyzeWebsite(url) {
  const safeUrl = normalizeUrl(url);
  const html = await fetchHtml(safeUrl);
  const extracted = extractText(html);

  if (extracted.rawLength < 80 && !extracted.metaDesc && !extracted.title) {
    throw new Error('Could not read meaningful content from the website (it may be JS-rendered or empty).');
  }

  const anthropic = getAnthropic();
  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 900,
    system:
      'You analyze company websites and extract their business profile. ' +
      'Be accurate and grounded — never invent facts that are not supported by the page. ' +
      'If a field cannot be inferred with reasonable confidence, return an empty string for it.',
    messages: [{
      role: 'user',
      content:
`Analyze the following website content and return a JSON object describing the business.

Website: ${safeUrl}

CONTENT:
"""
${extracted.text}
"""

Return ONLY raw JSON (no markdown) matching this schema — values must be plain strings:
{
  "business_name":        "Short official name of the company",
  "industry":             "Industry / vertical in 2-6 words (e.g. 'B2B SaaS', 'Boutique fitness studio', 'E-commerce apparel')",
  "business_description": "2-4 sentences describing what the business does, the key products/services, and what makes them distinct. Written in third person.",
  "target_audience":      "Who their customers are, in 1-2 sentences",
  "tone_of_voice":        "One of: professional, friendly, playful, bold, authoritative, casual, inspirational",
  "content_language":     "Primary language of the site content, capitalized (e.g. 'English', 'Turkish')"
}`,
    }],
  });

  const text = resp.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  let parsed;
  try { parsed = JSON.parse(text); }
  catch {
    throw new Error('Model returned non-JSON response; try again');
  }

  // Only return the fields we know about; drop anything else
  const allowed = ['business_name', 'industry', 'business_description', 'target_audience', 'tone_of_voice', 'content_language'];
  const out = {};
  for (const k of allowed) if (typeof parsed[k] === 'string') out[k] = parsed[k].trim();

  return {
    url: safeUrl,
    profile: out,
    meta: { title: extracted.title, description: extracted.metaDesc || extracted.ogDesc || '' },
  };
}

module.exports = { analyzeWebsite };
