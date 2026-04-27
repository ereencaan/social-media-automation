// Email-to-lead parser — turns an inbound email payload (currently from
// SendGrid Inbound Parse, but the shape is generic enough to swap providers
// later) into the same flat lead structure the rest of the intake pipeline
// expects.
//
// What we extract:
//   * name         — from the "From" display name, or guessed from the
//                    local-part of the address as a last resort
//   * email        — the sender address (lowercased, trimmed)
//   * phone        — first plausible phone-shaped string in the body
//   * message      — text body if present, else stripped HTML
//   * source       — guessed from the sender's domain or subject markers
//                    (notifications@tidio.com → tidio_livechat,
//                     [Contact Form 7] subject → wordpress_form, etc.)
//   * sourceRef    — RFC-822 Message-Id when we can parse it; otherwise a
//                    SHA1 of from+subject+date so retries are idempotent
//
// We intentionally don't pull in any HTML or MIME parsing libraries — the
// provider already gives us the decoded text/html parts. A tiny regex
// stripper is enough for the message preview, and it keeps the dep tree
// clean.

const crypto = require('crypto');

// ---- Source detection ---------------------------------------------------
//
// Map of "from" domain → canonical chip id. When the inbound mail clearly
// came from a known notification sender, we tag the lead with that chip
// so the kanban shows where it really originated. Anything not matched
// here falls through to the subject-based detector and finally to
// `email` (generic).
const SOURCE_BY_FROM_DOMAIN = {
  'tidio.com':                'tidio_livechat',
  'tidio.co':                 'tidio_livechat',
  'notifications.tidio.com':  'tidio_livechat',
  'tawk.to':                  'tawk',
  'crisp.chat':               'crisp',
  'help.crisp.chat':          'crisp',
  'smartsupp.com':            'smartsupp',
  'livechatinc.com':          'livechat',
  'livechat.com':             'livechat',
  'jivochat.com':             'livechat',
};

// WordPress form plugins all email the site owner with a recognisable
// subject prefix. We sniff the subject (and body, as a fallback) so any
// CF7 / WPForms / Elementor / Gravity / Ninja notification ends up under
// the single `wordpress_form` chip.
const WORDPRESS_SUBJECT_HINTS = [
  /\bcontact form 7\b/i,
  /\[CF7\]/i,
  /\bwpforms\b/i,
  /\belementor\s*forms?\b/i,
  /\bgravity\s*forms?\b/i,
  /\bninja\s*forms?\b/i,
  /\bformidable\b/i,
  /\bnew form submission\b/i,
];

function detectSource({ fromAddress, subject = '', text = '' }) {
  if (fromAddress) {
    const domain = fromAddress.split('@')[1];
    if (domain) {
      const lower = domain.toLowerCase();
      if (SOURCE_BY_FROM_DOMAIN[lower]) return SOURCE_BY_FROM_DOMAIN[lower];
      // Match parent domain too: notifications.tidio.com → tidio.com
      const parts = lower.split('.');
      for (let i = 1; i < parts.length - 1; i++) {
        const parent = parts.slice(i).join('.');
        if (SOURCE_BY_FROM_DOMAIN[parent]) return SOURCE_BY_FROM_DOMAIN[parent];
      }
    }
  }
  const corpus = `${subject || ''}\n${(text || '').slice(0, 400)}`;
  for (const re of WORDPRESS_SUBJECT_HINTS) {
    if (re.test(corpus)) return 'wordpress_form';
  }
  return 'email';
}

// ---- Address parsing ----------------------------------------------------
//
// Inbound "From" headers come in two common shapes:
//   "Jane Doe" <jane@example.com>
//   jane@example.com
// We split into displayName + address. If displayName is absent we leave
// it null and let the caller fall back to the local-part guess.
// We preserve case on the local-part because our per-org intake tokens
// are mixed-case base64url (e.g. "4rcamU1qxByQ...") and lowercasing the
// whole address would break token lookup. Domains are case-insensitive
// in RFC 5321 anyway, but callers that need to compare them lowercase
// the domain side themselves.
function parseAddress(raw) {
  if (!raw || typeof raw !== 'string') return { displayName: null, address: null };
  const s = raw.trim();
  // "Display Name" <addr@x>  /  Display Name <addr@x>
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<\s*([^>]+?)\s*>\s*$/);
  if (m) {
    const display = m[1].trim();
    return {
      displayName: display || null,
      address: m[2].trim(),
    };
  }
  // Bare address.
  if (s.includes('@')) {
    return { displayName: null, address: s };
  }
  return { displayName: null, address: null };
}

// "john.smith" → "John Smith" — only used when the From has no display
// name. Returns null for robotic-looking local parts (noreply, info, etc.)
// so we don't end up with leads named "Noreply".
const ROBOT_LOCAL_PARTS = new Set([
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'info', 'admin', 'support', 'hello', 'contact',
  'notifications', 'notify', 'mailer-daemon',
]);
function guessNameFromLocalPart(local) {
  if (!local) return null;
  const cleaned = local.toLowerCase().replace(/[+].*$/, ''); // drop +tag
  if (ROBOT_LOCAL_PARTS.has(cleaned)) return null;
  const parts = cleaned.split(/[._-]+/).filter(Boolean);
  if (!parts.length) return null;
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

// ---- Phone extraction ---------------------------------------------------
//
// Plausible-looking phone numbers in the body. We don't try to be perfect:
// "first sequence of 10–15 digits with optional country prefix and
// separators" catches +44 7700 900 123 / 07700-900-123 / (212) 555-1234
// without false-positiving on order numbers or invoice IDs.
const PHONE_RE = /(?:\+?\d[\d\s().-]{8,17}\d)/;
function extractPhone(text) {
  if (!text) return null;
  const m = String(text).match(PHONE_RE);
  if (!m) return null;
  const digits = m[0].replace(/[^\d+]/g, '');
  // Reject if total digit count outside [10, 15] — the regex is
  // permissive about separators so we re-check the digit budget here.
  const digitCount = digits.replace(/\D/g, '').length;
  if (digitCount < 10 || digitCount > 15) return null;
  return digits;
}

// ---- HTML-to-text -------------------------------------------------------
//
// Lightweight stripper: drop scripts/styles, replace breaks with newlines,
// strip tags, decode the handful of entities that turn up in chat
// notifications. Good enough for the lead "notes" preview — full message
// content is preserved in raw form on the activity metadata.
function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/?(br|p|div|tr|li|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- Message-Id extraction ----------------------------------------------
//
// SendGrid passes the full headers blob in a single string. RFC-822
// Message-Id is unique per email so it's the natural source_ref for
// idempotent dedupe — the same email retried by the provider lands on
// the same lead row instead of duplicating.
function extractMessageId(headersBlob) {
  if (!headersBlob || typeof headersBlob !== 'string') return null;
  const m = headersBlob.match(/^Message-Id:\s*(<[^>]+>|\S+)\s*$/im);
  if (!m) return null;
  return m[1].replace(/^[<\s]+|[>\s]+$/g, '');
}

// Fallback dedupe key when no Message-Id is present.
function fallbackRef(from, subject, date) {
  const key = `${from || ''}\n${subject || ''}\n${date || ''}`;
  return 'em_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

// ---- Token extraction ---------------------------------------------------
//
// The "to" field on inbound mail is the per-org forwarding address:
//   <intakeToken>@leads.hitrapost.co.uk
// We strip the local-part and use it as the org's intake_token. Multiple
// recipients are tolerated — first one in the leads.* domain wins.
function extractToken(toRaw, expectedDomain) {
  if (!toRaw) return null;
  const recipients = String(toRaw).split(',');
  const wantDomain = (expectedDomain || '').toLowerCase().trim();
  for (const r of recipients) {
    const { address } = parseAddress(r);
    if (!address) continue;
    const atIdx = address.lastIndexOf('@');
    if (atIdx < 0) continue;
    const local = address.slice(0, atIdx);     // preserve token case
    const domain = address.slice(atIdx + 1);
    if (!local || !domain) continue;
    if (wantDomain && domain.toLowerCase() !== wantDomain) continue;
    return local;
  }
  return null;
}

// ---- Main parser --------------------------------------------------------
//
// Accepts the field map the provider gave us. Returns the same shape
// intake.service.ingest() would build internally so we can hand it off
// to the existing lead-creation code.
function parseInboundEmail(payload = {}) {
  const fromRaw     = payload.from || '';
  const toRaw       = payload.to || (payload.envelope && payload.envelope.to) || '';
  const subject     = payload.subject || '';
  const text        = payload.text || '';
  const html        = payload.html || '';
  const headersBlob = payload.headers || '';

  const { displayName, address: fromAddress } = parseAddress(fromRaw);

  const localPart = fromAddress ? fromAddress.split('@')[0] : null;
  const name = displayName || guessNameFromLocalPart(localPart);

  const bodyText = text || htmlToText(html);
  const phone    = extractPhone(`${bodyText}\n${subject}`);

  const source    = detectSource({ fromAddress, subject, text: bodyText });
  const sourceRef = extractMessageId(headersBlob)
    || fallbackRef(fromRaw, subject, payload.date || '');

  const messageBody = subject ? `${subject}\n\n${bodyText}` : bodyText;

  return {
    toRaw,
    name,
    email: fromAddress,
    phone,
    message: messageBody.slice(0, 8000), // bound the size — full raw is on activity
    source,
    sourceRef,
    raw: { from: fromRaw, to: toRaw, subject, headers: headersBlob },
  };
}

module.exports = {
  parseInboundEmail,
  extractToken,
  // Exported for tests / debugging.
  parseAddress,
  detectSource,
  htmlToText,
  extractPhone,
  extractMessageId,
};
