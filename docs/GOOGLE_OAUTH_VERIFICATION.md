# Google OAuth verification — submission checklist for Hitrapost

YouTube Data API v3's `youtube.upload` scope is **sensitive**. While our
Google Cloud project is in "Testing mode" we're capped at 100 user
authorizations and Google shows an "unverified app" interstitial every
time a customer connects. To remove both caps we need to pass OAuth
brand verification + (because `youtube.upload` is sensitive) the
sensitive-scopes review.

Timeline: brand verification ~1 day, sensitive scopes review **2–6 weeks**.
We can publish to "In production" mode in parallel with the sensitive
review — the unverified warning stays during the review but new users
can still grant consent.

Open this doc side-by-side with the Google Cloud Console OAuth Consent
Screen flow.

---

## What we're requesting

| Scope                                      | Sensitivity | Why                                          |
|--------------------------------------------|-------------|----------------------------------------------|
| `openid`, `email`, `profile`               | Basic       | Identify the user post-OAuth                 |
| `youtube.readonly`                         | Sensitive   | Read channel id + handle to label connection |
| `youtube.upload`                           | Sensitive   | Upload Shorts on the user's behalf           |

All four are already wired in `src/services/oauth/youtube.oauth.js`.

---

## Pre-flight

1. ✅ **Privacy Policy URL** — `https://hitrapost.co.uk/privacy` (live)
2. ✅ **Terms of Service URL** — `https://hitrapost.co.uk/terms` (live)
3. ✅ **Application home page** — `https://hitrapost.co.uk`
4. ✅ **Authorized domain** — `hitrapost.co.uk` (add at OAuth Consent → Authorized domains)
5. ✅ **App icon 120×120** — Google asks for 120×120 PNG. Use
   `public/logo-icon-180.png` (oversized works, Google scales it down).
6. ⏳ **Demo video** — see script below, upload to YouTube as Unlisted
   and paste the URL into the review form.
7. ⏳ **Domain verification in Search Console** — verify ownership of
   `hitrapost.co.uk` via DNS TXT record. Open
   `https://search.google.com/search-console`, add property, copy the
   TXT, paste into Cloudflare DNS for `hitrapost.co.uk`. Takes <5 min.

---

## OAuth Consent Screen → App Information

| Field                | Value                                                          |
|----------------------|----------------------------------------------------------------|
| App name             | Hitrapost                                                      |
| User support email   | support@hitrapost.co.uk                                        |
| App logo             | `public/logo-icon-180.png` (Google scales to 120×120)          |
| Application home     | https://hitrapost.co.uk                                        |
| Application privacy  | https://hitrapost.co.uk/privacy                                |
| Application terms    | https://hitrapost.co.uk/terms                                  |
| Authorized domains   | hitrapost.co.uk                                                |
| Developer contact    | ereencaan@gmail.com                                            |

---

## OAuth Consent Screen → Scopes

Click "Add or Remove Scopes" and add:

```
openid
.../auth/userinfo.email
.../auth/userinfo.profile
.../auth/youtube.readonly
.../auth/youtube.upload
```

For each sensitive scope (`youtube.*`), paste the corresponding
justification:

### `youtube.upload` — justification

> Hitrapost is a B2B SaaS that helps UK small businesses run their
> social media presence end-to-end. When a customer creates a video
> post in our app and selects "YouTube Shorts" as a target platform,
> our scheduler uploads the rendered video to the customer's connected
> YouTube channel via `videos.insert` with the `#Shorts` tag in the
> description.
>
> Specifically: we use `https://www.googleapis.com/auth/youtube.upload`
> ONLY to call the resumable upload endpoint
> `/upload/youtube/v3/videos`, with the user's pre-generated title,
> description (including their hashtags), and `categoryId=22`
> (People & Blogs default). We do not modify existing videos, do not
> delete videos, and do not perform any other write operations.
>
> The upload is initiated by the customer's explicit "Publish" or
> "Schedule" action in our app's Posts UI — there are no autopost
> features that publish without explicit consent. The customer can
> disconnect their YouTube channel at any time from Settings →
> Connections, which immediately drops the refresh token and prevents
> any further uploads on their behalf.

### `youtube.readonly` — justification

> We need `youtube.readonly` to call `channels.list?mine=true` once
> during the OAuth callback so we can read the customer's channel id
> and handle. We use these to:
> 1. Stamp the connection in our UI as "Connected to @MyChannel" so
>    the customer can confirm they linked the right account.
> 2. Use the channel id as the stable `account_id` for our internal
>    credentials row, so reconnects upsert correctly instead of
>    creating duplicate connection records.
>
> We do not read videos, playlists, subscribers, or any other channel
> data. The one channels.list call happens at OAuth callback and is
> not repeated.

---

## OAuth Consent Screen → Test Users (while in Testing mode)

While we wait for sensitive-scopes review, add Google account emails
of your friendly beta customers here. Otherwise they get blocked by
the "App is currently being tested" gate.

We've already added:
- `ereencaan@gmail.com` (you — Hitratech dogfood)

Add new customer emails as they sign up for the closed beta. Cap is
100 emails total in Testing mode.

---

## Demo video script (~3 min)

Record at 1080p+, upload Unlisted to YouTube, paste URL into the review
form's "Demo Video" field.

**Scene 1 — Context (0:00 – 0:20)**

> "Hitrapost is a UK B2B SaaS for small businesses. We're requesting
> youtube.upload + youtube.readonly so customers can publish their
> Hitrapost-generated Shorts directly to their connected YouTube
> channel."

**Scene 2 — Connect (0:20 – 1:00)**

Navigate to `https://hitrapost.co.uk` → log in → Settings → Connections.

- Click "Connect YouTube Shorts".
- Show the Google OAuth screen with `youtube.upload` + `youtube.readonly`
  + email + profile listed.
- Walk through the "unverified app" warning if it's still showing —
  this is expected while review is pending.
- Approve. Land back on Connections with YouTube card showing the
  channel handle.

**Scene 3 — Generate and publish (1:00 – 2:30)**

- Click Posts → "New post" → enter a brief like "30-second product
  intro for our coffee subscription".
- Tick "YouTube Shorts" as a target platform.
- Show the video render flow (15s or 30s reel).
- When done, click "Upload to YouTube" on the post card.
- Show the new Short opening in a new browser tab on YouTube with
  `#Shorts` in the description.

**Scene 4 — Revocation (2:30 – 3:00)**

- Settings → Connections → click "Disconnect" on YouTube.
- Confirm the connection is gone and that, per
  `https://myaccount.google.com/permissions`, the customer can also
  revoke from Google's side.

End with `hitrapost.co.uk` URL and our support email.

---

## Sensitive scopes — extra fields in the review form

Google's submission form for sensitive scopes asks specific questions:

**"How will the requested scopes enhance users' experience?"**

> Without youtube.upload, customers cannot publish their
> Hitrapost-generated short videos to YouTube and would have to
> manually download from us and re-upload — defeating the purpose of
> a multi-platform publishing tool. Without youtube.readonly we can't
> confirm which channel a customer connected, leading to confused
> reconnects and upload mistakes.

**"Are you accessing user data for AI training or for use by AI models?"**

> No. We do not use customer YouTube data to train any AI model. The
> only data we receive is the channel id + handle (via
> channels.list?mine=true) for connection identification, plus the
> upload response (video id) so we can link back to the customer's
> published Short in our UI. None of this flows into model training.

**"Do you have a Data Processing Agreement with all sub-processors?"**

> Yes — all sub-processors (Stripe, Cloudinary, Resend, Anthropic,
> OpenAI, Google Gemini, SendGrid, Cloudflare, Oracle Cloud) are
> listed in our public Privacy Policy
> (https://hitrapost.co.uk/privacy#sub-processors) and each has a
> DPA in force.

---

## Privacy Policy specifics Google checks

Google's reviewer reads `/privacy` looking for specific patterns. Our
current copy already covers most of this; verify these phrases are
visible:

- ✅ "We use YouTube Data API v3 to upload videos to your YouTube
  channel on your behalf." (Add this line to the Sub-processors → Google
  section if not there.)
- ✅ "We retain Google user data only as long as you maintain an active
  connection. Disconnecting from Settings → Connections immediately
  invalidates the refresh token."
- ✅ Link to Google's API Services User Data Policy:
  `https://developers.google.com/terms/api-services-user-data-policy`
- ✅ Data deletion flow described (already in `/privacy#deletion`)

---

## After submission

- **Brand verification** comes back in ~1 day. If approved, the
  "unverified app" warning is replaced with our logo on the consent
  screen.
- **Sensitive scopes** review takes 2–6 weeks; Google emails back-and-
  forth questions during the process. Respond within 48h or they
  archive the request.
- Once both pass, the consent screen status flips to "Published" and
  the 100-user cap lifts.

## What unblocks once approved

- Any signed-up customer can connect their YouTube channel without
  being on our test-users list.
- The "unverified app" warning goes away.
- YouTube quota increase request — file a separate "YouTube API
  Services Audit and Quota Extension" form. Default is 10,000 units/day
  = ~6 uploads/day across all customers. We'll need that lifted before
  serving 10+ customers.
