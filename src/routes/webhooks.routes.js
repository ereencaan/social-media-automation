// Meta webhooks — receives Instagram DM + Facebook Page Message events
// and turns each new conversation into a lead.
//
// Meta's webhook protocol:
//   1. GET  /webhooks/meta  → echo hub.challenge if hub.verify_token matches
//      our META_WEBHOOK_VERIFY_TOKEN (set in Meta App dashboard).
//   2. POST /webhooks/meta  → payload signed with App Secret via
//      X-Hub-Signature-256. We validate the signature against the raw
//      body, then dispatch by object type:
//        - object: "instagram" → IG Business Account message
//        - object: "page"      → Facebook Page Message
//
// Org lookup: the event carries the business account id
// (entry.id for IG / page id for FB). We match against
// social_credentials.account_id to find the owning org. If no org has
// connected that account, we silently 200 the webhook (Meta retries
// aggressively on non-200s).

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { prepare } = require('../config/database');
const leadsService = require('../services/leads.service');

// req.rawBody is captured globally in src/app.js by the express.json
// verify hook — needed to HMAC-verify Meta's X-Hub-Signature-256.

function verifySignature(req) {
  const sig = req.get('X-Hub-Signature-256');
  if (!sig || !sig.startsWith('sha256=')) return false;
  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    console.error('[MetaWebhook] META_APP_SECRET not set — rejecting');
    return false;
  }
  const raw = req.rawBody || Buffer.from('');
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(raw)
    .digest('hex');
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// ---- GET /webhooks/meta — verification handshake ---------------------
router.get('/meta', (req, res) => {
  const mode  = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---- POST /webhooks/meta — event delivery ----------------------------
router.post('/meta', async (req, res) => {
  if (!verifySignature(req)) {
    console.warn('[MetaWebhook] signature mismatch — dropping');
    return res.sendStatus(401);
  }
  const body = req.body || {};
  // ACK immediately. Meta retries non-200s and we don't want to block
  // the HTTP response on Graph API lookups.
  res.sendStatus(200);

  try {
    if (body.object === 'instagram') {
      for (const entry of body.entry || []) {
        await handleInstagramEntry(entry);
      }
    } else if (body.object === 'page') {
      for (const entry of body.entry || []) {
        await handleFacebookEntry(entry);
      }
    }
    // Other objects (e.g. comments) ignored for now.
  } catch (err) {
    console.error('[MetaWebhook] processing error:', err);
  }
});

// ---- Instagram DM ----------------------------------------------------
async function handleInstagramEntry(entry) {
  const igBusinessId = entry.id;
  const cred = findCredential('instagram', igBusinessId);
  if (!cred) {
    console.warn('[MetaWebhook] IG message for unknown account_id=%s', igBusinessId);
    return;
  }
  for (const evt of entry.messaging || []) {
    // Skip echoes of our own outbound messages.
    if (evt.message?.is_echo) continue;
    const senderId = evt.sender?.id;
    const text     = evt.message?.text || '(media)';
    if (!senderId) continue;

    const profile = await fetchIgUserProfile(senderId, cred.access_token);
    await upsertLeadFromDm({
      orgId:     cred.org_id,
      platform:  'instagram',
      senderId,
      senderName: profile?.name || profile?.username || `IG ${senderId.slice(-6)}`,
      senderHandle: profile?.username ? '@' + profile.username : null,
      text,
    });
  }
}

async function fetchIgUserProfile(igsid, token) {
  try {
    const url = `https://graph.facebook.com/v19.0/${igsid}?fields=name,username,profile_pic&access_token=${encodeURIComponent(token)}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ---- Facebook Page Message -------------------------------------------
async function handleFacebookEntry(entry) {
  const pageId = entry.id;
  const cred = findCredential('facebook', pageId);
  if (!cred) {
    console.warn('[MetaWebhook] FB message for unknown page_id=%s', pageId);
    return;
  }
  for (const evt of entry.messaging || []) {
    if (evt.message?.is_echo) continue;
    const psid = evt.sender?.id;
    const text = evt.message?.text || '(media)';
    if (!psid) continue;

    const profile = await fetchFbUserProfile(psid, cred.access_token);
    const nameParts = [profile?.first_name, profile?.last_name].filter(Boolean);
    await upsertLeadFromDm({
      orgId:     cred.org_id,
      platform:  'facebook',
      senderId:  psid,
      senderName: nameParts.join(' ') || `FB ${psid.slice(-6)}`,
      senderHandle: null,
      text,
    });
  }
}

async function fetchFbUserProfile(psid, token) {
  try {
    const url = `https://graph.facebook.com/v19.0/${psid}?fields=first_name,last_name,profile_pic&access_token=${encodeURIComponent(token)}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ---- helpers ---------------------------------------------------------
function findCredential(platform, accountId) {
  return prepare(`
    SELECT org_id, access_token
    FROM social_credentials
    WHERE platform = ? AND account_id = ? AND status = 'active'
    LIMIT 1
  `).get(platform, accountId);
}

async function upsertLeadFromDm({ orgId, platform, senderId, senderName, senderHandle, text }) {
  const source     = platform === 'instagram' ? 'instagram_dm' : 'facebook_message';
  const sourceRef  = senderId;
  const notes      = senderHandle ? `Handle: ${senderHandle}` : null;

  const lead = leadsService.createLead(orgId, {
    source, sourceRef,
    name: senderName,
    notes,
  });
  leadsService.addActivity(orgId, lead.id, null, {
    type: 'message',
    content: text,
    metadata: { platform, senderId, senderHandle, inbound: true },
  });
}

module.exports = router;
