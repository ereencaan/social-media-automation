# Meta App Review — submission checklist for Hitrapost

Without App Review our Meta integration is stuck in "Development mode": only
test users we manually add can authorize the app, and we cannot ingest real
IG DMs or FB Page messages. App Review unlocks every Hitrapost customer to
connect their own IG / FB Page from Settings → Connections.

Review timeline is typically **1–4 weeks** depending on Meta's queue; the
work on our side is a single-day sprint.

This doc walks you through Meta's review flow with copy-paste ready text
for each field. Open it side-by-side with the Meta App Dashboard.

---

## What we're requesting (scopes)

Two permissions on the same app:

| Permission                     | Why we need it                                     |
|--------------------------------|----------------------------------------------------|
| `instagram_manage_messages`    | Read inbound IG DMs to file as leads in the CRM    |
| `pages_messaging`              | Read inbound FB Page messages, same purpose        |
| `pages_manage_metadata`        | Required dependency of `pages_messaging`           |
| `pages_show_list`              | Let the user pick which Page to connect            |
| `pages_read_engagement`        | Read post-level metadata for analytics             |
| `business_management`          | Required dependency for Business-Asset connections |

The app already has these scopes wired in code (`src/services/meta.service.js`).
We're just asking Meta to authorize them for production use.

---

## Pre-flight (do these before opening the review dashboard)

1. ✅ **App icon 1024×1024** — `public/logo-icon-1024.png` is ready.
   Upload at: App Dashboard → Settings → Basic → App Icon.

2. ✅ **Privacy Policy URL** — `https://hitrapost.co.uk/privacy` (live)

3. ✅ **Terms of Service URL** — `https://hitrapost.co.uk/terms` (live)

4. ✅ **Data Deletion Instructions URL** — `https://hitrapost.co.uk/privacy#deletion`
   (Reviewers will hit this; make sure the privacy page has an anchor `#deletion`
   pointing at the "How to delete your data" section. Already true in our
   `public/privacy.html`.)

5. ✅ **Business Verification** — `Hitratech Solutions Ltd`, UK Ltd.
   Upload: Companies House certificate (downloadable as PDF from
   https://find-and-update.company-information.service.gov.uk/).
   Path: App Dashboard → Settings → Business Verification.

6. ⏳ **Walkthrough video** — see script below. Record with OBS / Loom /
   QuickTime; upload as `.mp4` ≤ 250MB. Reviewers watch this end-to-end.

7. ⏳ **Test user credentials** — Meta wants login credentials for a real
   test account so they can verify the flow themselves. Create a dedicated
   `meta-review@hitrapost.co.uk` account, give it the Agency comp plan,
   bypass 2FA (set `tfa_enabled = 0` in DB after enrollment if needed).

---

## App Dashboard → Settings → Basic

| Field                     | Value                                                |
|---------------------------|------------------------------------------------------|
| Display Name              | Hitrapost                                            |
| App Domain                | hitrapost.co.uk                                      |
| Privacy Policy URL        | https://hitrapost.co.uk/privacy                      |
| Terms of Service URL      | https://hitrapost.co.uk/terms                        |
| Data Deletion             | https://hitrapost.co.uk/privacy#deletion             |
| Category                  | Business and Pages                                   |
| Sub-category              | Marketing                                            |
| App Icon                  | upload `public/logo-icon-1024.png`                   |

---

## App Dashboard → App Review → Permissions → Request Advanced Access

For each permission below, paste the corresponding "Use case" text.

### `instagram_manage_messages`

**Use case (paste verbatim):**

> Hitrapost is a B2B SaaS that helps UK small businesses centralize their
> inbound lead capture. When a prospective customer DMs the business's
> Instagram account, the business owner needs that conversation to land
> in their Hitrapost CRM (Leads dashboard) so it doesn't get lost
> alongside posts, comments, and other DMs. Without this permission we
> cannot read inbound DMs and the IG → CRM lead capture flow does not
> work.
>
> Specifically we use this permission to: (1) subscribe to the IG
> messaging webhook on the connected business account, (2) on each
> inbound DM event, fetch the message + sender display name + thread id
> via /me/conversations and /me/messages, (3) create or update a lead
> row in the customer's CRM with source = "instagram_dm", and (4) write
> an activity log entry so the business owner sees the full conversation
> history. We do NOT use this permission to send messages, modify
> conversations, or read any user data beyond the inbound message
> payload itself.

**Demonstration video** — upload the walkthrough (script below).

### `pages_messaging`

**Use case (paste verbatim):**

> Same flow as instagram_manage_messages but for Facebook Page
> Messenger. When a customer messages the business's FB Page (often via
> the "Send Message" button on a paid ad or organic post), we ingest
> that inbound message into Hitrapost's lead CRM with source = "facebook_dm".
> The business owner triages the lead from Hitrapost's Leads kanban
> (new → contacted → qualified → won/lost) rather than juggling Page
> Inbox, Email, and our app separately.
>
> We use this permission ONLY to read inbound messages and create lead
> records. We do not send automated replies, do not iterate over
> historical conversations, and do not read messages from any Page the
> user has not explicitly connected via OAuth (the Page picker UI
> respects `pages_show_list` scoping).

### `pages_manage_metadata`

**Use case:**

> Required as a Meta-listed dependency of `pages_messaging` so we can
> subscribe / unsubscribe the Page from our messaging webhook on connect
> / disconnect. We do not modify Page settings, photos, or any other
> metadata — the only call we make under this scope is the standard
> `POST /{page-id}/subscribed_apps` to register our webhook, and
> `DELETE /{page-id}/subscribed_apps` to clean up when the user
> disconnects the Page from Settings → Connections.

### `pages_show_list`

**Use case:**

> Used during OAuth to populate the Page picker. After the user grants
> permission, Hitrapost calls `GET /me/accounts` to list the Pages they
> manage and renders them as a select-one dropdown in the Connections
> flow ("Pick which Page Hitrapost should monitor"). Without this we
> can't let the user choose — we'd have to either skip Page selection
> (broken for multi-Page admins) or hardcode the first Page (wrong for
> ~30% of our users).

### `pages_read_engagement`

**Use case:**

> Used to read post-level engagement metrics (likes, comments, reach)
> on posts Hitrapost has published to the user's Page. These metrics
> render in the Dashboard's per-platform breakdown card so the business
> owner can compare performance across IG / FB / LinkedIn without
> opening three separate Meta Insights tabs. We do not read engagement
> for posts we did not publish — every analytics read is scoped to the
> post_id we returned from our /publish call.

### `business_management`

**Use case:**

> Required by Meta as a dependency for connecting Pages that sit under
> a Meta Business Suite. About 40% of our Hitrapost customers manage
> their Page through a Business account (typical for marketing agencies
> and any business that has hired an external PR / social team). Without
> this scope, those customers see "Page not available" during OAuth.
> We do not enumerate the user's full Business assets — we only read
> what's needed to confirm the Page they chose is reachable.

---

## Walkthrough video script (~3 min)

Record screen + audio. Show the actual hitrapost.co.uk app, logged in as
your `meta-review@hitrapost.co.uk` test user. Meta wants to see the
permission being USED, not just installed.

**Scene 1 — Context (0:00 – 0:30)**

Talking head over Hitrapost dashboard:

> "Hitrapost is a UK B2B SaaS that helps small businesses unify lead
> capture. We're requesting `instagram_manage_messages` and
> `pages_messaging` so customers can route inbound DMs from their
> business Instagram and Facebook Page into our CRM. Let me show you
> the flow."

**Scene 2 — Connect Instagram (0:30 – 1:00)**

Navigate to Settings → Connections → tap "Connect Instagram".

- Show the Meta OAuth screen with the requested permissions listed.
- Approve. Land back on Connections with IG showing connected + handle.

> "After OAuth, Hitrapost subscribes our webhook to receive inbound DM
> events. No outbound messaging — we don't send messages on the user's
> behalf."

**Scene 3 — Inbound DM lands as a lead (1:00 – 1:45)**

Switch to your phone (or have a colleague) DM the connected IG account
something like "Hi, interested in pricing — Jane Doe, 07700 900 123".

Switch to Hitrapost Leads kanban. Refresh.

> "The DM appears as a new lead in the 'new' column. Source is tagged
> 'instagram_dm'. The full message body is in the activity log."

Click into the lead, scroll through the activity timeline. Show the
"Draft email" button as an example of how the user works the lead from
inside Hitrapost (no automated outbound).

**Scene 4 — Facebook Page same flow (1:45 – 2:30)**

Repeat scene 2-3 with a Page Message instead of an IG DM. Show the
lead lands with source `facebook_dm`.

**Scene 5 — Data deletion (2:30 – 3:00)**

Navigate to Settings → Account → Delete Account. Show the confirm dialog
mentioning "30-day grace period, after which all data including connected
social tokens is purged".

Then visit `https://hitrapost.co.uk/privacy#deletion` to show the public
data-deletion instructions match.

> "All inbound message data is owned by the customer and deleted when
> they delete their account or disconnect the social connection."

End card with logo + "hitrapost.co.uk" URL.

---

## Test user instructions (paste in App Review → "How to test")

> 1. Open https://hitrapost.co.uk
> 2. Click "Sign in" and use these credentials:
>    - Email: meta-review@hitrapost.co.uk
>    - Password: [GENERATE A LONG RANDOM ONE, paste it here]
> 3. The account has been pre-provisioned with the Agency plan so all
>    features are unlocked.
> 4. Navigate to Settings → Connections (left sidebar).
> 5. Click "Connect Instagram" — complete the Meta OAuth.
> 6. Send a DM to the connected IG account from a separate handle.
> 7. Back in Hitrapost, refresh Leads. The DM appears as a new lead
>    tagged "instagram_dm".
> 8. Repeat steps 5–7 for "Connect Facebook" with a Page message.
> 9. To verify data deletion, go to Settings → Account → Delete Account
>    and follow the confirm dialog; or visit
>    https://hitrapost.co.uk/privacy#deletion for written instructions.

---

## After submission

Meta's reviewer usually replies within 5 business days for first-pass
feedback. Common rejection reasons:

- **"Permission not demonstrated in video"** — make sure every requested
  scope is actually exercised on screen. We cover IG + FB messaging in
  the script above; if Meta complains about `pages_read_engagement`, add
  a 30s scene showing the Dashboard's per-platform breakdown card.
- **"Cannot test the flow"** — usually the test user is missing the comp
  plan or has 2FA on. Reset password + disable 2FA on
  `meta-review@hitrapost.co.uk` if Meta asks.
- **"Privacy Policy unclear about Meta data"** — our `/privacy` page
  already lists Meta in the sub-processor table, but add the line "We
  receive Instagram and Facebook message content via Meta's Graph API
  Webhooks when you connect your account; this data is stored in your
  Hitrapost workspace and deleted on disconnect / account deletion."

---

## What flips on once approved

- IG / FB Connect tiles in Settings → Connections work for any signed-up
  customer (currently they 403 unless the email is on our Meta test users
  list).
- App Mode → flip from "Development" to "Live" in App Dashboard → Settings.
- IG / FB source chips in Leads start showing real inbound traffic from
  customer accounts.
- The `[!]` items on ROADMAP P3 → Meta App Review block all unblock.

Don't flip App Mode → Live until you've passed review. Doing it before
approval just means existing test-user logins keep working at Development
scope; it doesn't help and Meta sometimes uses the flip-time as a signal
during their queue triage.
