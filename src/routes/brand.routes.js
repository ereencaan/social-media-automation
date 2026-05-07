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
  'overlay_position', 'primary_color', 'overlay_contact_enabled',
  // Business profile (feeds the content generator)
  'business_name', 'industry', 'business_description',
  'target_audience', 'tone_of_voice', 'content_language',
  // Calendar inputs
  'country', 'founding_date',
];

// Multi-brand layer: an org can carry N brand_settings rows, exactly one
// of them flagged is_default=1. Pre-multi data is migrated by
// database.js init: every existing row gets is_default=1 and a
// 'Default' name. From here on, callers that want "the brand"
// (no specific id) get the default; callers with a brand_id pull
// that specific row.

function ensureDefaultBrand(orgId) {
  const row = prepare('SELECT id FROM brand_settings WHERE org_id = ? AND is_default = 1').get(orgId);
  if (row) return row.id;
  // Brand-new org with no row yet — seed a default.
  const id = generateId();
  prepare(`
    INSERT INTO brand_settings (id, org_id, name, is_default)
    VALUES (?, ?, 'Default', 1)
  `).run(id, orgId);
  return id;
}

function listBrands(orgId) {
  return prepare(
    'SELECT * FROM brand_settings WHERE org_id = ? ORDER BY is_default DESC, name COLLATE NOCASE'
  ).all(orgId);
}

function getBrand(orgId, brandId) {
  return prepare('SELECT * FROM brand_settings WHERE id = ? AND org_id = ?').get(brandId, orgId);
}

function getDefaultBrand(orgId) {
  ensureDefaultBrand(orgId);
  return prepare('SELECT * FROM brand_settings WHERE org_id = ? AND is_default = 1').get(orgId);
}

// Legacy helper kept for the older logo / autofill / etc. handlers below
// that still operate on "the org's brand". They now route to the default
// brand transparently.
function getSettings(orgId) {
  return getDefaultBrand(orgId);
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

// ---- GET /api/brand --------------------------------------------------------
// Legacy contract: returned the single brand row. New contract: returns
// the org's *default* brand (so existing callers like the post pipeline
// see a single row in the same shape). Use /api/brand/list for the full
// multi-brand listing the new UI consumes.
router.get('/', (req, res) => {
  res.json(getSettings(req.user.orgId));
});

// ---- GET /api/brand/list ---------------------------------------------------
// Multi-brand listing. Each row carries is_default flag so the UI can
// render the active-brand badge without an extra query.
router.get('/list', (req, res) => {
  ensureDefaultBrand(req.user.orgId);
  res.json(listBrands(req.user.orgId));
});

// ---- POST /api/brand -------------------------------------------------------
// Create a new brand for this org. Body: { name } (required). The newly
// created row is returned with is_default=0; the caller can flip it via
// PUT /api/brand/:id with { is_default: true } to make it the default.
router.post('/', (req, res) => {
  const name = (req.body && req.body.name ? String(req.body.name) : '').trim();
  if (!name) return res.status(400).json({ error: 'Brand name is required' });
  if (name.length > 80) return res.status(400).json({ error: 'Brand name too long (max 80 chars)' });

  // Make sure the org has a default before adding a new brand — protects
  // the invariant that every org always has exactly one default.
  ensureDefaultBrand(req.user.orgId);

  const id = generateId();
  prepare(`
    INSERT INTO brand_settings (id, org_id, name, is_default)
    VALUES (?, ?, ?, 0)
  `).run(id, req.user.orgId, name);
  res.status(201).json(getBrand(req.user.orgId, id));
});

// ---- GET /api/brand/:id ----------------------------------------------------
router.get('/:id', (req, res) => {
  // The handful of static sub-routes above (/list, /logo, /holidays, …) are
  // declared first; once they're matched Express won't fall into here.
  const row = getBrand(req.user.orgId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Brand not found' });
  res.json(row);
});

// ---- PUT /api/brand[/:id] --------------------------------------------------
// Update one brand. The legacy contract (PUT /api/brand without an id)
// updates the default brand for backward compatibility with any older
// SPA cache the user might have. The new path (PUT /api/brand/:id) lets
// the multi-brand UI target a specific row. Both share the same handler.
function brandUpdateHandler(req, res) {
  const orgId = req.user.orgId;
  const targetId = req.params.id || (getDefaultBrand(orgId) && getDefaultBrand(orgId).id);
  if (!targetId) return res.status(404).json({ error: 'Brand not found' });
  const existing = getBrand(orgId, targetId);
  if (!existing) return res.status(404).json({ error: 'Brand not found' });

  const updates = [];
  const values = [];
  // 'name' is multi-brand specific — UPDATABLE_FIELDS doesn't carry it.
  if ('name' in req.body) {
    const n = String(req.body.name || '').trim();
    if (!n) return res.status(400).json({ error: 'Brand name cannot be empty' });
    updates.push('name = ?');
    values.push(n.slice(0, 80));
  }
  for (const field of UPDATABLE_FIELDS) {
    if (field in req.body) {
      updates.push(`${field} = ?`);
      if (field === 'overlay_contact_enabled') {
        const v = req.body[field];
        values.push((v === true || v === 1 || v === '1' || v === 'on') ? 1 : 0);
      } else {
        values.push(req.body[field] ? String(req.body[field]) : null);
      }
    }
  }

  // is_default flip: setting one brand as default automatically demotes
  // the previous default. We do it in a single transaction-shape so the
  // invariant (exactly one default per org) holds even mid-update.
  if ('is_default' in req.body) {
    const wantDefault = req.body.is_default === true || req.body.is_default === 1 || req.body.is_default === '1';
    if (wantDefault) {
      prepare("UPDATE brand_settings SET is_default = 0 WHERE org_id = ?").run(orgId);
      updates.push('is_default = 1');
    }
    // We never let an explicit { is_default: false } clear the flag —
    // there must always be a default. Caller picks a different brand
    // and flips THAT to default; this row is demoted automatically.
  }

  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = datetime('now')");
  values.push(targetId, orgId);

  prepare(`UPDATE brand_settings SET ${updates.join(', ')} WHERE id = ? AND org_id = ?`).run(...values);

  // Side effect: founding_date change re-seeds the auto anniversary entry.
  // Scope it to this brand by passing brand_id in (note in DB is per-org
  // today; future cleanup is to make __auto_founding_anniversary__ rows
  // scoped to a brand_id too).
  if ('founding_date' in req.body) {
    upsertFoundingAnniversary(orgId, req.body.founding_date);
  }

  res.json(getBrand(orgId, targetId));
}
router.put('/', brandUpdateHandler);
router.put('/:id', brandUpdateHandler);

// ---- DELETE /api/brand/:id -------------------------------------------------
// Block deletion of the default brand — the UI must promote a different
// brand first. Leaves posts that reference the deleted brand in place
// (brand_id is nullable; orchestrator falls back to the org default at
// re-evaluation time).
router.delete('/:id', (req, res) => {
  const row = getBrand(req.user.orgId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Brand not found' });
  if (row.is_default) {
    return res.status(409).json({ error: 'Cannot delete the default brand. Promote another brand first.' });
  }
  prepare('DELETE FROM brand_settings WHERE id = ? AND org_id = ?').run(req.params.id, req.user.orgId);
  res.json({ ok: true });
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
// Resolve the brand a logo / autofill / delete handler should operate on:
// explicit ?brand_id=... query param wins, else fall back to the org's
// default brand. Keeps legacy callers working without parameter while the
// new multi-brand UI passes a specific id when editing a non-default brand.
function resolveTargetBrand(req) {
  const orgId = req.user.orgId;
  const explicit = req.query && req.query.brand_id;
  if (explicit) {
    const row = getBrand(orgId, String(explicit));
    if (!row) return null;
    return row;
  }
  return getDefaultBrand(orgId);
}

router.post('/logo', (req, res) => {
  upload.single('logo')(req, res, async (mErr) => {
    if (mErr) return res.status(400).json({ error: mErr.message });
    try {
      if (!req.file) return res.status(400).json({ error: 'No logo file provided' });
      const target = resolveTargetBrand(req);
      if (!target) return res.status(404).json({ error: 'Brand not found' });

      // Delete any existing local logo before overwriting
      if (target.logo_cloudinary_id) deleteLocalLogoIfAny(target.logo_cloudinary_id);

      let result;
      if (cloudinaryConfigured()) {
        const { uploadImage } = require('../services/cloudinary.service');
        result = await uploadImage(req.file.buffer, `brand_logo_${target.id}`);
      } else {
        result = saveLogoLocally(req.user.orgId, req.file.buffer, req.file.mimetype);
      }

      prepare(`
        UPDATE brand_settings
        SET logo_url = ?, logo_cloudinary_id = ?, updated_at = datetime('now')
        WHERE id = ? AND org_id = ?
      `).run(result.publicUrl, result.fileId, target.id, req.user.orgId);

      res.json(getBrand(req.user.orgId, target.id));
    } catch (err) {
      console.error('[BrandLogo]', err);
      res.status(500).json({ error: err.message });
    }
  });
});

// ---- POST /api/brand/autofill-from-website ------------------------------
// Fetches the given website (or the saved brand.website) and asks Claude
// to extract a business profile. Returns the suggested profile WITHOUT
// saving it; the client previews and confirms before PUT /api/brand[/:id].
router.post('/autofill-from-website', async (req, res) => {
  try {
    const target = resolveTargetBrand(req);
    if (!target) return res.status(404).json({ error: 'Brand not found' });
    const url = (req.body && req.body.url) || target.website;
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
  const target = resolveTargetBrand(req);
  if (!target) return res.status(404).json({ error: 'Brand not found' });
  if (target.logo_cloudinary_id) deleteLocalLogoIfAny(target.logo_cloudinary_id);
  prepare(`
    UPDATE brand_settings
    SET logo_url = NULL, logo_cloudinary_id = NULL, updated_at = datetime('now')
    WHERE id = ? AND org_id = ?
  `).run(target.id, req.user.orgId);
  res.json(getBrand(req.user.orgId, target.id));
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
