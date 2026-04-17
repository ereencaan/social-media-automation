const express = require('express');
const router = express.Router();
const multer = require('multer');
const { prepare, save } = require('../config/database');
const { uploadImage } = require('../services/cloudinary.service');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files allowed'));
  }
});

// Ensure row exists for caller's org
function ensureRow(orgId) {
  const row = prepare('SELECT * FROM brand_settings WHERE org_id = ?').get(orgId);
  if (!row) {
    prepare('INSERT INTO brand_settings (org_id) VALUES (?)').run(orgId);
  }
}

// GET /api/brand
router.get('/', (req, res) => {
  ensureRow(req.user.orgId);
  const settings = prepare('SELECT * FROM brand_settings WHERE org_id = ?').get(req.user.orgId);
  res.json(settings);
});

// PUT /api/brand
router.put('/', (req, res) => {
  ensureRow(req.user.orgId);
  const fields = ['phone', 'website', 'whatsapp', 'instagram_handle', 'facebook_handle', 'linkedin_handle', 'overlay_position'];
  const updates = [];
  const values = [];

  for (const field of fields) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = ?`);
      values.push(req.body[field] || null);
    }
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  updates.push("updated_at = datetime('now')");
  values.push(req.user.orgId);

  prepare(`UPDATE brand_settings SET ${updates.join(', ')} WHERE org_id = ?`).run(...values);

  const settings = prepare('SELECT * FROM brand_settings WHERE org_id = ?').get(req.user.orgId);
  res.json(settings);
});

// POST /api/brand/logo
router.post('/logo', upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No logo file provided' });

    ensureRow(req.user.orgId);

    const result = await uploadImage(req.file.buffer, 'brand_logo');

    prepare("UPDATE brand_settings SET logo_url = ?, logo_cloudinary_id = ?, updated_at = datetime('now') WHERE org_id = ?")
      .run(result.publicUrl, result.fileId, req.user.orgId);

    const settings = prepare('SELECT * FROM brand_settings WHERE org_id = ?').get(req.user.orgId);
    res.json(settings);
  } catch (err) {
    console.error('[BrandLogo]', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/brand/logo
router.delete('/logo', (req, res) => {
  ensureRow(req.user.orgId);
  prepare("UPDATE brand_settings SET logo_url = NULL, logo_cloudinary_id = NULL, updated_at = datetime('now') WHERE org_id = ?").run(req.user.orgId);
  const settings = prepare('SELECT * FROM brand_settings WHERE org_id = ?').get(req.user.orgId);
  res.json(settings);
});

module.exports = router;
