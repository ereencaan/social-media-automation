const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { prepare } = require('../config/database');
const { generateId } = require('../utils/helpers');
const Holidays = require('date-holidays');

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
  // Calendar inputs
  'country', 'founding_date',
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

  // Side effect: when founding_date is set or changed, ensure a
  // "Company anniversary" entry exists in brand_special_dates so the
  // planner picks it up every year automatically.
  if ('founding_date' in req.body) {
    upsertFoundingAnniversary(req.user.orgId, req.body.founding_date);
  }

  res.json(getSettings(req.user.orgId));
});

function upsertFoundingAnniversary(orgId, foundingDateRaw) {
  // Drop any prior auto-anniversary for this org (we tag note with a sentinel).
  prepare(
    "DELETE FROM brand_special_dates WHERE org_id = ? AND note = '__auto_founding_anniversary__'"
  ).run(orgId);
  if (!foundingDateRaw) return;
  const m = String(foundingDateRaw).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  if (!month || !day) return;
  prepare(`
    INSERT INTO brand_special_dates (id, org_id, month, day, name, note, tier, annual)
    VALUES (?, ?, ?, ?, ?, '__auto_founding_anniversary__', 1, 1)
  `).run(
    generateId(), orgId, month, day,
    `Company anniversary (founded ${year})`,
  );
}

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

// ---- GET /api/brand/holidays?country=GB&year=2026 ------------------------
// Read-only list of public holidays for the brand's country, computed live
// from the `date-holidays` package. The planner pulls from the same source.
router.get('/holidays', (req, res) => {
  try {
    const country = String(req.query.country || '').trim().toUpperCase();
    if (!country) return res.status(400).json({ error: 'country query param required (ISO alpha-2)' });
    const year = Number(req.query.year) || new Date().getFullYear();
    const hd = new Holidays(country);
    const list = (hd.getHolidays(year) || [])
      .filter(h => h.type === 'public' || h.type === 'bank')
      .map(h => ({
        date: h.date.slice(0, 10),
        name: h.name,
        type: h.type,
      }));
    res.json({ country, year, holidays: list });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Business-specific important dates ------------------------------------
// GET  /api/brand/dates         — list
// POST /api/brand/dates         — create { month, day, name, note?, tier?, annual? }
// PUT  /api/brand/dates/:id     — update
// DELETE /api/brand/dates/:id   — remove
const DATE_UPDATABLE = ['month', 'day', 'name', 'note', 'tier', 'annual'];

function validateDateInput(body) {
  const m = Number(body.month);
  const d = Number(body.day);
  if (!Number.isInteger(m) || m < 1 || m > 12) throw new Error('month must be 1-12');
  if (!Number.isInteger(d) || d < 1 || d > 31) throw new Error('day must be 1-31');
  if (!body.name || !String(body.name).trim()) throw new Error('name is required');
}

router.get('/dates', (req, res) => {
  const rows = prepare(
    'SELECT * FROM brand_special_dates WHERE org_id = ? ORDER BY month ASC, day ASC'
  ).all(req.user.orgId);
  res.json(rows);
});

router.post('/dates', (req, res) => {
  try {
    validateDateInput(req.body || {});
    const id = generateId();
    prepare(`
      INSERT INTO brand_special_dates (id, org_id, month, day, name, note, tier, annual)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, req.user.orgId,
      Number(req.body.month), Number(req.body.day),
      String(req.body.name).trim(),
      req.body.note ? String(req.body.note).trim() : null,
      Number.isFinite(Number(req.body.tier)) ? Math.max(1, Math.min(3, Number(req.body.tier))) : 1,
      req.body.annual === false || req.body.annual === 0 ? 0 : 1,
    );
    res.status(201).json(prepare('SELECT * FROM brand_special_dates WHERE id = ?').get(id));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.put('/dates/:id', (req, res) => {
  const sets = [], vals = [];
  for (const k of DATE_UPDATABLE) {
    if (k in req.body) {
      sets.push(`${k} = ?`);
      vals.push(k === 'annual' ? (req.body[k] ? 1 : 0) : req.body[k]);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'No updatable fields' });
  vals.push(req.params.id, req.user.orgId);
  const result = prepare(`UPDATE brand_special_dates SET ${sets.join(', ')} WHERE id = ? AND org_id = ?`).run(...vals);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json(prepare('SELECT * FROM brand_special_dates WHERE id = ? AND org_id = ?').get(req.params.id, req.user.orgId));
});

router.delete('/dates/:id', (req, res) => {
  const result = prepare('DELETE FROM brand_special_dates WHERE id = ? AND org_id = ?')
    .run(req.params.id, req.user.orgId);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;
