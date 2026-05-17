# Outbound mail — replying from `support@hitrapost.co.uk`

We use Cloudflare Email Routing on `hitrapost.co.uk` to **receive** mail on
seven aliases (`privacy@`, `billing@`, `support@`, `info@`, `legal@`,
`security@`, `hello@`). Everything forwards to a single inbox so we never
miss a customer ticket.

But Cloudflare doesn't let you **send** from those aliases — it's
forwarding-only. To reply *from* `support@hitrapost.co.uk` (rather than
from your personal Gmail), we route outbound through Resend's SMTP relay
and let Gmail handle the UX with its "Send mail as" feature.

This doc covers the one-time setup. Estimated time: **10 minutes**.

---

## What you'll have when it's done

- Customer emails `support@hitrapost.co.uk` (or any of the 7 aliases).
- Mail forwards via Cloudflare to your Gmail inbox.
- You hit **Reply** in Gmail. The From line shows `support@hitrapost.co.uk`.
- Your reply goes out through `smtp.resend.com`, signed by our domain's
  SPF + DKIM (already configured for transactional mail).
- The customer sees the reply as coming from `support@hitrapost.co.uk` —
  not from your personal Gmail.

---

## Prerequisites

- ✅ Resend account, domain `hitrapost.co.uk` verified (already done — we
  use the same setup for transactional mail).
- ✅ `RESEND_API_KEY` set in production `.env` (already done).
- ✅ Cloudflare Email Routing aliases forwarding to your Gmail (already done).
- A Gmail account where you read the forwarded mail.

---

## Step 1 — Find your Resend SMTP credentials

1. Open [resend.com/settings/smtp](https://resend.com/settings/smtp).
2. Note the values:

   | Field         | Value                  |
   |---------------|------------------------|
   | SMTP server   | `smtp.resend.com`      |
   | Port          | `587` (TLS / STARTTLS) |
   | Username      | `resend`               |
   | Password      | your `RESEND_API_KEY` (starts with `re_...`) |

   Resend's SMTP gateway uses the API key as the password — no separate
   SMTP-only secret. If you ever rotate the API key, you'll need to update
   Gmail's stored password too.

---

## Step 2 — Add the alias in Gmail

Do this **once per alias** you want to reply from. Realistically you only
need `support@hitrapost.co.uk` first; add `billing@` later if it sees real
volume.

1. Open Gmail → **⚙ Settings → See all settings → Accounts and Import**.
2. In the **"Send mail as"** row, click **Add another email address**.
3. Fill in:
   - **Name**: `Hitrapost Support` (or whatever you want recipients to see)
   - **Email address**: `support@hitrapost.co.uk`
   - **Treat as an alias**: ✅ checked
4. Click **Next Step**.

---

## Step 3 — Wire it through Resend SMTP

On the next screen Gmail asks for SMTP details. Enter:

| Field                  | Value                              |
|------------------------|------------------------------------|
| SMTP Server            | `smtp.resend.com`                  |
| Port                   | `587`                              |
| Username               | `resend`                           |
| Password               | your `RESEND_API_KEY` (starts `re_`) |
| Connection security    | **TLS** (Gmail labels this "Secured connection using TLS") |

Click **Add Account**.

---

## Step 4 — Confirm the verification email

Gmail sends a confirmation code to `support@hitrapost.co.uk`. Cloudflare
forwards that mail to your Gmail inbox (because of the existing routing
rule). Open it, copy the confirmation link or code, and paste it back in
the Gmail prompt.

If the verification mail doesn't arrive within 60 seconds, check the
Cloudflare Email Routing dashboard → Activity log. The mail might be
quarantined as it comes *from* Gmail's `mail-noreply@google.com` rather
than an external sender.

---

## Step 5 — Set as default (optional)

If you want every reply you send to default to the alias (so you don't
have to remember to change the From line on every customer ticket):

- Gmail → Settings → Accounts and Import → **Send mail as** section.
- Next to `support@hitrapost.co.uk`, click **make default**.
- Below, set **When replying to a message: Reply from the same address
  the message was sent to**. This way replies to `support@` go out as
  `support@`, but a personal mail still goes out as your Gmail.

---

## Step 6 — Test

1. Pick any mail you've received at `support@hitrapost.co.uk`.
2. Hit Reply. Confirm the From line shows `support@hitrapost.co.uk`.
3. Send.
4. On the recipient end, check:
   - Reply landed in inbox (not spam).
   - View headers: `From: ...@hitrapost.co.uk` (not `gmail.com`).
   - `SPF: pass` and `DKIM: pass` on `hitrapost.co.uk`.

If SPF or DKIM is failing, the domain isn't fully verified at Resend.
Open the Resend Domains page and re-check the DNS records.

---

## Why not Google Workspace?

Workspace is the "clean" option (£6/user/month per alias, real inbox per
alias, calendar, shared docs). The Resend + Gmail "Send mail as" route is
£0/month for any number of aliases and works perfectly for a single-
operator support flow. Revisit Workspace once you hire a real support
person or want shared inboxes / customer-support tooling.

---

## Troubleshooting

- **"Authentication failed"** at Step 3 → username must be the literal
  string `resend`, not your email address. Password is the API key.
- **Verification mail doesn't arrive** at Step 4 → Cloudflare Email
  Routing dashboard → Activity log. Look for the inbound from
  `mail-noreply@google.com`. If it's there but marked failed, the
  forwarding destination might be rejecting it.
- **Replies land in spam** → SPF / DKIM not aligned. Resend Domains page
  in their dashboard shows which records are pending. Cloudflare DNS
  needs the Resend-provided `_resend.hitrapost.co.uk` TXT + the DKIM
  CNAMEs.
- **"You cannot send mail from this address"** → Gmail revoked the alias.
  Re-add it from Step 2. Usually means the API key changed and Gmail's
  stored password is stale.
