# TikTok Production audit — submission checklist for Hitrapost

Our TikTok app is in Sandbox mode, which means:

- Only TikTok accounts on our "Sandbox Users" list can authorize the app.
- We can only use `video.upload` (Inbox mode) — the video lands as a
  draft in the creator's TikTok inbox and they must manually publish
  from the TikTok app.
- `video.publish` (Direct Post — auto-publish with caption and privacy
  level) is **blocked in Sandbox**. To get it we need to pass the
  **Production audit**.

Timeline: 1–2 weeks for a clean submission, longer if TikTok asks for
re-recording of the demo video. Until audit passes, customers still
have a working flow (Inbox mode) — they just need one extra tap inside
the TikTok app.

---

## What we're requesting

Switch the app from Sandbox → Production AND add the `video.publish`
scope to the existing Login Kit + Content Posting API products.

`video.publish` is currently blocked. With it we can call the
**Direct Post** endpoint
(`/v2/post/publish/video/init/` with `source_info.source = "PULL_FROM_URL"`
and a `post_info` block carrying caption + privacy_level + disable_*
flags) instead of the Inbox endpoint.

---

## Pre-flight

1. ✅ **App icon 1024×1024** — `public/logo-icon-1024.png`
2. ✅ **Privacy Policy URL** — `https://hitrapost.co.uk/privacy`
3. ✅ **Terms of Service URL** — `https://hitrapost.co.uk/terms`
4. ✅ **URL property verified** — `hitrapost.co.uk` already verified
   (via TXT record `tiktok-developers-site-verification=khdC3p0QFwo2JEgUUEFghRRIWauZbZY6`).
5. ⏳ **Demo video** — see script below.
6. ⏳ **Business Verification** — TikTok's audit form has an
   "Organization" tab. Upload Companies House cert for Hitratech
   Solutions Ltd. Same PDF as Meta App Review.

---

## TikTok Developer Portal → My Apps → [Hitrapost] → Configuration

| Field                        | Value                                                   |
|------------------------------|---------------------------------------------------------|
| App display name             | Hitrapost                                               |
| App description              | (paste below)                                           |
| App icon                     | `public/logo-icon-1024.png`                             |
| Category                     | Productivity                                            |
| Privacy Policy URL           | https://hitrapost.co.uk/privacy                         |
| Terms of Service URL         | https://hitrapost.co.uk/terms                           |
| Redirect URI                 | https://hitrapost.co.uk/api/connect/tiktok/callback     |

**App description** (paste verbatim):

> Hitrapost is a B2B SaaS for UK small businesses that helps them
> generate, schedule, and publish short-form video content to TikTok
> alongside other social platforms (Instagram Reels, YouTube Shorts,
> LinkedIn, Facebook). Customers connect their TikTok account via
> Login Kit, draft video posts in our app (text-to-video via Runway
> + scripted scenes), and the system publishes to TikTok via the
> Content Posting API. The connection is per-business — customers
> publish only to their own connected account, not to third parties.

---

## TikTok Developer Portal → Products

Ensure both are added and `video.publish` is checked under Content
Posting API:

- **Login Kit**
  - Scopes: `user.info.basic`, `user.info.profile`
- **Content Posting API**
  - Scopes: `video.upload` (already approved in Sandbox)
  - Scopes: `video.publish` (requesting in this audit)

---

## Audit submission form

TikTok's audit page asks ~12 questions. Answers:

### "Describe your app's primary use case"

> Hitrapost is a multi-platform social media publishing SaaS. Users
> connect their TikTok account from our Settings → Connections page,
> draft a short video in our app (or upload an existing one), and
> publish to TikTok via the Direct Post endpoint. The video carries
> a caption + hashtags the customer composed inside Hitrapost. This
> replaces the manual "download from our app, switch to TikTok app,
> re-upload, retype caption" workflow we currently force them through
> with the Inbox-only `video.upload` scope.

### "How is video content created in your app?"

> Two ways:
>
> 1. **AI-generated**: customer enters a topic brief, we render a
>    15–60s vertical video via Runway gen4.5 (text-to-video, 5–10s
>    clips concatenated via ffmpeg crossfade). The customer reviews
>    and approves the result before any publish action.
>
> 2. **Upload**: customer uploads their own .mp4 (≤ 287 MB to match
>    TikTok's Inbox limit; ≤ 4 GB once Direct Post is enabled).
>
> In both cases the customer explicitly clicks "Publish to TikTok" or
> "Schedule for [date]" — no autopost or background publishing without
> a deliberate user action.

### "How will users initiate the publish action?"

> A single "Publish to TikTok" button on the post-preview card in our
> Posts UI. The button shows the caption + selected privacy level
> ("Public" / "Friends" / "Private") in a confirm modal before the
> Direct Post call fires. Scheduled posts the customer set up earlier
> publish at the scheduled time via our cron — same explicit consent,
> recorded at scheduling time.

### "What metadata accompanies each upload?"

> - `title` (TikTok ignores; we send the post's caption truncated to
>   150 chars for compatibility)
> - `description` (the post's full caption + hashtags)
> - `privacy_level` (default: PUBLIC_TO_EVERYONE; user-selectable
>   per post)
> - `disable_duet`, `disable_comment`, `disable_stitch` (all default
>   false; user-toggleable per post)
> - `video_cover_timestamp_ms` (we autopick the 1-second mark)
>
> All values come from the customer's explicit input — we do not
> inject any TikTok-side metadata they haven't seen.

### "How do you handle content moderation?"

> We rely on TikTok's own moderation pipeline for the published video.
> On our side, every generated caption + hashtag passes through our
> internal "banned phrases" filter (`src/services/claude.service.js`
> BANNED set) which blocks generic spam patterns and known scam
> phrases before they can reach TikTok. Image / video generation
> prompts are run through our prompt-analyzer service that rejects
> requests containing public-figure names, brand names we don't own,
> or copyright-risky themes.

### "Where is user data stored, and for how long?"

> User data (TikTok access tokens, refresh tokens, channel handle,
> upload publish_ids) is stored in our customer's workspace in our
> Oracle Cloud-hosted SQLite database (UK region — London). Tokens
> are retained while the user maintains an active connection; on
> disconnect from Settings → Connections, the row is deleted
> immediately. Upload publish_ids and our status-polling history are
> retained for analytics for 90 days then purged via cron.

### "Do you have a sandbox tester we can use?"

> Yes. Account credentials below for the audit user. The account
> has TikTok connected to a dedicated sandbox TikTok handle we
> control (`@hitrapost_audit`).
>
> - Login: https://hitrapost.co.uk
> - Email: `tiktok-audit@hitrapost.co.uk`
> - Password: [GENERATE LONG RANDOM, paste here]
> - Linked TikTok handle: `@hitrapost_audit`

---

## Demo video script (~3 min)

Record screen + audio. Show the full publish flow with `video.publish`
turned on (since we don't have it yet, you'll need to mock it in the
recording — show the Inbox flow and explain the difference). Reviewers
allow this when the scope they're auditing is the new one.

**Scene 1 — Context (0:00 – 0:20)**

> "Hitrapost helps UK small businesses unify their social media
> posting. We currently publish to TikTok via the Inbox endpoint —
> the customer has to manually publish from the TikTok app afterwards.
> We're requesting `video.publish` so the customer can publish
> directly from our app and finish the job in one click."

**Scene 2 — Generate a video (0:20 – 1:00)**

- Navigate to Posts → "New post" → topic "30-second product intro for
  our coffee subscription".
- Tick TikTok as a target platform.
- Pick duration 30s. Show the multi-clip render pipeline complete.

**Scene 3 — Compose the caption + settings (1:00 – 1:40)**

- Open the post preview card.
- Show the caption editor, hashtag chips, the privacy-level dropdown
  (Public / Friends / Private), the disable-duet / disable-comment
  toggles.

**Scene 4 — Publish (1:40 – 2:30)**

- Click "Publish to TikTok" on the post card.
- Show the confirm modal with all the metadata visible.
- Confirm → show the success toast → switch to the connected TikTok
  account to show the video live (or in inbox if recording before
  audit passes, mention "this would be live once video.publish lands").

**Scene 5 — Disconnect (2:30 – 3:00)**

- Settings → Connections → Disconnect TikTok.
- Show the credential row removed.
- Show https://www.tiktok.com/passport/web/account/security as the
  TikTok-side revocation path.

End card: `hitrapost.co.uk` URL + support email.

---

## What flips on once approved

- Customers see "Publish to TikTok" instead of "Push to TikTok inbox".
- Direct Post lands live (or scheduled, per the customer's privacy
  choice) without the manual TikTok-app step.
- The "(Phase 2 audit)" `[ ]` item on ROADMAP P4 → TikTok unblocks.
- 287 MB → 4 GB upload limit (Direct Post supports larger files).

Inbox mode still works post-audit — if a customer prefers to review
the video in the TikTok app before publishing, they can flip a
per-post setting we'll add post-audit. Direct Post is opt-in by
default to match our "no surprise publishes" stance.
