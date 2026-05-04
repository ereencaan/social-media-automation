const express = require('express');
const router = express.Router();
const { prepare } = require('../config/database');
const { generateId, downloadImage } = require('../utils/helpers');
const { generateImage } = require('../services/flux.service');
const { generateContent } = require('../services/claude.service');
const { orchestrateContent } = require('../services/orchestrator.service');
const { analyzePrompt, rewritePrompt } = require('../services/prompt-analyzer.service');
const { refineContent } = require('../services/claude.service');
const { reviewArtifact } = require('../services/multi-reviewer.service');
const { generateAndSavePost } = require('../services/post-factory.service');
const { uploadImage, uploadFromUrl } = require('../services/cloudinary.service');
const { listTemplates, renderTemplate, renderVideo } = require('../services/templated.service');
const { generateVideo, generateVideoFromImage } = require('../services/runway.service');
const { applyImageOverlay, applyVideoOverlay } = require('../services/overlay.service');
const { schedulePost, cancelSchedule, publishPost } = require('../services/scheduler.service');
const { postToTikTok, fetchStatus: fetchTikTokStatus } = require('../services/tiktok.service');
const { postToYouTube } = require('../services/youtube.service');
const { enforceQuota, requirePlan } = require('../middleware/billing');
const { requireVerifiedEmail } = require('../middleware/email-verified');
const usage = require('../services/usage.service');

// Generate content with AI (DALL-E + Claude)
// Quota: counts as 1 post + 1 ai_call. Both must be under the plan limit.
// Verified email required — see middleware/email-verified.js.
router.post('/generate',
  requireVerifiedEmail,
  enforceQuota('posts'),
  enforceQuota('ai_calls'),
  async (req, res) => {
  try {
    const { prompt, platforms = ['instagram'], onBrand = true, variants = 1, qualityGate = true } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    const { id, post, content, quality } = await generateAndSavePost({
      orgId: req.user.orgId, userId: req.user.id,
      prompt, platforms, onBrand, variants, qualityGate,
    });

    // Increment AFTER success — failed generations don't burn quota.
    usage.increment(req.user.orgId, 'posts');
    usage.increment(req.user.orgId, 'ai_calls');

    res.json({
      id, prompt,
      caption:          content.caption,
      hashtags:         post.hashtags,
      platformCaptions: content.platformCaptions,
      imageUrl:         post.drive_url,
      driveUrl:         post.drive_url,
      status:           'draft',
      quality,
    });
  } catch (err) {
    console.error('[Generate]', err);
    res.status(500).json({ error: err.message });
  }
});

// Generate video/reel with AI (Runway + Claude)
// Pro+ only — video generation is bundled into the higher tiers.
router.post('/generate-video',
  requireVerifiedEmail,
  requirePlan('pro'),
  enforceQuota('posts'),
  enforceQuota('ai_calls'),
  async (req, res) => {
  try {
    let { prompt, platforms = ['instagram'], duration = 5, onBrand = true, variants = 1, qualityGate = true } = req.body;
    // Clamp to the durations Runway gen4.5 supports natively (5 or 10).
    // Longer reels need the multi-clip composer (P5) — until that ships,
    // anything else from the UI / a tampered request gets snapped to 5.
    duration = (Number(duration) === 10) ? 10 : 5;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    const brand = prepare('SELECT * FROM brand_settings WHERE org_id = ?').get(req.user.orgId);

    // 1. Orchestrated content generation (Claude → OpenAI critique → optional refine)
    const { content, quality } = await orchestrateContent(prompt, platforms, {
      business: brand, onBrand, variants, qualityGate,
    });

    // 2. Generate video with Runway
    const video = await generateVideo(content.imagePrompt || prompt, platforms[0], duration);

    // 3. Apply branding overlay + upload to Cloudinary
    let cloudResult;
    if (brand && (brand.logo_url || brand.phone || brand.website)) {
      const videoBuffer = await downloadImage(video.url);
      const overlaidBuffer = await applyVideoOverlay(videoBuffer, brand);
      const { uploadVideo } = require('../services/cloudinary.service');
      cloudResult = await uploadVideo(overlaidBuffer, `reel_${Date.now()}.mp4`);
    } else {
      cloudResult = await uploadFromUrl(video.url, { isVideo: true, publicId: `reel_${Date.now()}` });
    }

    // 4. Save to database
    const id = generateId();
    const hashtags = content.hashtags.map(t => `#${t}`).join(' ');

    prepare(`
      INSERT INTO posts (id, org_id, user_id, prompt, caption, hashtags, image_url, drive_url, drive_file_id, platforms, status, quality_score, quality_report)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
    `).run(
      id, req.user.orgId, req.user.id, prompt, content.caption, hashtags,
      video.url, cloudResult.publicUrl, cloudResult.fileId,
      JSON.stringify(platforms),
      quality ? quality.score : null,
      quality ? JSON.stringify(quality) : null,
    );

    usage.increment(req.user.orgId, 'posts');
    usage.increment(req.user.orgId, 'ai_calls');

    res.json({
      id,
      prompt,
      caption: content.caption,
      hashtags,
      platformCaptions: content.platformCaptions,
      imageUrl: cloudResult.publicUrl,
      driveUrl: cloudResult.publicUrl,
      format: 'mp4',
      status: 'draft',
      quality,
    });
  } catch (err) {
    console.error('[GenerateVideo]', err);
    res.status(500).json({ error: err.message });
  }
});

// Generate from Templated.io template
router.post('/generate-template',
  requireVerifiedEmail,
  enforceQuota('posts'),
  enforceQuota('ai_calls'),
  async (req, res) => {
  try {
    const { prompt, templateId, layers = {}, platforms = ['instagram'], format = 'jpg', onBrand = true } = req.body;
    if (!templateId) return res.status(400).json({ error: 'templateId is required' });

    const brand = prepare('SELECT * FROM brand_settings WHERE org_id = ?').get(req.user.orgId);

    // 1. Generate caption + hashtags with Claude (business-aware)
    const content = await generateContent(prompt || 'Social media post', platforms, { business: brand, onBrand });

    // 2. Auto-fill text layers from Claude output if not manually provided
    const autoLayers = { ...layers };
    if (!autoLayers['title'] && !autoLayers['text-1']) {
      // Try to set common layer names with generated content
      autoLayers['title'] = { text: content.caption.substring(0, 100) };
    }

    // 3. Render from template
    let result;
    if (format === 'mp4') {
      result = await renderVideo(templateId, autoLayers, { platform: platforms[0] });
    } else {
      result = await renderTemplate(templateId, autoLayers, { platform: platforms[0], format });
    }

    // 4. Upload to Cloudinary for permanent hosting
    const cloudResult = await uploadFromUrl(result.url, {
      isVideo: format === 'mp4',
      publicId: `post_${Date.now()}`
    });

    // 5. Save to database
    const id = generateId();
    const hashtags = content.hashtags.map(t => `#${t}`).join(' ');

    prepare(`
      INSERT INTO posts (id, org_id, user_id, prompt, caption, hashtags, image_url, drive_url, drive_file_id, platforms, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
    `).run(
      id, req.user.orgId, req.user.id, prompt || 'Template post', content.caption, hashtags,
      result.url, cloudResult.publicUrl, cloudResult.fileId,
      JSON.stringify(platforms)
    );

    usage.increment(req.user.orgId, 'posts');
    usage.increment(req.user.orgId, 'ai_calls');

    res.json({
      id,
      prompt,
      caption: content.caption,
      hashtags,
      platformCaptions: content.platformCaptions,
      imageUrl: cloudResult.publicUrl,
      driveUrl: cloudResult.publicUrl,
      templateRenderId: result.id,
      format,
      status: 'draft'
    });
  } catch (err) {
    console.error('[GenerateTemplate]', err);
    res.status(500).json({ error: err.message });
  }
});

// List Templated.io templates
router.get('/templates', async (req, res) => {
  try {
    const templates = await listTemplates();
    res.json(templates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Prompt pre-analysis (fast, single-model Claude by default) ---------
router.post('/analyze-prompt', requireVerifiedEmail, enforceQuota('ai_calls'), async (req, res) => {
  try {
    const { prompt, platforms = ['instagram'], models } = req.body || {};
    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({ error: 'Prompt is required' });
    }
    const brand = prepare('SELECT * FROM brand_settings WHERE org_id = ?').get(req.user.orgId);
    const result = await analyzePrompt({ prompt, business: brand, platforms, models });
    usage.increment(req.user.orgId, 'ai_calls');
    res.json(result);
  } catch (err) {
    console.error('[AnalyzePrompt]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Rewrite a prompt using suggestions + business profile -------------
router.post('/rewrite-prompt', requireVerifiedEmail, enforceQuota('ai_calls'), async (req, res) => {
  try {
    const { prompt, platforms = ['instagram'], suggestions = [] } = req.body || {};
    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({ error: 'Prompt is required' });
    }
    const brand = prepare('SELECT * FROM brand_settings WHERE org_id = ?').get(req.user.orgId);
    const rewritten = await rewritePrompt({ prompt, business: brand, platforms, suggestions });
    usage.increment(req.user.orgId, 'ai_calls');
    res.json({ prompt: rewritten });
  } catch (err) {
    console.error('[RewritePrompt]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Regenerate copy for an existing post, applying quality suggestions --
// Replaces caption/hashtags/platformCaptions in-place. Image is NOT
// regenerated (that's a separate, expensive call the user can trigger).
router.post('/:id/regenerate-copy', requireVerifiedEmail, enforceQuota('ai_calls'), async (req, res) => {
  try {
    const post = getOwnedPost(req.params.id, req.user.orgId);
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const brand = prepare('SELECT * FROM brand_settings WHERE org_id = ?').get(req.user.orgId);

    let prevQuality = null;
    if (post.quality_report) {
      try { prevQuality = JSON.parse(post.quality_report); } catch { /* ignore */ }
    }
    const suggestions = prevQuality && Array.isArray(prevQuality.suggestions)
      ? prevQuality.suggestions.map(s => typeof s === 'string' ? s : (s && s.text) || '')
      : [];
    const issues = prevQuality && Array.isArray(prevQuality.issues)
      ? prevQuality.issues.map(s => typeof s === 'string' ? s : (s && s.text) || '')
      : [];

    // Reconstruct the draft shape refineContent expects
    let platformsArr = [];
    try { platformsArr = JSON.parse(post.platforms || '[]'); } catch { platformsArr = []; }
    const previous = {
      caption:  post.caption,
      hashtags: (post.hashtags || '').split(/\s+/).filter(Boolean).map(t => t.replace(/^#/, '')),
      platformCaptions: {}, // regenerated by Claude
      imagePrompt: post.prompt,
    };

    const refinedContent = await refineContent({
      previous,
      critique: {
        overall: (prevQuality && prevQuality.score) || 0,
        scores:  (prevQuality && prevQuality.breakdown) || {},
        issues,
        suggestions,
        verdict: (prevQuality && prevQuality.verdict) || '',
      },
      prompt:    post.prompt,
      platforms: platformsArr,
      business:  brand,
      onBrand:   true,
    });

    // Re-score the refined content
    const newQuality = await reviewArtifact({
      artifact:     refinedContent,
      artifactType: 'social_post',
      context: {
        business: brand ? {
          business_name:        brand.business_name,
          industry:             brand.industry,
          business_description: brand.business_description,
          target_audience:      brand.target_audience,
          tone_of_voice:        brand.tone_of_voice,
          content_language:     brand.content_language,
        } : null,
        user_prompt:      post.prompt,
        target_platforms: platformsArr,
      },
    });

    const hashtags = refinedContent.hashtags.map(t => `#${t.replace(/^#/, '')}`).join(' ');
    const qualityPayload = {
      score:         newQuality.score,
      breakdown:     newQuality.breakdown,
      issues:        newQuality.issues,
      suggestions:   newQuality.suggestions,
      verdict:       newQuality.verdict,
      refined:       true,
      refinementNotes: 'Regenerated from previous suggestions',
      variantsTried: 1,
      needsReview:   newQuality.score < 60,
      perModel:      newQuality.perModel,
      modelsUsed:    newQuality.modelsUsed,
      modelsFailed:  newQuality.modelsFailed,
      degraded:      newQuality.degraded,
    };

    prepare(`
      UPDATE posts
      SET caption = ?, hashtags = ?, quality_score = ?, quality_report = ?, updated_at = datetime('now')
      WHERE id = ? AND org_id = ?
    `).run(
      refinedContent.caption, hashtags,
      qualityPayload.score, JSON.stringify(qualityPayload),
      req.params.id, req.user.orgId,
    );

    usage.increment(req.user.orgId, 'ai_calls');
    res.json(presentPost(getOwnedPost(req.params.id, req.user.orgId)));
  } catch (err) {
    console.error('[RegenerateCopy]', err);
    res.status(500).json({ error: err.message });
  }
});

// Helper: load post if it belongs to the caller's org, else null
function getOwnedPost(postId, orgId) {
  return prepare('SELECT * FROM posts WHERE id = ? AND org_id = ?').get(postId, orgId);
}

// Decorate DB row for API responses: parse platforms + quality_report JSON
function presentPost(p) {
  let platforms = [];
  try { platforms = JSON.parse(p.platforms || '[]'); } catch { platforms = []; }
  let quality = null;
  if (p.quality_report) {
    try { quality = JSON.parse(p.quality_report); } catch { quality = null; }
  }
  const out = { ...p, platforms, quality };
  delete out.quality_report; // raw blob is redundant with parsed `quality`
  return out;
}

// List all posts (current org only)
router.get('/', (req, res) => {
  const posts = prepare('SELECT * FROM posts WHERE org_id = ? ORDER BY created_at DESC').all(req.user.orgId);
  res.json(posts.map(presentPost));
});

// Get single post with logs
router.get('/:id', (req, res) => {
  const post = getOwnedPost(req.params.id, req.user.orgId);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const logs = prepare('SELECT * FROM post_logs WHERE post_id = ? ORDER BY posted_at DESC').all(req.params.id);
  res.json({ ...presentPost(post), logs });
});

// Update post (caption, hashtags, platforms)
router.put('/:id', (req, res) => {
  const { caption, hashtags, platforms } = req.body;
  const post = getOwnedPost(req.params.id, req.user.orgId);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  if (caption) prepare("UPDATE posts SET caption = ?, updated_at = datetime('now') WHERE id = ? AND org_id = ?").run(caption, req.params.id, req.user.orgId);
  if (hashtags) prepare("UPDATE posts SET hashtags = ?, updated_at = datetime('now') WHERE id = ? AND org_id = ?").run(hashtags, req.params.id, req.user.orgId);
  if (platforms) prepare("UPDATE posts SET platforms = ?, updated_at = datetime('now') WHERE id = ? AND org_id = ?").run(JSON.stringify(platforms), req.params.id, req.user.orgId);

  const updated = getOwnedPost(req.params.id, req.user.orgId);
  res.json({ ...updated, platforms: JSON.parse(updated.platforms) });
});

// Schedule post
router.post('/:id/schedule', (req, res) => {
  const { scheduledAt } = req.body;
  if (!scheduledAt) return res.status(400).json({ error: 'scheduledAt is required (ISO format)' });

  const post = getOwnedPost(req.params.id, req.user.orgId);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  schedulePost(req.params.id, scheduledAt);
  const updated = getOwnedPost(req.params.id, req.user.orgId);
  res.json({ ...updated, platforms: JSON.parse(updated.platforms) });
});

// Publish immediately
router.post('/:id/publish', async (req, res) => {
  const post = getOwnedPost(req.params.id, req.user.orgId);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  try {
    const results = await publishPost(req.params.id);
    const updated = getOwnedPost(req.params.id, req.user.orgId);
    const logs = prepare('SELECT * FROM post_logs WHERE post_id = ? ORDER BY posted_at DESC').all(req.params.id);
    res.json({ ...updated, platforms: JSON.parse(updated.platforms), logs, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Publish a post's video to TikTok as an Inbox draft. Sandbox-friendly
// (uses video.upload scope only). For testing flexibility we accept a
// body.video_url override so the operator can push any public video URL
// to TikTok without first having to run the post through the video
// generation pipeline.
//
// Direct Post (live publish, with caption) lands once the app passes
// TikTok's Production audit and we add the video.publish scope.
router.post('/:id/publish/tiktok', async (req, res) => {
  const post = getOwnedPost(req.params.id, req.user.orgId);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  // Prefer drive_url (public Cloudinary/Drive CDN URL) over image_url
  // (often a local /storage path) so TikTok can actually fetch the
  // bytes. Body override always wins for test runs against arbitrary
  // public mp4s.
  const videoUrl = (req.body && req.body.video_url) || post.drive_url || post.image_url;
  if (!videoUrl) {
    return res.status(400).json({
      error: 'Post has no media URL and no video_url override was provided',
    });
  }

  try {
    const result = await postToTikTok(videoUrl, { orgId: req.user.orgId });
    // Best-effort fetch of status so the UI can show "PROCESSING_UPLOAD"
    // immediately. Some publish_ids show null status for a few seconds
    // — we tolerate that.
    let status = null;
    try {
      const cred = require('../services/social-credentials.service').getActive(req.user.orgId, 'tiktok');
      if (cred) status = await fetchTikTokStatus(cred.access_token, result.publishId);
    } catch (_) { /* non-fatal */ }
    res.json({ ...result, status });
  } catch (err) {
    console.error('[posts/publish/tiktok]', err);
    res.status(500).json({ error: err.message });
  }
});

// Publish a post's video as a YouTube Short via the Data API v3
// resumable upload. Title + description come from the post's caption +
// hashtags; we always append #Shorts so YouTube classifies the upload
// as a Short. Defaults to privacy='private' so sandbox uploads don't
// go public — pass body.privacy='public' or 'unlisted' to override.
//
// Quota note: each successful publish costs 1,600 units; the default
// project quota is 10,000/day. In production we'll request an increase.
router.post('/:id/publish/youtube', async (req, res) => {
  const post = getOwnedPost(req.params.id, req.user.orgId);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  // Prefer the public CDN URL — same reasoning as the TikTok handler.
  const videoUrl = (req.body && req.body.video_url) || post.drive_url || post.image_url;
  if (!videoUrl) {
    return res.status(400).json({
      error: 'Post has no media URL and no video_url override was provided',
    });
  }

  try {
    const result = await postToYouTube(post, videoUrl, {
      orgId:   req.user.orgId,
      privacy: (req.body && req.body.privacy) || 'private',
    });
    res.json(result);
  } catch (err) {
    console.error('[posts/publish/youtube]', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete post
router.delete('/:id', (req, res) => {
  const post = getOwnedPost(req.params.id, req.user.orgId);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  cancelSchedule(req.params.id);
  prepare('DELETE FROM posts WHERE id = ? AND org_id = ?').run(req.params.id, req.user.orgId);
  res.json({ message: 'Deleted' });
});

module.exports = router;
