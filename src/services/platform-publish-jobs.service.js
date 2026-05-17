// Async-upload job tracking.
//
// Some platforms accept the upload synchronously but process it after
// the response — TikTok in particular: our POST returns once the bytes
// are PUT, but the video still moves through PROCESSING_DOWNLOAD →
// PROCESSING_UPLOAD before becoming visible in the creator's inbox.
// Failures (unsupported format, content moderation, expired upload URL)
// only surface during that processing window.
//
// We record one job per async upload, poll the platform on a backoff
// schedule from scheduler.service, and write the terminal outcome
// (SUCCEEDED / FAILED / EXPIRED) into post_logs so the UI's status
// chip reflects reality instead of just "we uploaded the bytes".

const crypto = require('crypto');
const { prepare } = require('../config/database');

// Backoff schedule (seconds-from-now for each attempt index).
// Picked to converge fast initially (TikTok ingests in ~30-60s most of
// the time) and stretch out so a stuck job doesn't burn the API quota.
const BACKOFF_SECONDS = [30, 30, 60, 60, 120, 240, 480, 600, 600];

// Cap on poll attempts so a permanently-stuck job auto-gives-up.
const MAX_ATTEMPTS = 60;

function id() {
  return crypto.randomBytes(12).toString('hex');
}

function nextPollIso(attempts) {
  const delay = BACKOFF_SECONDS[Math.min(attempts, BACKOFF_SECONDS.length - 1)];
  return new Date(Date.now() + delay * 1000).toISOString();
}

/**
 * Insert a tracking row right after the upload-POST succeeds.
 * Caller passes the platform-returned identifier (TikTok publish_id,
 * YouTube would be the resumable upload location, etc.).
 */
function createJob({ orgId, postId, platform, externalId, initialStatus = 'PENDING' }) {
  if (!orgId || !postId || !platform || !externalId) {
    throw new Error('orgId, postId, platform, externalId all required');
  }
  const jobId = id();
  prepare(`
    INSERT INTO platform_publish_jobs
      (id, org_id, post_id, platform, external_id, status, next_poll_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(jobId, orgId, postId, platform, externalId, initialStatus, nextPollIso(0));
  return jobId;
}

/** All jobs due for polling, oldest-first. Skips terminal jobs. */
function listDue(now = new Date()) {
  return prepare(`
    SELECT * FROM platform_publish_jobs
     WHERE terminal_at IS NULL
       AND attempts < ?
       AND (next_poll_at IS NULL OR next_poll_at <= ?)
     ORDER BY created_at
     LIMIT 25
  `).all(MAX_ATTEMPTS, now.toISOString());
}

/** Latest job for a post (UI lookups). */
function latestForPost(postId, platform) {
  return prepare(`
    SELECT * FROM platform_publish_jobs
     WHERE post_id = ? AND platform = ?
     ORDER BY created_at DESC LIMIT 1
  `).get(postId, platform);
}

function recordPollOutcome(jobId, { status, payload, error = null, terminal = false }) {
  const nowIso = new Date().toISOString();
  const row = prepare('SELECT attempts FROM platform_publish_jobs WHERE id = ?').get(jobId);
  const attempts = (row?.attempts || 0) + 1;
  const next = terminal ? null : nextPollIso(attempts);
  const term = terminal ? nowIso : null;
  prepare(`
    UPDATE platform_publish_jobs
       SET status = ?, attempts = ?, last_status_payload = ?, last_polled_at = ?,
           next_poll_at = ?, terminal_at = ?, error = ?, updated_at = datetime('now')
     WHERE id = ?
  `).run(
    String(status || 'UNKNOWN'),
    attempts,
    payload ? JSON.stringify(payload).slice(0, 2000) : null,
    nowIso,
    next,
    term,
    error ? String(error).slice(0, 500) : null,
    jobId,
  );
  // Auto-terminate after MAX_ATTEMPTS so the row stops being scheduled
  // even when the platform never returns a terminal status.
  if (!terminal && attempts >= MAX_ATTEMPTS) {
    prepare(`UPDATE platform_publish_jobs SET terminal_at = ?, error = COALESCE(error, ?) WHERE id = ?`)
      .run(nowIso, 'gave_up_after_max_attempts', jobId);
  }
}

/**
 * Poll a single TikTok job. Returns nothing — side effects only.
 *
 * TikTok statuses we observe (per docs):
 *   PROCESSING_DOWNLOAD  — still pulling our upload bytes (FILE_UPLOAD path)
 *   PROCESSING_UPLOAD    — server-side transcode in progress
 *   SUCCESS              — visible in creator's inbox (Inbox mode terminal)
 *   PUBLISH_COMPLETE     — visible publicly (Direct Post mode terminal)
 *   FAILED               — terminal failure; fail_reason populated
 *   EXPIRED              — TikTok gave up waiting for our bytes (also terminal)
 */
async function pollTikTok(job, { fetchStatus, resolveAccessToken, recordPostLog }) {
  try {
    const accessToken = await resolveAccessToken(job.org_id);
    if (!accessToken) {
      // No usable credential. Give up — the user disconnected TikTok or
      // refresh failed. Better to terminate than keep poking with stale
      // creds for the next 6 hours.
      recordPollOutcome(job.id, {
        status: 'FAILED',
        error: 'no_active_credential',
        terminal: true,
      });
      try { recordPostLog(job.post_id, 'tiktok', 'failed', { reason: 'No active TikTok credential to poll status' }); } catch (_) {}
      return;
    }

    const payload = await fetchStatus(accessToken, job.external_id);
    const status = String(payload?.status || 'UNKNOWN').toUpperCase();
    const isTerminal = ['SUCCESS', 'PUBLISH_COMPLETE', 'FAILED', 'EXPIRED'].includes(status);
    const failReason = payload?.fail_reason || null;

    recordPollOutcome(job.id, { status, payload, terminal: isTerminal, error: failReason });

    // Write the terminal outcome into post_logs so the post-detail UI
    // sees an authoritative "TikTok says done/failed" line.
    if (isTerminal) {
      const postLogStatus = (status === 'SUCCESS' || status === 'PUBLISH_COMPLETE') ? 'posted' : 'failed';
      const message = postLogStatus === 'posted'
        ? (status === 'PUBLISH_COMPLETE'
            ? 'TikTok: video is live'
            : 'TikTok: video delivered to creator inbox')
        : `TikTok: ${status}${failReason ? ` (${failReason})` : ''}`;
      try { recordPostLog(job.post_id, 'tiktok', postLogStatus, { status, fail_reason: failReason, raw: payload }, job.external_id); }
      catch (e) { console.warn('[publish-jobs] recordPostLog failed:', e.message); }
    }
  } catch (err) {
    // Network / transient errors: bump attempts but stay open, the next
    // tick will retry. Only platform-side terminal status set terminal=true.
    recordPollOutcome(job.id, {
      status: 'POLL_ERROR',
      error: err.message,
      terminal: false,
    });
  }
}

/**
 * Worker tick — call from a cron. Iterates due jobs and routes each to
 * the platform-specific poller. Currently TikTok-only; YouTube uploads
 * complete synchronously (upload → snippet metadata in the same call)
 * so they don't need this path.
 */
async function runPollerTick(deps) {
  const due = listDue();
  if (!due.length) return { polled: 0 };
  let polled = 0;
  for (const job of due) {
    if (job.platform === 'tiktok') {
      await pollTikTok(job, deps);
      polled++;
    } else {
      // Unknown platform: mark as failed so we don't keep selecting it.
      recordPollOutcome(job.id, {
        status: 'FAILED',
        error: `unsupported_platform:${job.platform}`,
        terminal: true,
      });
    }
  }
  return { polled };
}

module.exports = {
  createJob,
  listDue,
  latestForPost,
  recordPollOutcome,
  runPollerTick,
  MAX_ATTEMPTS,
  BACKOFF_SECONDS,
};
