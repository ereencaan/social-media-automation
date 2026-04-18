const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { prepare } = require('../config/database');

const ALLOWED_MIME = {
  'image/png':  '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif':  '.gif',
  'image/svg+xml': '.svg',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB cap
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME[file.mimetype]) cb(null, true);
    else cb(new Error('Only PNG, JPEG, WEBP, GIF, or SVG images are allowed'));
  },
});

const UPDATABLE_FIELDS = [
  // Visual identity
  'phone', 'whatsapp', 'website',
  'instagram_handle', 'facebook_handle', 'linkedin_handle',
  'overlay_position', 'primary_color',
  // Business profile (feeds the content generator)
  'business_name', 'industry', 'business_description',
  'target_audience', 'tone_of_voice', 'content_language',
];

function ensureRow(orgId) {
  const row = prepare('SELECT * FROM brand_settings WHERE org_id = ?').get(orgId);
  if (!row) prepare('INSERT INTO brand_settings (org_id) VALUES (?)').run(orgId);
}

function getSettings(orgId) {
  ensureRow(orgId);
  return prepare('SELECT * FROM brand_settings WHERE org_id = ?').get(orgId);
}

function cloudinaryConfigured() {
  return !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

// Local fallback storage layout: /storage/logos/<orgId>/<uuid><ext>
function saveLogoLocally(orgId, buffer, mime) {
  const ext = ALLOWED_MIME[mime] || '.bin';
  const dir = path.join(__dirname, '..', '..', 'storage', 'logos', orgId);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${crypto.randomUUID()}${ext}`;
  const abs = path.join(dir, filename);
  fs.writeFileSync(abs, buffer);
  // Public URL (served via requireAuth + express.static on /storage)
  return {
    publicUrl: `/storage/logos/${orgId}/${filename}`,
    fileId: `local:${orgId}/${filename}`,
  };
}

function deleteLocalLogoIfAny(fileId) {
  if (!fileId || !fileId.startsWith('local:')) return;
  const rel = fileId.slice('local:'.length);
  const abs = path.join(__dirname, '..', '..', 'storage', 'logos', rel);
  // Don't let a crafted fileId escape the logos dir
  const root = path.join(__dirname, '..', '..', 'storage', 'logos');
  if (!abs.startsWith(root + path.sep)) return;
  try { fs.unlinkSync(abs); } catch { /* already gone */ }
}

// ---- GET /api/brand ------------------------------------------------------
router.get('/', (req, res) => {
  res.json(getSettings(req.user.orgId));
});

// ---- PUT /api/brand ------------------------------------------------------
router.put('/', (req, res) => {
  ensureRow(req.user.orgId);

  const updates = [];
  const values = [];
  for (const field of UPDATABLE_FIELDS) {
    if (field in req.body) {
      updates.push(`${field} = ?`);
      values.push(req.body[field] ? String(req.body[field]) : null);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  updates.push("updated_at = datetime('now')");
  values.push(req.user.orgId);

  prepare(`UPDATE brand_settings SET ${updates.join(', ')} WHERE org_id = ?`).run(...values);
  res.json(getSettings(req.user.orgId));
});

// ---- POST /api/brand/logo -----------------------------------------------
router.post('/logo', (req, res) => {
  upload.single('logo')(req, res, async (mErr) => {
    if (mErr) return res.status(400).json({ error: mErr.message });
    try {
      if (!req.file) return res.status(400).json({ error: 'No logo file provided' });
      ensureRow(req.user.orgId);

      // Delete any existing local logo before overwriting
      const prev = prepare('SELECT logo_cloudinary_id FROM brand_settings WHERE org_id = ?').get(req.user.orgId);
      if (prev && prev.logo_cloudinary_id) deleteLocalLogoIfAny(prev.logo_cloudinary_id);

      let result;
      if (cloudinaryConfigured()) {
        const { uploadImage } = require('../services/cloudinary.service');
        result = await uploadImage(req.file.buffer, `brand_logo_${req.user.orgId}`);
      } else {
        result = saveLogoLocally(req.user.orgId, req.file.buffer, req.file.mimetype);
      }

      prepare(`
        UPDATE brand_settings
        SET logo_url = ?, logo_cloudinary_id = ?, updated_at = datetime('now')
        WHERE org_id = ?
      `).run(result.publicUrl, result.fileId, req.user.orgId);

      res.json(getSettings(req.user.orgId));
    } catch (err) {
      console.error('[BrandLogo]', err);
      res.status(500).json({ error: err.message });
    }
  });
});

// ---- POST /api/brand/autofill-from-website ------------------------------
// Fetches the given website (or the saved brand.website) and asks Claude
// to extract a business profile. Returns the suggested profile WITHOUT
// saving it; the client previews and confirms before PUT /api/brand.
router.post('/autofill-from-website', async (req, res) => {
  try {
    ensureRow(req.user.orgId);
    let url = (req.body && req.body.url) || '';
    if (!url) {
      const row = prepare('SELECT website FROM brand_settings WHERE org_id = ?').get(req.user.orgId);
      url = row && row.website;
    }
    if (!url) return res.status(400).json({ error: 'No website URL provided' });

    const { analyzeWebsite } = require('../services/website-analyzer.service');
    const result = await analyzeWebsite(url);
    res.json(result);
  } catch (err) {
    console.error('[BrandAutofill]', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ---- DELETE /api/brand/logo ---------------------------------------------
router.delete('/logo', (req, res) => {
  ensureRow(req.user.orgId);
  const cur = prepare('SELECT logo_cloudinary_id FROM brand_settings WHERE org_id = ?').get(req.user.orgId);
  if (cur && cur.logo_cloudinary_id) deleteLocalLogoIfAny(cur.logo_cloudinary_id);
  prepare(`
    UPDATE brand_settings
    SET logo_url = NULL, logo_cloudinary_id = NULL, updated_at = datetime('now')
    WHERE org_id = ?
  `).run(req.user.orgId);
  res.json(getSettings(req.user.orgId));
});

module.exports = router;
