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

module.exports = {
  getOrgByToken, getOrCreateToken, regenerateToken,
  normalizePayload, canonicalSource, ingest,
  SOURCE_ALIASES,
};
