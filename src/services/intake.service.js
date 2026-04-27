// Generic intake service — backs POST /api/intake/:token.
//
// Contract:
//   * Each org has a single rotatable intake_token (generated lazily on
//     first read from Settings, or explicitly via regenerate).
//   * Anyone holding the token can file a lead into that org's CRM, so
//     rotation is the one escape hatch when a token leaks.
//   * Payload normalization is forgiving: we try common field names
//     (name|full_name|contact, email|emailAddress, phone|tel|mobile,
//      message|comment|body, source|channel) so Typeform / Zapier / plain
//     HTML forms all "just work" without a mapping step.

const crypto = require('crypto');
const { prepare } = require('../config/database');
const leadsService = require('./leads.service');

function generateToken() {
  // 24 bytes = 32 url-safe chars. Enough entropy, short enough to paste.
  return crypto.randomBytes(24).toString('base64url');
}

function getOrgByToken(token) {
  if (!token || typeof token !== 'string') return null;
  return prepare('SELECT id, name FROM orgs WHERE intake_token = ?').get(token);
}

function getOrCreateToken(orgId) {
  const row = prepare('SELECT intake_token FROM orgs WHERE id = ?').get(orgId);
  if (!row) throw new Error('Org not found');
  if (row.intake_token) return row.intake_token;
  const token = generateToken();
  prepare('UPDATE orgs SET intake_token = ? WHERE id = ?').run(token, orgId);
  return token;
}

function regenerateToken(orgId) {
  const token = generateToken();
  prepare('UPDATE orgs SET intake_token = ? WHERE id = ?').run(token, orgId);
  return token;
}

// ---- payload normalization ---------------------------------------------

// Source aliases — incoming payloads use whatever string the integration
// sender chose (Tidio sends "tidio", our WP plugin sends "wp_cf7", etc).
// We normalize to the canonical chip ids the frontend renders. Anything we
// don't recognise is passed through unchanged so custom integrations work.
const SOURCE_ALIASES = {
  // Live-chat platforms.
  'tidio':            'tidio_livechat',
  'tidio_chat':       'tidio_livechat',
  'tidio.com':        'tidio_livechat',
  'tawk.to':          'tawk',
  'tawkto':           'tawk',
  'crisp.chat':       'crisp',
  'smartsupp.com':    'smartsupp',
  'livechat.com':     'livechat',
  'livechatinc':      'livechat',
  'jivochat':         'livechat',     // close enough for chip purposes
  // WordPress form plugins — all funnel through one chip.
  'wp':               'wordpress_form',
  'wordpress':        'wordpress_form',
  'wp_cf7':           'wordpress_form',
  'cf7':              'wordpress_form',
  'wpforms':          'wordpress_form',
  'gravity':          'wordpress_form',
  'gravityforms':     'wordpress_form',
  'ninja':            'wordpress_form',
  'ninjaforms':       'wordpress_form',
  'elementor':        'wordpress_form',
  'elementor_form':   'wordpress_form',
  // Email forwarding.
  'email_forward':    'email',
  'forwarded_email':  'email',
};

function canonicalSource(rawSource) {
  if (!rawSource) return 'webhook';
  const cleaned = String(rawSource).trim().toLowerCase();
  return SOURCE_ALIASES[cleaned] || cleaned;
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && String(obj[k]).trim() !== '') return String(obj[k]).trim();
  }
  return null;
}

// Accepts a flat object from the caller and maps common aliases. Unknown
// fields are preserved on the activity's metadata so no data is lost.
function normalizePayload(body = {}) {
  const name = pickFirst(body, [
    'name', 'full_name', 'fullName', 'contact', 'contact_name',
  ]);
  const email = pickFirst(body, [
    'email', 'emailAddress', 'email_address',
  ]);
  const phone = pickFirst(body, [
    'phone', 'tel', 'mobile', 'phone_number', 'phoneNumber',
  ]);
  const message = pickFirst(body, [
    'message', 'comment', 'body', 'text', 'note', 'notes',
  ]);
  const source = canonicalSource(pickFirst(body, [
    'source', 'channel', 'utm_source',
  ]));
  const sourceRef = pickFirst(body, [
    'source_ref', 'sourceRef', 'submission_id', 'id', 'external_id',
  ]);
  return { name, email, phone, message, source, sourceRef, raw: body };
}

function ingest(orgId, rawBody) {
  const norm = normalizePayload(rawBody);
  if (!norm.name && !norm.email && !norm.phone) {
    const err = new Error('Payload must include at least one of: name, email, phone');
    err.status = 422;
    throw err;
  }
  const lead = leadsService.createLead(orgId, {
    source:    norm.source,
    sourceRef: norm.sourceRef,
    name:      norm.name,
    email:     norm.email,
    phone:     norm.phone,
    notes:     norm.message,
  });
  // Always log the raw payload on the lead timeline. If the lead already
  // existed (dedup hit) we still append — useful for repeat submissions.
  leadsService.addActivity(orgId, lead.id, null, {
    type: 'message',
    content: norm.message || '(no message)',
    metadata: { intake: true, source: norm.source, payload: norm.raw },
  });
  return lead;
}

// ---- Tawk.to webhook ingest --------------------------------------------
//
// Tawk fires several event types per chat:
//   chat:start        — visitor sent first message (pre-chat survey already
//                       filled if enabled); body has visitor + first message
//   chat:end          — chat closed (no new lead info)
//   chat:transcript   — full transcript after end; body has messages[]
//   ticket:create     — offline form submitted; body has ticket fields
// We turn chat:start, chat:transcript, ticket:create into leads (deduped on
// chatId/ticketId via leads.source_ref). Other events are accepted with 200
// to keep Tawk from retrying.
function ingestTawk(orgId, body = {}) {
  const event = body.event;
  if (!event) return null;
  if (!['chat:start', 'chat:transcript', 'ticket:create'].includes(event)) {
    return null; // accepted but no lead produced
  }

  const visitor = body.visitor || (body.ticket && body.ticket.visitor) || {};
  // Tawk auto-generates names like "Visitor 1234567890" when no pre-chat
  // survey is configured — treat those as "no name".
  const rawName = visitor.name ? String(visitor.name).trim() : null;
  const name = rawName && !/^Visitor\s+\d+$/i.test(rawName) ? rawName : null;
  const email = visitor.email ? String(visitor.email).trim() : null;
  const phone = visitor.phone ? String(visitor.phone).trim() : null;

  let message = null;
  if (event === 'chat:start') {
    if (typeof body.message === 'string') message = body.message;
    else if (body.message && body.message.text) message = body.message.text;
  } else if (event === 'chat:transcript' && Array.isArray(body.messages)) {
    message = body.messages
      .map((m) => {
        const who = m && m.sender && m.sender.t === 'a' ? 'agent' : 'visitor';
        const text = m && (m.msg || m.text) ? (m.msg || m.text) : '';
        return `${who}: ${text}`;
      })
      .filter(Boolean)
      .join('\n');
  } else if (event === 'ticket:create') {
    const t = body.ticket || body;
    const subject = t.subject || null;
    const ticketMsg = t.message || t.body || null;
    message = [subject, ticketMsg].filter(Boolean).join('\n');
  }

  // Need at least one identifier to create a lead. Anonymous chats with no
  // contact info are accepted but skipped (Tawk still gets 200).
  if (!name && !email && !phone) return null;

  const sourceRef = body.chatId
    || (body.ticket && body.ticket.id)
    || body.ticketId
    || null;

  const lead = leadsService.createLead(orgId, {
    source:    'tawk',
    sourceRef,
    name, email, phone,
    notes:     message,
  });

  leadsService.addActivity(orgId, lead.id, null, {
    type: 'message',
    content: message || '(no message)',
    metadata: { tawk: true, event, payload: body },
  });

  return lead;
}

// ---- Email-to-lead ingest ----------------------------------------------
//
// Inbound emails from SendGrid Inbound Parse (or any provider with the
// same shape — easy to swap) get parsed into the same flat structure
// /api/intake uses, then handed to leadsService. The token comes from
// the local-part of the recipient address, e.g.
// "abc123@leads.hitrapost.co.uk" → intake_token = "abc123".
//
// Returns the lead on success, or null when the email had nothing to
// pin a lead on (no name, email, or phone). The route always responds
// 200 to the provider so retries don't pile up — it's better to drop a
// junk auto-reply than to flood SendGrid's retry queue.
function ingestEmail(orgId, parsed = {}) {
  if (!orgId) throw new Error('orgId required');
  if (!parsed.name && !parsed.email && !parsed.phone) return null;

  const lead = leadsService.createLead(orgId, {
    source:    parsed.source || 'email',
    sourceRef: parsed.sourceRef,
    name:      parsed.name,
    email:     parsed.email,
    phone:     parsed.phone,
    notes:     parsed.message,
  });

  leadsService.addActivity(orgId, lead.id, null, {
    type: 'email',
    content: parsed.message || '(no body)',
    metadata: {
      email: true,
      source: parsed.source,
      from: parsed.raw && parsed.raw.from,
      to: parsed.raw && parsed.raw.to,
      subject: parsed.raw && parsed.raw.subject,
    },
  });

  return lead;
}

module.exports = {
  getOrgByToken, getOrCreateToken, regenerateToken,
  normalizePayload, canonicalSource, ingest, ingestTawk, ingestEmail,
  SOURCE_ALIASES,
};
