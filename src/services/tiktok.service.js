// TikTok publishing via the Content Posting API in **Inbox** mode.
//
// Doc: https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
//      https://developers.tiktok.com/doc/content-posting-api-upload-video
//
// Why Inbox mode (not Direct Post):
//   * Direct Post (the video goes live immediately) needs the
//     `video.publish` scope, which TikTok only grants after the app
//     passes their Production audit. Sandbox apps cannot request it.
//   * Inbox mode (the video lands in the creator's TikTok inbox as a
//     draft for them to review and publish from the TikTok app) only
//     needs `video.upload` — already in our SCOPES set, works in
//     sandbox. Less polished UX but unblocks end-to-end testing today.
// Switching to Direct Post post-audit is a 2-line change: swap the init
// endpoint and add a `post_info` block with caption + privacy_level.
//
// Why FILE_UPLOAD (not PULL_FROM_URL):
//   * PULL_FROM_URL needs every video host (Cloudinary, our CDN, etc.)
//     listed under TikTok's "URL properties" verification. We'd have
//     to verify domains we don't own.
//   * FILE_UPLOAD has us PUT the bytes directly to a one-time signed
//     URL TikTok hands us. Works regardless of where the video is
//     hosted upstream.

const credsService = require('./social-credentials.service');

const INIT_URL    = 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/';
const STATUS_URL  = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';

function resolveCredential(orgId) {
  if (!orgId) return null;
  const row = credsService.getActive(orgId, 'tiktok');
  if (!row) return null;
  return {
    accessToken: row.access_token,
    openId:      row.account_id,
    credId:      row.id,
    expiresAt:   row.expires_at,
  };
}

/**
 * Download the video from `videoUrl` into a Buffer so we can chunk-upload
 * to TikTok. Public URL only — we don't carry any auth into the GET.
 *
 * Memory note: TikTok's Inbox limit is 287 MB. Even at the cap that's
 * fine in a 512 MB Node heap; we don't bother streaming until/unless
 * the cap is raised.
 */
async function fetchVideoBytes(videoUrl) {
  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`Source video fetch failed: ${res.status} ${videoUrl}`);
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

/**
 * Init an Inbox upload session. Returns { publishId, uploadUrl }.
 * For single-chunk uploads we set chunk_size = video_size and
 * total_chunk_count = 1; TikTok accepts this for videos up to 64 MB.
 * Larger videos would need real chunking.
 */
async function initUpload(accessToken, videoSize) {
  // TikTok requires chunk_size between 5 MB and 64 MB unless total_chunk_count is 1.
  // Single-chunk = same as video_size; we never split for now.
  const body = {
    source_info: {
      source: 'FILE_UPLOAD',
      video_size:        videoSize,
      chunk_size:        videoSize,
      total_chunk_count: 1,
    },
  };
  const res = await fetch(INIT_URL, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || (data.error && data.error.code && data.error.code !== 'ok')) {
    throw new Error(`TikTok init failed: ${res.status} ${JSON.stringify(data)}`);
  }
  // Shape: { data: { publish_id, upload_url }, error: { code, message, ... } }
  if (!data.data || !data.data.upload_url) {
    throw new Error(`TikTok init returned no upload_url: ${JSON.stringify(data)}`);
  }
  return {
    publishId: data.data.publish_id,
    uploadUrl: data.data.upload_url,
  };
}

/**
 * PUT the video bytes to TikTok's signed upload URL. Uses byte-range
 * headers in the format TikTok expects: `bytes 0-(N-1)/N` (NOT the
 * standard "bytes=0-N-1/N" — TikTok wants `bytes ` with a space).
 */
async function pushBytes(uploadUrl, videoBytes) {
  const len = videoBytes.length;
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type':   'video/mp4',
      'Content-Length': String(len),
      'Content-Range':  `bytes 0-${len - 1}/${len}`,
    },
    body: videoBytes,
  });
  if (!res.ok && res.status !== 201) {
    const text = await res.text().catch(() => '');
    throw new Error(`TikTok upload PUT failed: ${res.status} ${text}`);
  }
}

/** Poll the publish status. Optional — caller can fire-and-forget. */
async function fetchStatus(accessToken, publishId) {
  const res = await fetch(STATUS_URL, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({ publish_id: publishId }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`TikTok status fetch failed: ${res.status} ${JSON.stringify(data)}`);
  }
  // Shape: { data: { status, fail_reason?, publicly_available_post_id?, ... } }
  return data.data || data;
}

/**
 * High-level publish:
 *   * Download the source video (single fetch, public URL).
 *   * Init an Inbox upload session for the file.
 *   * PUT all bytes in one chunk.
 *   * Return { publishId, status } — caller decides whether to poll.
 *
 * The caption/notes from the post don't carry into Inbox mode — the
 * creator types those in the TikTok app when they review the draft.
 * Direct Post (post-audit) accepts caption + privacy_level on init.
 */
async function postToTikTok(videoUrl, opts = {}) {
  const cred = resolveCredential(opts.orgId);
  if (!cred) {
    throw new Error('No TikTok credential — connect TikTok in Settings → Connections');
  }
  if (!videoUrl) throw new Error('videoUrl is required');

  const bytes = await fetchVideoBytes(videoUrl);
  if (!bytes.length) throw new Error('Source video is empty');
  if (bytes.length > 287 * 1024 * 1024) {
    throw new Error('Video exceeds TikTok Inbox limit (287 MB)');
  }

  const { publishId, uploadUrl } = await initUpload(cred.accessToken, bytes.length);
  await pushBytes(uploadUrl, bytes);

  // Mark the credential as recently used so any "stale connection"
  // sweeps don't deactivate it just because we haven't called any
  // *user-info* endpoint in a while.
  try { credsService.markUsed(cred.credId); } catch (_) { /* non-fatal */ }

  return {
    ok: true,
    publishId,
    note: 'Video uploaded to creator inbox. The user must publish it from the TikTok app to make it live (Direct Post arrives after Production audit).',
  };
}

module.exports = {
  postToTikTok,
  fetchStatus,
};
