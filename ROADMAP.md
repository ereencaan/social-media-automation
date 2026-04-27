# Hitrapost — Master Roadmap & Checklist

> Living document. Every line is a deliverable.
> `[x]` = shipped, `[~]` = in progress, `[ ]` = pending, `[!]` = blocked.

---

## P0 — Hitratech günlük kullanıma hazır

- [x] Auth screen (login + register, session, logout)
- [x] Brand profile UI (business name, industry, description, target audience, tone, language)
- [x] Brand logo upload (Cloudinary or local)
- [x] Brand: country picker (ISO alpha-2, 15 markets)
- [x] Brand: founding date → auto-create company anniversary in `brand_special_dates`
- [x] Brand: `/api/brand/holidays` endpoint pulling country public holidays
- [x] Brand: read-only **Public holidays** card on Brand page
- [x] Brand: contact strip toggle (`overlay_contact_enabled`)
- [x] Posts: multi-platform chip selector (IG / LinkedIn / FB)
- [x] Posts: drop user-facing variants & quality knobs (server forces best)
- [x] Posts: inline "How this works" explainer + scripted progress timeline
- [x] Posts: **detached generate** — survives navigation (floating job pill)
- [x] Captions: server-side **contact block** stamp (website / phone / WhatsApp / IG)
- [x] Captions: language enforcement (brand.content_language always wins)
- [x] Captions: banned generic phrases / hashtags / image prompts
- [x] Image overlay: contact strip with icons + width fix
- [x] Quality: 3-round refine loop until score ≥ 75
- [x] Calendar: empty-state shows next ~60 days of holidays + brand dates
- [x] Logo redesign + welcome panel `logo-full-v2.png`
- [x] Meta webhook signature verify (HMAC SHA-256, raw body capture fix)
- [x] Webhook intake: per-org `intake_token`, public POST `/api/intake/:token`
- [x] Settings → Intake URL reveal + curl example + rotate
- [x] Leads empty state: 3-channel grid (IG/FB connect, webhook URL, manual)
- [x] Leads kanban (new / contacted / qualified / won / lost) with source chips
- [x] Dashboard: "New this week" stat
- [x] Pre-commit hook: advisory mode (false-positive proof)
- [x] Oracle VM deploy + nginx + Let's Encrypt + Cloudflare DNS

### P0 smoke test (in flight)
- [~] End-to-end: Brand → Generate → Schedule → Publish to IG/FB/LinkedIn
- [ ] Lead CRM: manual lead → AI email draft → save activity
- [ ] Calendar: build month plan → 48h auto-gen → review
- [ ] Webhook intake: curl test → lead lands with `webhook` chip
- [ ] Schedule + publish smoke: scheduled post fires on time

### P0.5 — Don't lose data
- [x] Nightly backup: `posts.db` → Cloudflare R2 / B2 (cron, 30-day retention)
- [x] Restore-from-backup runbook documented

---

## P1 — Monetization (Stripe billing)

### Stripe account & products
- [ ] Stripe account: business setup, UK Ltd., bank, Tax (UK VAT)
- [ ] Product catalog:
  - [ ] **Starter** £29/mo (£290/yr) — 30 posts, 500 leads, 3 socials, 100 AI calls
  - [ ] **Pro** £79/mo (£790/yr) — 120 posts, 5000 leads, 10 socials, 500 AI calls
  - [ ] **Agency** £199/mo (£1990/yr) — unlimited posts, 50K leads, 50 socials, 5 seats, white-label
  - [ ] **Enterprise** custom — SLA, SSO, dedicated
- [ ] Stripe Tax enabled
- [ ] Stripe Customer Portal config (cancel, update card, invoices)

### Backend
- [x] DB migration: `orgs.plan`, `plan_status`, `trial_ends_at`, `stripe_customer_id`, `stripe_subscription_id`
- [x] DB migration: `usage_counters` (org_id, period_month, posts_created, ai_calls_count, leads_count)
- [x] Middleware: `requirePlan('pro')`
- [x] Middleware: `enforceQuota('posts' | 'ai_calls' | 'leads')`
- [x] Cron: monthly `usage_counters` reset on 1st of each month
- [x] `POST /api/billing/checkout` — Stripe Checkout session for plan
- [x] `POST /api/billing/portal` — Stripe Customer Portal session
- [x] `POST /webhooks/stripe` — signature verify + event dispatch
  - [x] `customer.subscription.created/updated/deleted` → DB sync
  - [x] `invoice.paid` → reset quotas, mark active
  - [x] `invoice.payment_failed` → mark `past_due`, notify
  - [~] `customer.subscription.trial_will_end` → email reminder (handler in place; email send TBD)

### Frontend
- [x] `/pricing` page (4 plan cards, monthly/annual toggle)
- [x] Settings → **Billing** tab (current plan, usage bars, invoices, cancel)
- [x] Limit-aspect modal — "You've used 28/30 posts this month"
- [x] Upgrade CTAs on quota exceed (402 Payment Required → modal)
- [x] Usage indicator on Dashboard (posts / AI calls / leads remaining)

### Anti-abuse (signup hardening)
- [x] SMTP provider integration (Resend recommended — 3000/mo free)
- [x] Email verification: signup → token email → verify-only AI gate
- [x] Disposable email blocklist (mailcheck.io regex + curated list)
- [x] IP rate: max 3 accounts per IP per 24h
- [x] 14-day trial: Stripe SetupIntent for card auth (no charge)
- [x] Trial countdown banner (last 3 days)

---

## P2 — Auth hardening (UI + flows)

- [x] Session fixation regenerate on login
- [x] Rate limit: login (10/15min), register (6/hr), 2FA verify (8/10min)
- [x] TOTP 2FA backend (enroll, activate, disable, login challenge)
- [x] Backup-code consumption with optimistic concurrency
- [x] **2FA enrollment UI** — QR code modal in Settings → Security
- [x] **2FA login challenge UI** — code prompt after password
- [x] **Backup codes screen** — show 10 codes once, "I saved them" confirm
- [x] Password reset flow: request → token email → reset form
- [x] Email change flow: confirm via current + new email
- [x] Account deletion (with confirmation + 30-day grace soft-delete)

---

## P3 — Lead automation

### Built (backend)
- [x] Generic webhook intake endpoint
- [x] Meta webhook (IG DM + FB Messages) with HMAC signature verify
- [x] Lead dedupe by `(source, source_ref)`
- [x] Activity log per inbound message
- [x] Source chips: instagram / facebook / linkedin / webhook / manual
- [x] Lead drawer with AI email draft

### Live chat — Tawk.to (primary, free + webhooks on free tier)
- [x] `POST /api/intake/tawk/:token` handler with HMAC-SHA1 signature verify (`TAWK_WEBHOOK_SECRET`)
- [x] Tawk payload mapping (chat:start / chat:transcript / ticket:create → lead, chat:end ignored)
- [x] `tawk` source chip (uses canonical `tawk` id, see SOURCE_META)
- [x] Anonymous-visitor filter (skip Tawk auto-names like "Visitor 1234567890")
- [x] Hitratech.co.uk: Tidio swapped for Tawk (dogfood)
- [ ] Settings → "Connect Tawk in 5 minutes" guide card with intake URL
- [ ] Per-org webhook secret (replace single env var when multi-tenant lands)

### Live chat — Tidio
> **Free tier blocks "Send Webhook" action (Plus required).** For free Tidio
> users we route via email-to-lead instead. Direct webhook handler skipped
> until/unless a Plus customer asks for it.
- [~] (Plus only) Generic `/api/intake/:token` mapping; user wires "Send Webhook" in Tidio Flows (docs in docs/integrations/live-chat.md)
- [x] `tidio_livechat` source chip + icon
- [x] "Connect Tidio in 5 minutes" guide (docs/integrations/live-chat.md)

### WordPress connector (own brand + sellable to customers)
- [x] Custom WP plugin: `Hitrapost Connector`
  - [x] Settings page (paste intake URL)
  - [x] Hooks Contact Form 7 submissions → POST
  - [x] Hooks WPForms / Elementor Forms / Gravity Forms / Ninja Forms
  - [ ] Optional: page-view tracking (later)
- [~] Distribute as ZIP / WP plugin directory submission (zip script in integrations/wordpress-plugin/README.md; user submits to wp.org)

### Other live-chat platforms (sellable feature parity)
- [x] Tawk.to webhook integration guide
- [x] Crisp integration
- [x] Smartsupp integration
- [x] LiveChat / JivoChat integrations

### Source chip expansion
- [x] `tidio_livechat` chip
- [x] `wordpress_form` chip
- [x] `tawk` / `crisp` chips
- [x] `email` chip (forwarding-based, see P3.email)

### Email-to-lead (universal channel — solves Tidio free, Crisp free, all form-notification emails, direct customer mails)
- [x] `email` source chip + amber color (frontend placeholder; handler not wired yet)
- [ ] Inbound provider: SendGrid Inbound Parse (free tier) — DNS: `MX leads.hitrapost.co.uk → mx.sendgrid.net`
- [ ] `POST /api/intake/email` endpoint receives multipart from SendGrid, extracts `to` token
- [ ] `email-parser.service.js` — name/phone/message heuristics + From-header source detection
  - `notifications@tidio.com` → `tidio_livechat`
  - `noreply@tawk.to` → `tawk_livechat`
  - `wordpress@*` / form plugin patterns → `wordpress_form`
  - generic → `email`
- [ ] Per-org forwarding address: `{intake_token}@leads.hitrapost.co.uk`
- [ ] Settings → "Email-to-Lead Address" reveal card + Tidio/Gmail forward setup guide

### Meta App Review (UNBLOCKS real IG/FB DM ingest)
- [!] App icon 1024×1024
- [!] Privacy Policy URL (host on hitrapost.co.uk/privacy)
- [!] Terms of Service URL (host on hitrapost.co.uk/terms)
- [!] App walkthrough video (screencast)
- [!] Business Verification (Companies House cert, UK Ltd.)
- [!] Submit `instagram_manage_messages` permission
- [!] Submit `pages_messaging` permission
- [!] App Mode → Live (after approval)

---

## P4 — Platform expansion

### Refactor (do this BEFORE adding new platforms)
- [ ] `src/services/platforms/_base.js` — `SocialPlatform` interface
- [ ] Migrate `instagram.service.js` → `platforms/instagram.platform.js`
- [ ] Migrate `facebook.service.js` → `platforms/facebook.platform.js`
- [ ] Migrate `linkedin.service.js` → `platforms/linkedin.platform.js`
- [ ] Plugin registry — UI auto-renders connect tiles from registry

### Tier 1 (highest UK demand)
- [ ] **TikTok** plugin (Content Posting API, OAuth, video upload, caption)
- [ ] **YouTube Shorts** plugin (Google OAuth, video upload, Shorts metadata)
- [ ] **WhatsApp Business Cloud** plugin (DM ingest webhook, template messages)
- [ ] **Google Business Profile** plugin (post, review reply, Q&A)

### Tier 2
- [ ] **Pinterest** plugin (Pin upload, Boards)
- [ ] **Threads** plugin (Meta OAuth, Threads Posts API)
- [ ] **X (Twitter)** plugin (OAuth 2.0, $100/mo API tier)
- [ ] **Telegram Channels** plugin (Bot API)

### Tier 3 (later / niche)
- [ ] Reddit
- [ ] Snapchat
- [ ] Bluesky

---

## P5 — Video pipeline (real reels)

- [ ] `video-composer.service.js` — storyboard + multi-clip + ffmpeg concat
- [ ] Claude storyboard prompt (N scenes from brief)
- [ ] Parallel Runway clip generation
- [ ] ffmpeg crossfade concat (0.5s transitions)
- [ ] Cloudinary upload of final video
- [ ] Posts UI: target duration select (Reel 15s / TikTok 30s / Shorts 60s)
- [ ] Progress UI: "Scene 2/3 generating…"
- [ ] Plan-tier gating (Starter: 0 video, Pro: 5/mo, Agency: 50/mo)
- [ ] Alternative provider plugins (Pika, Luma, Veo, Sora)

---

## P6 — UX polish

- [x] Logo iteration paused (V2 logo live)
- [x] Quality report panel (5 axes, per-model breakdown)
- [x] Floating background-job pill
- [ ] Dashboard: 7-day post chart + scheduled count
- [ ] Dashboard: per-platform breakdown (IG vs LI vs FB engagement)
- [ ] Leads kanban: drag-and-drop status change
- [ ] Posts: bulk approve / bulk schedule
- [ ] Calendar: month / week / day views
- [ ] Calendar: drag-to-reschedule plan items
- [ ] Mobile-responsive sweep (sidebar collapse, touch-friendly kanban)
- [ ] Dark/light theme toggle
- [ ] Toast stacking + dismiss-all
- [ ] Inline tooltips on every "?"

---

## P7 — Mobile app

- [ ] React Native scaffold (or Expo)
- [ ] Login / 2FA
- [ ] Lead inbox (push on new lead)
- [ ] Lead drawer + AI email draft mobile UX
- [ ] Post review + approve/schedule
- [ ] Push notifications (new lead / post review ready / publish complete)
- [ ] Web-only billing redirect (open `/pricing` in browser, no in-app IAP)
- [ ] Apple Dev Account ($99/yr)
- [ ] Google Play Console ($25 one-time)
- [ ] App Store + Play Store submission + review

---

## P8 — Owner ops & scale

### Owner-only analytics (private dashboard)
- [ ] MRR / ARR
- [ ] Churn rate (monthly)
- [ ] Trial → paid conversion rate
- [ ] AI cost per org (Claude / GPT-4 / Gemini token spend)
- [ ] Flux / Runway / Templated cost per org
- [ ] Top users by activity
- [ ] Active subscriptions by plan

### Operational
- [ ] Audit log (who did what, immutable)
- [ ] Sentry error tracking
- [ ] UptimeRobot HTTPS monitor
- [ ] Plausible / Umami web analytics
- [ ] Status page (status.hitrapost.co.uk)
- [ ] Postgres migration when sql.js capacity hits ~10K users

### Compliance & legal
- [ ] Privacy Policy (GDPR + UK GDPR compliant)
- [ ] Terms of Service
- [ ] Cookie banner (if needed)
- [ ] Data Processing Agreement template (B2B customers)
- [ ] DPIA template
- [ ] ICO registration (£40/yr UK)

---

## P9 — Enterprise tier

- [ ] Custom domain (`crm.musteri.com` → CNAME, ACME cert)
- [ ] White-label: brand logo + colors + email-from
- [ ] Multi-user / team seats (Agency+)
- [ ] RBAC (owner / admin / member / viewer)
- [ ] SSO: SAML 2.0
- [ ] SSO: OIDC (Google Workspace, Azure AD)
- [ ] SCIM provisioning
- [ ] Custom contracts / SLA
- [ ] Dedicated VM tier

---

## P10 — Long-term roadmap

### Future website rewrite
- [ ] Migrate `hitratech.co.uk` off WordPress to custom Next.js (later)
- [ ] Marketing site rewrite (hitrapost.co.uk landing)
- [ ] Blog with SEO content

### AI capabilities
- [ ] Smart reply: auto-draft replies to inbound DMs / comments
- [ ] Lead scoring (Claude scores incoming leads on intent)
- [ ] Competitor scrape + content ideation
- [ ] A/B testing posts (publish 2 variants, pick winner)
- [ ] Auto-responder for FAQs

### Reports & exports
- [ ] Monthly performance PDF (sent on 1st of month)
- [ ] CSV export of leads
- [ ] Post analytics (reach, engagement) pulled back from platforms

### Integrations
- [ ] Slack notifications (new lead, publish complete, errors)
- [ ] HubSpot / Pipedrive sync
- [ ] Google Sheets export
- [ ] Calendly / Cal.com (book a demo)

---

## Recommended weekly cadence

| Week | Theme |
|------|-------|
| 1 | P0.5 backup + Tidio webhook + WP plugin v0 |
| 2 | P1 Stripe (account, schema, middleware, webhook receiver) |
| 3 | P1 Stripe (UI: pricing, billing, upgrade modals) + P2 auth UI |
| 4 | P3 Meta App Review prep + submission · P5 video pipeline starts |
| 5 | P4 platform refactor + TikTok plugin |
| 6 | P4 YouTube + WhatsApp |
| 7 | P4 Google Business Profile + Pinterest + Threads |
| 8 | P6 UX polish + P5 video pipeline complete |
| 9-11 | P7 Mobile app |
| ongoing | P8 ops + P9 enterprise (parallel) |

---

## Definitions

- **Plan tier** = subscription level (Starter / Pro / Agency / Enterprise)
- **Quota** = monthly hard cap, resets 1st of month
- **Org** = workspace/tenant (one per signup)
- **Connection** = one OAuth-bound social account
- **Plan item** = one entry in a monthly content plan (becomes a draft → post)
