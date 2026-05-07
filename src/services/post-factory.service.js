// Shared post-creation pipeline.
//
// The /api/posts/generate route and the plan item auto-generator both need
// the same flow: orchestrator → image → overlay → Cloudinary → DB row.
// This module is the single source of truth for that pipeline so the two
// call sites can't drift. Do not inline this logic elsewhere.

const { prepare } = require('../config/database');
const { generateId, downloadImage } = require('../utils/helpers');
const { generateImage } = require('./flux.service');
const { applyImageOverlay } = require('./overlay.service');
const { uploadImage } = require('./cloudinary.service');
const { orchestrateContent } = require('./orchestrator.service');

/**
 * Build and persist a post from a prompt.
 *
 * @param {object} opts
 * @param {string}  opts.orgId
 * @param {string?} opts.userId      — null for automated plan items
 * @param {string}  opts.prompt
 * @param {string[]} [opts.platforms=['instagram']]
 * @param {boolean} [opts.onBrand=true]
 * @param {number}  [opts.variants=1]
 * @param {boolean} [opts.qualityGate=true]
 * @param {string?} [opts.initialStatus='draft']
 *
 * @returns {Promise<{ id, post, content, quality }>}
 */
async function generateAndSavePost({
  orgId, userId = null, prompt,
  platforms = ['instagram'],
  onBrand = true, variants = 1, qualityGate = true,
  initialStatus = 'draft',
  existingId = null, // when set, UPDATE that row instead of INSERTing new
  brandId = null,    // multi-brand: target a specific brand profile; null → default
}) {
  if (!orgId) throw new Error('orgId required');
  if (!prompt) throw new Error('prompt required');

  // 1. Resolve the brand profile this post is created against. Explicit
  // brand_id wins (multi-brand UI selection); else fall back to the
  // org's default brand. Pre-multi databases land here with exactly one
  // row flagged is_default=1 by the database.js migration.
  const brand = brandId
    ? prepare('SELECT * FROM brand_settings WHERE id = ? AND org_id = ?').get(brandId, orgId)
    : prepare('SELECT * FROM brand_settings WHERE org_id = ? AND is_default = 1').get(orgId);

  // 2. Multi-model orchestrated content
  const { content, quality } = await orchestrateContent(prompt, platforms, {
    business: brand, onBrand, variants, qualityGate,
  });

  // 3. Image (Flux) + brand overlay + Cloudinary
  const imagePrompt = content.imagePrompt || prompt;
  const image = await generateImage(imagePrompt, platforms[0]);
  const imageBuffer = await downloadImage(image.url);
  const finalBuffer = brand ? await applyImageOverlay(imageBuffer, brand) : imageBuffer;
  const fileName = `post_${Date.now()}.jpg`;
  const cloudResult = await uploadImage(finalBuffer, fileName);

  // 4. Persist — UPDATE the placeholder row when the route created one
  // up-front (async-job pattern), otherwise INSERT a fresh row.
  const id = existingId || generateId();
  const hashtags = content.hashtags.map((t) => `#${String(t).replace(/^#/, '')}`).join(' ');

  if (existingId) {
    prepare(`
      UPDATE posts
         SET caption = ?, hashtags = ?, image_url = ?, drive_url = ?, drive_file_id = ?,
             status = ?, quality_score = ?, quality_report = ?,
             brand_id = COALESCE(?, brand_id), updated_at = datetime('now')
       WHERE id = ? AND org_id = ?
    `).run(
      content.caption, hashtags, image.url, cloudResult.publicUrl, cloudResult.fileId,
      initialStatus,
      quality ? quality.score : null,
      quality ? JSON.stringify(quality) : null,
      brand ? brand.id : null,
      id, orgId,
    );
  } else {
    prepare(`
      INSERT INTO posts
        (id, org_id, user_id, prompt, caption, hashtags, image_url, drive_url, drive_file_id, platforms, status, quality_score, quality_report, brand_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, orgId, userId, prompt, content.caption, hashtags,
      image.url, cloudResult.publicUrl, cloudResult.fileId,
      JSON.stringify(platforms),
      initialStatus,
      quality ? quality.score : null,
      quality ? JSON.stringify(quality) : null,
      brand ? brand.id : null,
    );
  }

  const post = prepare('SELECT * FROM posts WHERE id = ? AND org_id = ?').get(id, orgId);
  return { id, post, content, quality };
}

module.exports = { generateAndSavePost };
