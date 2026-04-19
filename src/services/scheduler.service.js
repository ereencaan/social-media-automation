const cron = require('node-cron');
const { prepare } = require('../config/database');
const { postToInstagram } = require('./instagram.service');
const { postToFacebook } = require('./facebook.service');
const { postToLinkedIn } = require('./linkedin.service');
const { generateAndSavePost } = require('./post-factory.service');

// ---- Plan item automation windows ---------------------------------------
// Start generating a plan item's media this many hours before its scheduled
// publish time. Leaves enough buffer for user review when auto_publish is
// off, while still being fresh enough that content isn't stale.
const PLAN_GENERATE_LEAD_HOURS = 48;
// Don't attempt to regenerate a failed item more than this many times.
const PLAN_MAX_ATTEMPTS = 3;
// Concurrency cap on the auto-gen worker so a big plan doesn't blast the
// image / orchestrator APIs all at once.
const PLAN_GEN_CONCURRENCY = 2;

const activeJobs = new Map();

const platformPosters = {
  instagram: (post) => {
    const caption = `${post.caption}\n\n${post.hashtags}`;
    return postToInstagram(post.drive_url, caption);
  },
  facebook: (post) => {
    const message = `${post.caption}\n\n${post.hashtags}`;
    return postToFacebook(post.drive_url, message);
  },
  linkedin: (post) => {
    return postToLinkedIn(post.drive_url, post.caption);
  }
};

function logResult(postId, platform, status, response) {
  prepare(
    'INSERT INTO post_logs (post_id, platform, status, response) VALUES (?, ?, ?, ?)'
  ).run(postId, platform, status, JSON.stringify(response));
}

// =========================================================================
//   PLAN ITEM WORKERS — auto-generate + auto-publish
// =========================================================================

/** Generate media + caption for a single plan item, or mark it failed. */
async function generatePlanItem(itemId) {
  const item = prepare('SELECT * FROM content_plan_items WHERE id = ?').get(itemId);
  if (!item) return;
  // Guard: already past this step
  if (item.status !== 'planned' && item.status !== 'failed') return;
  if ((item.attempts || 0) >= PLAN_MAX_ATTEMPTS) {
    // Give up silently — user can still click 'Generate now' to reset
    return;
  }

  const plan = prepare('SELECT * FROM content_plans WHERE id = ?').get(item.plan_id);
  if (!plan || plan.status !== 'active') return;

  // Mark generating + bump attempts so concurrent ticks can't double-run
  const claim = prepare(`
    UPDATE content_plan_items
    SET status = 'generating',
        attempts = COALESCE(attempts, 0) + 1,
        updated_at = datetime('now')
    WHERE id = ? AND status IN ('planned','failed')
  `).run(itemId);
  if (!claim.changes) return;  // someone else already picked it up

  let platforms = [];
  try { platforms = JSON.parse(item.platforms || '[]'); } catch {}
  if (!platforms.length) platforms = ['instagram'];

  try {
    // Auto-publish ON => the post lands already approved, so the publisher
    // can pick it up at scheduled_for without user intervention.
    const initialStatus = plan.auto_publish ? 'scheduled' : 'draft';
    const { id: postId } = await generateAndSavePost({
      orgId: item.org_id,
      userId: null,                 // automated, not a specific user action
      prompt: item.topic_brief,
      platforms,
      onBrand: true,
      variants: 1,
      qualityGate: true,
      initialStatus,
    });

    // If auto-publish is on we also stamp the scheduled_at on the post so
    // the existing publisher cron wakes up on time.
    if (plan.auto_publish) {
      prepare("UPDATE posts SET scheduled_at = ? WHERE id = ?").run(item.scheduled_for, postId);
    }

    const nextStatus = plan.auto_publish ? 'approved' : 'draft';
    prepare(`
      UPDATE content_plan_items
      SET status = ?, post_id = ?, error = NULL, generated_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(nextStatus, postId, itemId);

    console.log(`[PlanWorker] generated item ${itemId} -> post ${postId} (auto_publish=${plan.auto_publish})`);
  } catch (err) {
    console.error(`[PlanWorker] item ${itemId} failed:`, err.message);
    prepare(`
      UPDATE content_plan_items
      SET status = 'failed', error = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(String(err.message).slice(0, 500), itemId);
  }
}

/** Pick N items that are due soon and generate them with a small concurrency cap. */
async function runPlanGenerationWorker() {
  const window = new Date(Date.now() + PLAN_GENERATE_LEAD_HOURS * 60 * 60 * 1000).toISOString();

  // Pull eligible items; exclude items already in flight. Also retry
  // 'failed' items up to PLAN_MAX_ATTEMPTS times — external APIs (Flux/BFL)
  // are flaky and most failures succeed on the second try.
  const due = prepare(`
    SELECT i.id
    FROM content_plan_items i
    JOIN content_plans p ON p.id = i.plan_id
    WHERE p.status = 'active'
      AND (
        i.status = 'planned'
        OR (i.status = 'failed' AND COALESCE(i.attempts, 0) < ?)
      )
      AND i.scheduled_for <= ?
    ORDER BY i.scheduled_for ASC
    LIMIT ?
  `).all(PLAN_MAX_ATTEMPTS, window, PLAN_GEN_CONCURRENCY * 3);

  if (!due.length) return;

  // Process in chunks of PLAN_GEN_CONCURRENCY
  for (let i = 0; i < due.length; i += PLAN_GEN_CONCURRENCY) {
    const chunk = due.slice(i, i + PLAN_GEN_CONCURRENCY);
    await Promise.all(chunk.map((r) => generatePlanItem(r.id).catch(() => {})));
  }
}

/**
 * Publish items whose scheduled time has arrived.
 * Eligible: status='approved' (either auto-promoted or manually approved
 * by the user). Also handles posts.scheduled_at for legacy manual schedules.
 */
async function runPlanPublishWorker() {
  const nowIso = new Date().toISOString();
  const due = prepare(`
    SELECT id, post_id
    FROM content_plan_items
    WHERE status = 'approved'
      AND post_id IS NOT NULL
      AND scheduled_for <= ?
  `).all(nowIso);

  for (const it of due) {
    try {
      // Claim
      const claim = prepare(
        "UPDATE content_plan_items SET status = 'publishing', updated_at = datetime('now') WHERE id = ? AND status = 'approved'"
      ).run(it.id);
      if (!claim.changes) continue;

      await publishPost(it.post_id);
      prepare(`
        UPDATE content_plan_items
        SET status = 'published', published_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(it.id);
    } catch (err) {
      console.error(`[PlanPublisher] item ${it.id} failed:`, err.message);
      prepare(`
        UPDATE content_plan_items
        SET status = 'failed', error = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(String(err.message).slice(0, 500), it.id);
    }
  }
}

/** Manual trigger used by the UI's "Generate now" / "Publish now" buttons. */
async function generatePlanItemNow(itemId, orgId) {
  const item = prepare('SELECT * FROM content_plan_items WHERE id = ? AND org_id = ?').get(itemId, orgId);
  if (!item) throw new Error('Item not found');
  await generatePlanItem(itemId);
  return prepare('SELECT * FROM content_plan_items WHERE id = ? AND org_id = ?').get(itemId, orgId);
}

async function publishPlanItemNow(itemId, orgId) {
  const item = prepare('SELECT * FROM content_plan_items WHERE id = ? AND org_id = ?').get(itemId, orgId);
  if (!item) throw new Error('Item not found');
  if (!item.post_id) throw new Error('No generated post yet — generate first');
  await publishPost(item.post_id);
  prepare(`
    UPDATE content_plan_items
    SET status = 'published', published_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(itemId);
  return prepare('SELECT * FROM content_plan_items WHERE id = ? AND org_id = ?').get(itemId, orgId);
}

async function publishPost(postId) {
  const post = prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) return;

  prepare("UPDATE posts SET status = 'posting', updated_at = datetime('now') WHERE id = ?").run(postId);

  const platforms = JSON.parse(post.platforms);
  const results = [];
  let allSuccess = true;

  for (const platform of platforms) {
    try {
      const poster = platformPosters[platform];
      if (!poster) {
        logResult(postId, platform, 'failed', { error: `Unknown platform: ${platform}` });
        allSuccess = false;
        continue;
      }
      const result = await poster(post);
      logResult(postId, platform, 'success', result);
      results.push(result);
      console.log(`[Scheduler] Posted to ${platform}: ${postId}`);
    } catch (err) {
      logResult(postId, platform, 'failed', { error: err.message });
      allSuccess = false;
      console.error(`[Scheduler] Failed ${platform}: ${err.message}`);
    }
  }

  const finalStatus = allSuccess ? 'posted' : 'failed';
  prepare("UPDATE posts SET status = ?, updated_at = datetime('now') WHERE id = ?").run(finalStatus, postId);

  return results;
}

function schedulePost(postId, scheduledAt) {
  cancelSchedule(postId);

  const targetDate = new Date(scheduledAt);
  const now = new Date();

  if (targetDate <= now) {
    console.log(`[Scheduler] Past date, publishing immediately: ${postId}`);
    publishPost(postId);
    return;
  }

  const delay = targetDate.getTime() - now.getTime();
  const timeout = setTimeout(() => {
    publishPost(postId);
    activeJobs.delete(postId);
  }, delay);

  activeJobs.set(postId, timeout);

  prepare("UPDATE posts SET status = 'scheduled', scheduled_at = ?, updated_at = datetime('now') WHERE id = ?")
    .run(scheduledAt, postId);

  console.log(`[Scheduler] Scheduled ${postId} for ${scheduledAt}`);
}

function cancelSchedule(postId) {
  if (activeJobs.has(postId)) {
    clearTimeout(activeJobs.get(postId));
    activeJobs.delete(postId);
  }
}

function loadPendingSchedules() {
  const pending = prepare("SELECT id, scheduled_at FROM posts WHERE status = 'scheduled' AND scheduled_at IS NOT NULL").all();

  for (const post of pending) {
    schedulePost(post.id, post.scheduled_at);
  }

  console.log(`[Scheduler] Loaded ${pending.length} pending schedules`);
}

// Check every minute for overdue posts (legacy single-post scheduling path)
cron.schedule('* * * * *', () => {
  const overdue = prepare(
    "SELECT id, scheduled_at FROM posts WHERE status = 'scheduled' AND scheduled_at <= datetime('now')"
  ).all();
  for (const post of overdue) {
    console.log(`[Scheduler] Found overdue post: ${post.id}`);
    publishPost(post.id);
  }
});

// Plan-driven workers:
//   every 10 min — generate media/captions for items whose schedule is inside the lead window
cron.schedule('*/10 * * * *', () => runPlanGenerationWorker().catch(err => console.error('[PlanWorker]', err)));
//   every minute  — publish items whose approved-state + scheduled_for has arrived
cron.schedule('* * * * *',    () => runPlanPublishWorker().catch(err => console.error('[PlanPublisher]', err)));

// Kick a generation cycle ~5s after boot so a just-past-window item doesn't
// wait up to 10 minutes for its first chance.
setTimeout(() => {
  runPlanGenerationWorker().catch(() => {});
  runPlanPublishWorker().catch(() => {});
}, 5000);

module.exports = {
  schedulePost, cancelSchedule, publishPost, loadPendingSchedules,
  // plan-item workers
  runPlanGenerationWorker, runPlanPublishWorker,
  generatePlanItemNow, publishPlanItemNow,
};
