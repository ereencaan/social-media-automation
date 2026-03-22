const cron = require('node-cron');
const { prepare, save } = require('../config/database');
const { postToInstagram } = require('./instagram.service');
const { postToFacebook } = require('./facebook.service');
const { postToLinkedIn } = require('./linkedin.service');

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

// Check every minute for overdue posts
cron.schedule('* * * * *', () => {
  const overdue = prepare(
    "SELECT id, scheduled_at FROM posts WHERE status = 'scheduled' AND scheduled_at <= datetime('now')"
  ).all();

  for (const post of overdue) {
    console.log(`[Scheduler] Found overdue post: ${post.id}`);
    publishPost(post.id);
  }
});

module.exports = { schedulePost, cancelSchedule, publishPost, loadPendingSchedules };
