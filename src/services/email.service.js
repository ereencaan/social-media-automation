// Transactional email — Resend.
//
// Resend is the recommended provider (3000/mo free, Node SDK trivial).
// We use plain fetch instead of pulling in @resend/node to keep the
// dependency footprint small — the API surface we need is a single
// POST.
//
// Configuration (.env):
//   RESEND_API_KEY              re_xxx
//   EMAIL_FROM                  "Hitrapost <hello@hitrapost.co.uk>"
//   PUBLIC_BASE_URL             https://hitrapost.co.uk
//
// Without RESEND_API_KEY the service no-ops (logs the email to stdout).
// That keeps local dev unblocked and means missing config can never
// crash a signup.

const RESEND_API = 'https://api.resend.com/emails';

function isConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

function from() {
  return process.env.EMAIL_FROM || 'Hitrapost <noreply@hitrapost.co.uk>';
}

function publicUrl(path = '') {
  const base = (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  return base + (path.startsWith('/') ? path : `/${path}`);
}

/**
 * Send a transactional email. Returns { id } on success or { skipped: true }
 * if Resend isn't configured. Throws only on hard delivery errors — caller
 * should NOT treat verification email failure as a signup failure (the user
 * can request a resend).
 */
async function send({ to, subject, html, text }) {
  if (!isConfigured()) {
    console.log(`[email:STUB] to=${to} subject="${subject}"`);
    if (text) console.log(`[email:STUB] body:\n${text}`);
    return { skipped: true };
  }

  const res = await fetch(RESEND_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: from(),
      to: [to],
      subject,
      html,
      text,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Resend ${res.status}: ${body.slice(0, 200)}`);
    err.statusCode = res.status;
    throw err;
  }
  return res.json();
}

// ---- Templates -------------------------------------------------------------
// Inline HTML, single-color, bulletproof. Email clients hate fancy CSS.

function emailLayout(bodyHtml) {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f5f7;font-family:Inter,Helvetica,Arial,sans-serif;color:#0b0d12">
  <div style="max-width:560px;margin:24px auto;background:white;border-radius:12px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,0.04)">
    <div style="font-size:20px;font-weight:700;letter-spacing:-0.01em;margin-bottom:20px;color:#0b0d12">Hitrapost</div>
    ${bodyHtml}
    <hr style="border:0;border-top:1px solid #e5e5ea;margin:28px 0 16px" />
    <p style="font-size:12px;color:#6b7185;line-height:1.5">
      You're receiving this because you signed up for Hitrapost. If this wasn't you, ignore this email.
    </p>
  </div>
</body></html>`;
}

async function sendVerificationEmail({ to, name, token }) {
  const link = publicUrl(`/api/auth/verify-email?token=${encodeURIComponent(token)}`);
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const html = emailLayout(`
    <p>${greeting}</p>
    <p>Click the button below to verify your email and unlock content generation on Hitrapost.</p>
    <p style="margin:24px 0">
      <a href="${link}"
         style="display:inline-block;background:#6366f1;color:white;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">
        Verify email
      </a>
    </p>
    <p style="font-size:13px;color:#6b7185">Or paste this link into your browser:<br><span style="word-break:break-all">${link}</span></p>
    <p style="font-size:13px;color:#6b7185">This link expires in 24 hours.</p>
  `);
  const text = `${greeting}\n\nVerify your email by visiting:\n${link}\n\nLink expires in 24 hours.`;
  return send({ to, subject: 'Verify your Hitrapost email', html, text });
}

async function sendPasswordResetEmail({ to, name, token }) {
  const link = publicUrl(`/?reset_token=${encodeURIComponent(token)}#reset-password`);
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const html = emailLayout(`
    <p>${greeting}</p>
    <p>You asked to reset your password. Click below to set a new one:</p>
    <p style="margin:24px 0">
      <a href="${link}"
         style="display:inline-block;background:#6366f1;color:white;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">
        Reset password
      </a>
    </p>
    <p style="font-size:13px;color:#6b7185">If you didn't ask for this, ignore this email — your password stays unchanged.</p>
    <p style="font-size:13px;color:#6b7185">This link expires in 60 minutes.</p>
  `);
  const text = `${greeting}\n\nReset your password:\n${link}\n\nIf you didn't ask for this, ignore this email.`;
  return send({ to, subject: 'Reset your Hitrapost password', html, text });
}

module.exports = {
  isConfigured,
  send,
  sendVerificationEmail,
  sendPasswordResetEmail,
};
