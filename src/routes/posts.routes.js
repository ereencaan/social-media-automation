const express = require('express');
const router = express.Router();
const { prepare } = require('../config/database');
const { generateId, downloadImage } = require('../utils/helpers');
const { generateImage } = require('../services/openai.service');
const { generateContent } = require('../services/claude.service');
const { uploadImage } = require('../services/drive.service');
const { schedulePost, cancelSchedule, publishPost } = require('../services/scheduler.service');

// Generate content with AI
router.post('/generate', async (req, res) => {
  try {
    const { prompt, platforms = ['instagram'] } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    // 1. Generate caption + hashtags with Claude
    const content = await generateContent(prompt, platforms);

    // 2. Generate image with DALL-E
    const imagePrompt = content.imagePrompt || prompt;
    const image = await generateImage(imagePrompt, platforms[0]);

    // 3. Download and upload to Google Drive
    const imageBuffer = await downloadImage(image.url);
    const fileName = `post_${Date.now()}.jpg`;
    const driveResult = await uploadImage(imageBuffer, fileName);

    // 4. Save to database
    const id = generateId();
    const hashtags = content.hashtags.map(t => `#${t}`).join(' ');

    prepare(`
      INSERT INTO posts (id, prompt, caption, hashtags, image_url, drive_url, drive_file_id, platforms, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')
    `).run(
      id, prompt, content.caption, hashtags,
      image.url, driveResult.publicUrl, driveResult.fileId,
      JSON.stringify(platforms)
    );

    res.json({
      id,
      prompt,
      caption: content.caption,
      hashtags,
      platformCaptions: content.platformCaptions,
      imageUrl: image.url,
      driveUrl: driveResult.publicUrl,
      status: 'draft'
    });
  } catch (err) {
    console.error('[Generate]', err);
    res.status(500).json({ error: err.message });
  }
});

// List all posts
router.get('/', (req, res) => {
  const posts = prepare('SELECT * FROM posts ORDER BY created_at DESC').all();
  const parsed = posts.map(p => ({ ...p, platforms: JSON.parse(p.platforms) }));
  res.json(parsed);
});

// Get single post with logs
router.get('/:id', (req, res) => {
  const post = prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const logs = prepare('SELECT * FROM post_logs WHERE post_id = ? ORDER BY posted_at DESC').all(req.params.id);
  res.json({ ...post, platforms: JSON.parse(post.platforms), logs });
});

// Update post (caption, hashtags, platforms)
router.put('/:id', (req, res) => {
  const { caption, hashtags, platforms } = req.body;
  const post = prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  if (caption) prepare("UPDATE posts SET caption = ?, updated_at = datetime('now') WHERE id = ?").run(caption, req.params.id);
  if (hashtags) prepare("UPDATE posts SET hashtags = ?, updated_at = datetime('now') WHERE id = ?").run(hashtags, req.params.id);
  if (platforms) prepare("UPDATE posts SET platforms = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(platforms), req.params.id);

  const updated = prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  res.json({ ...updated, platforms: JSON.parse(updated.platforms) });
});

// Schedule post
router.post('/:id/schedule', (req, res) => {
  const { scheduledAt } = req.body;
  if (!scheduledAt) return res.status(400).json({ error: 'scheduledAt is required (ISO format)' });

  const post = prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  schedulePost(req.params.id, scheduledAt);
  const updated = prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  res.json({ ...updated, platforms: JSON.parse(updated.platforms) });
});

// Publish immediately
router.post('/:id/publish', async (req, res) => {
  const post = prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  try {
    const results = await publishPost(req.params.id);
    const updated = prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
    const logs = prepare('SELECT * FROM post_logs WHERE post_id = ? ORDER BY posted_at DESC').all(req.params.id);
    res.json({ ...updated, platforms: JSON.parse(updated.platforms), logs, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete post
router.delete('/:id', (req, res) => {
  const post = prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  cancelSchedule(req.params.id);
  prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

module.exports = router;
