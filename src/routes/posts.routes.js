const express = require('express');
const router = express.Router();
const { prepare } = require('../config/database');
const { generateId, downloadImage } = require('../utils/helpers');
const { generateImage } = require('../services/flux.service');
const { generateContent } = require('../services/claude.service');
const { orchestrateContent } = require('../services/orchestrator.service');
const { uploadImage, uploadFromUrl } = require('../services/cloudinary.service');
const { listTemplates, renderTemplate, renderVideo } = require('../services/templated.service');
const { generateVideo, generateVideoFromImage } = require('../services/runway.service');
const { applyImageOverlay, applyVideoOverlay } = require('../services/overlay.service');
const { schedulePost, cancelSchedule, publishPost } = require('../services/scheduler.service');

// Generate content with AI (DALL-E + Claude)
router.post('/generate', async (req, res) => {
  try {
    const {
      prompt,
      platforms = ['instagram'],
      onBrand = true,
      variants = 1,        // 1..3 parallel drafts, critique picks the best
      qualityGate = true,  // enable auto-critique + single refinement pass
    } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    // Load brand once: needed for business context AND for the overlay
    const brand = prepare('SELECT * FROM brand_settings WHERE org_id = ?').get(req.user.orgId);

    // 1. Orchestrated content generation (Claude draft(s) → OpenAI critique → optional Claude refine)
    const { content, quality } = await orchestrateContent(prompt, platforms, {
      business: brand, onBrand, variants, qualityGate,
    });

    // 2. Generate image with DALL-E
    const imagePrompt = content.imagePrompt || prompt;
    const image = await generateImage(imagePrompt, platforms[0]);

    // 3. Download, apply branding overlay, upload to Cloudinary
    const imageBuffer = await downloadImage(image.url);
    const finalBuffer = brand ? await applyImageOverlay(imageBuffer, brand) : imageBuffer;
    const fileName = `post_${Date.now()}.jpg`;
    const cloudResult = await uploadImage(finalBuffer, fileName);

    // 4. Save to database
    const id = generateId();
    const hashtags = content.hashtags.map(t => `#${t}`).join(' ');

    prepare(`
      INSERT INTO posts (id, org_id, user_id, prompt, caption, hashtags, image_url, drive_url, drive_file_id, platforms, status, quality_score, quality_report)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
    `).run(
      id, req.user.orgId, req.user.id, prompt, content.caption, hashtags,
      image.url, cloudResult.publicUrl, cloudResult.fileId,
      JSON.stringify(platforms),
      quality ? quality.score : null,
      quality ? JSON.stringify(quality) : null,
    );

    res.json({
      id,
      prompt,
      caption: content.caption,
      hashtags,
      platformCaptions: content.platformCaptions,
      imageUrl: cloudResult.publicUrl,
      driveUrl: cloudResult.publicUrl,
      status: 'draft',
      quality,
    });
  } catch (err) {
    console.error('[Generate]', err);
    res.status(500).json({ error: err.message });
  }
});

// Generate video/reel with AI (Runway + Claude)
router.post('/generate-video', async (req, res) => {
  try {
    const { prompt, platforms = ['instagram'], duration = 5, onBrand = true, variants = 1, qualityGate = true } = req.body;
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
router.post('/generate-template', async (req, res) => {
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

// Delete post
router.delete('/:id', (req, res) => {
  const post = getOwnedPost(req.params.id, req.user.orgId);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  cancelSchedule(req.params.id);
  prepare('DELETE FROM posts WHERE id = ? AND org_id = ?').run(req.params.id, req.user.orgId);
  res.json({ message: 'Deleted' });
});

module.exports = router;
