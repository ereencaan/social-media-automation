// YouTube publishing via the Data API v3 — resumable video.insert.
//
// Doc: https://developers.google.com/youtube/v3/docs/videos/insert
//      https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
//
// Why resumable upload (not multipart):
//   * Multipart caps at ~5 MB; AI-generated short videos run 5–60 MB.
//   * Resumable lets us PUT the bytes after the metadata POST in a
//     single follow-up request and is the path Google recommends for
//     anything ≥5 MB.
//
// Quota cost: videos.insert = 1600 units. Default project quota is
// 10,000 units/day = ~6 uploads/day across all customers using the
// app's Cloud project. Production volume needs a quota-increase
// request to Google.
//
// Shorts handling: we add `#Shorts` to the description so YouTube
// auto-classifies vertical ≤60s uploads as Shorts. Modern YouTube
// also auto-detects vertical short videos but the hashtag is
// belt-and-braces.

const credsService = require('./social-credentials.service');
const youtubeOAuth = require('./oauth/youtube.oauth');

const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';

/**
 * Resolve a YouTube credential and refresh the access token if it has
 * already expired (or is about to in the next 30 s). Refresh tokens for
 * Google never expire on a fixed clock — only when the user revokes the
 * app, an admin policy expires them, or the token has been unused for
 * 6 months. So a missing refresh_token usually means the credential is
 * truly broken and the user has to reconnect.
 */
async function resolveCredentialFresh(orgId) {
  if (!orgId) throw new Error('orgId required');
  const row = credsService.getActive(orgId, 'youtube');
  if (!row) {
    throw new Error('No YouTube credential — connect YouTube in Settings → Connections');
  }

  const exp = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (exp > Date.now() + 30000) return row;
  if (!row.refresh_token) {
    credsService.markNeedsReauth(row.id, 'access token expired and no refresh_token on file');
    throw new Error('YouTube access token expired and no refresh_token on file — reconnect in Settings');
  }

  let refreshed;
  try {
    refreshed = await youtubeOAuth.refreshToken(row.refresh_token);
  } catch (err) {
    credsService.markNeedsReauth(row.id, err.message);
    throw new Error(`YouTube token refresh failed — reconnect in Settings (${err.message})`);
  }

  const newExpiresAt = refreshed.expires_in
    ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
    : null;
  // Google usually returns no refresh_token on refresh; only set when present
  // (some flows do rotate). Pass explicit null-or-string semantics by
  // omitting when missing.
  const updateInput = {
    access_token: refreshed.access_token,
    expires_at:   newExpiresAt,
    scopes:       refreshed.scope || row.scopes,
  };
  if (refreshed.refresh_token) updateInput.refresh_token = refreshed.refresh_token;
  return credsService.updateAccessToken(row.id, updateInput);
}

/**
 * Build the Shorts-friendly title and description from a post. Title is
 * capped to 100 chars (YouTube's hard limit). #Shorts is always appended
 * to the description so YouTube classifies the upload as a Short even
 * if the auto-detection is conservative.
 */
function buildSnippet(post, overrides = {}) {
  // Strip newlines from the title — YouTube rejects them. Cap 100 chars
  // and trim trailing whitespace so we don't end with a hanging hyphen
  // or comma.
  const rawTitle = (overrides.title
    || (post.caption && post.caption.split('\n')[0])
    || post.prompt
    || 'Untitled').replace(/[\r\n]+/g, ' ').trim();
  const title = rawTitle.length > 100 ? rawTitle.slice(0, 97).trim() + '…' : rawTitle;

  // Description: full caption + hashtags + #Shorts. YouTube allows up to
  // 5,000 chars; we don't bother truncating — generated captions are
  // never that long.
  const captionPart  = (post.caption || '').trim();
  const hashtagsPart = (post.hashtags || '').trim();
  const desc = [
    overrides.description,
    captionPart,
    hashtagsPart,
    '#Shorts',
  ].filter(Boolean).join('\n\n');

  return {
    title,
    description: desc,
    // 22 = "People & Blogs" — safe default. Operators can override via
    // overrides.categoryId (e.g. 24 Entertainment, 28 Science & Tech).
    categoryId: overrides.categoryId || '22',
    // Tags are searchable on YouTube and useful for discovery. We pull
    // them from hashtags when present (split on whitespace, drop the #).
    tags: (hashtagsPart.match(/#[\w\d_-]+/g) || []).map(t => t.replace(/^#/, '')).slice(0, 30),
    defaultLanguage: overrides.language || 'en',
  };
}

/**
 * Step 1 of the resumable protocol: POST the video metadata to /videos
 * with uploadType=resumable. Returns the upload URL from the Location
 * response header. The upload URL is one-time, scoped to the metadata
 * we just submitted, and expires in ~1 week.
 */
async function initResumable(accessToken, snippet, status, contentLength) {
  const url = `${UPLOAD_URL}?uploadType=resumable&part=snippet,status`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization:               `Bearer ${accessToken}`,
      'Content-Type':              'application/json; charset=UTF-8',
      'X-Upload-Content-Type':     'video/*',
      'X-Upload-Content-Length':   String(contentLength),
    },
    body: JSON.stringify({ snippet, status }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`YouTube videos.insert init failed: ${res.status} ${text}`);
  }
  const uploadUrl = res.headers.get('location');
  if (!uploadUrl) throw new Error('YouTube init returned no Location header');
  return uploadUrl;
}

/** Step 2: PUT the video bytes to the upload URL we got from init. */
async function uploadBytes(uploadUrl, videoBytes) {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type':   'video/mp4',
      'Content-Length': String(videoBytes.length),
    },
    body: videoBytes,
  });
  const data = await res.json().catch(() => ({}));
  // 200/201 = upload complete, body is the video resource. Other 2xx
  // would mean partial upload, which we don't expect since we send
  // everything in one PUT.
  if (!res.ok) {
    throw new Error(`YouTube upload PUT failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Download the public source video into a Buffer. Memory-conservative
 * upper bound: YouTube accepts up to 256 GB but Shorts only need ≤60 s
 * which is realistically <100 MB. We block anything ≥500 MB so a
 * runaway upstream URL doesn't OOM the Node process.
 */
async function fetchVideoBytes(videoUrl) {
  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`Source video fetch failed: ${res.status} ${videoUrl}`);
  const arr = await res.arrayBuffer();
  const buf = Buffer.from(arr);
  if (buf.length > 500 * 1024 * 1024) {
    throw new Error('Source video exceeds 500 MB safety cap for in-memory upload');
  }
  return buf;
}

/**
 * High-level publish:
 *   * Resolve a fresh credential (refresh access token if needed).
 *   * Download the source video.
 *   * POST init with snippet + status, get upload URL.
 *   * PUT the bytes, get the video resource back.
 *   * Return { ok, videoId, watchUrl, status }.
 *
 * Privacy: defaults to 'private' so sandbox uploads don't go public.
 * Operators can pass opts.privacy = 'public' | 'unlisted' to override.
 */
async function postToYouTube(post, videoUrl, opts = {}) {
  if (!post) throw new Error('post required');
  if (!videoUrl) throw new Error('videoUrl required');

  const cred = await resolveCredentialFresh(opts.orgId);

  const snippet = buildSnippet(post, opts.snippet || {});
  const status = {
    privacyStatus: opts.privacy || 'private',
    // COPPA — YouTube requires every upload to declare made-for-kids
    // status. SaaS lead-gen content is universally NOT for kids.
    selfDeclaredMadeForKids: false,
    // Embeddable + publicStatsViewable default to true; we leave them
    // alone unless the operator opts out.
  };

  const bytes = await fetchVideoBytes(videoUrl);
  const uploadUrl = await initResumable(cred.access_token, snippet, status, bytes.length);
  const video = await uploadBytes(uploadUrl, bytes);

  return {
    ok: true,
    videoId:  video.id,
    watchUrl: video.id ? `https://youtube.com/shorts/${video.id}` : null,
    status:   status.privacyStatus,
    snippet,
  };
}

module.exports = {
  postToYouTube,
  buildSnippet, // exported for tests
};
