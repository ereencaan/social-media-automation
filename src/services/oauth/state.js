// Signed, opaque CSRF state for OAuth flows.
//
// We issue a short-lived random nonce, sign it with SESSION_SECRET + HMAC,
// and also stash a server-side copy in req.session so a CSRF attacker can't
// forge a callback from a different browser. Callback verifies both:
//   (a) the signature is valid   (tamper detection)
//   (b) the nonce matches what's stashed in the session (cross-browser CSRF)
//   (c) the state is under 10 minutes old (replay limit)
//
// Flow:
//   - At authorize time: create(req, { platform, orgId })
//       -> returns an opaque token to put in the `state` query param
//   - At callback time:  verifyAndConsume(req, stateFromQuery)
//       -> returns the original { platform, orgId } or throws

const crypto = require('crypto');

const TTL_MS = 10 * 60 * 1000;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET must be set');
  return s;
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

function create(req, meta) {
  const nonce = crypto.randomBytes(18).toString('base64url');
  const issuedAt = Date.now();
  const payload = JSON.stringify({ nonce, issuedAt, meta });
  const b64 = Buffer.from(payload).toString('base64url');
  const sig = sign(b64);
  const token = `${b64}.${sig}`;

  req.session.oauthStates = req.session.oauthStates || {};
  // Clean up any stale nonces (older than TTL) to avoid session bloat
  for (const k of Object.keys(req.session.oauthStates)) {
    if (Date.now() - (req.session.oauthStates[k].issuedAt || 0) > TTL_MS) {
      delete req.session.oauthStates[k];
    }
  }
  req.session.oauthStates[nonce] = { issuedAt, meta };
  return token;
}

function verifyAndConsume(req, token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    throw new Error('Missing or malformed state');
  }
  const [b64, sig] = token.split('.');
  const expected = sign(b64);
  // Constant-time compare
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new Error('Invalid state signature');
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.from(b64, 'base64url').toString()); }
  catch { throw new Error('Malformed state payload'); }

  if (Date.now() - parsed.issuedAt > TTL_MS) throw new Error('State expired');

  const sessStates = (req.session && req.session.oauthStates) || {};
  const sess = sessStates[parsed.nonce];
  if (!sess) throw new Error('State not found in session (CSRF check failed)');

  // Consume — one-time use
  delete sessStates[parsed.nonce];
  return parsed.meta;
}

module.exports = { create, verifyAndConsume };
