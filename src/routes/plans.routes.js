// Content plan routes. All scoped by req.user.orgId.
//
// Lifecycle:
//   POST /api/plans/preview           — dry run, returns AI plan + quality, saves nothing
//   POST /api/plans                   — persist a (possibly edited) plan + items
//   GET  /api/plans                   — list plans for this org
//   GET  /api/plans/:id               — plan + items
//   PUT  /api/plans/:id               — update plan-level fields (auto_publish, status, ...)
//   DELETE /api/plans/:id             — delete plan + items
//
//   PUT  /api/plans/:id/items/:itemId — update an item (reschedule, edit brief, skip)
//   POST /api/plans/:id/items         — add a new item to a plan manually

const express = require('express');
const router = express.Router();
const { prepare } = require('../config/database');
const { generateId } = require('../utils/helpers');
const { planMonth } = require('../services/content-planner.service');
const { generatePlanItemNow, publishPlanItemNow } = require('../services/scheduler.service');

function getOwnedPlan(id, orgId) {
  return prepare('SELECT * FROM content_plans WHERE id = ? AND org_id = ?').get(id, orgId);
}

function presentPlan(p) {
  if (!p) return null;
  let strategy = null;
  if (p.strategy) {
    try { strategy = JSON.parse(p.strategy); } catch {}
  }
  return { ...p, strategy };
}

function presentItem(it) {
  if (!it) return null;
  let platforms = [];
  try { platforms = JSON.parse(it.platforms || '[]'); } catch {}
  return { ...it, platforms };
}

// ---- POST /api/plans/preview ---------------------------------------------
router.post('/preview', async (req, res) => {
  try {
    const {
      month, targetCount, mode = 'hybrid',
      platformMix, constraints, customDays: extraDays, country,
    } = req.body || {};
    if (!month) return res.status(400).json({ error: 'month (YYYY-MM) is required' });
    if (!targetCount) return res.status(400).json({ error: 'targetCount is required' });

    const brand = prepare('SELECT * FROM brand_settings WHERE org_id = ?').get(req.user.orgId);

    // Merge user-supplied ad-hoc dates with the org's saved business dates
    // that fall in the target month.
    const [y, m] = month.split('-').map(Number);
    const dbDates = prepare(
      'SELECT month, day, name, note, tier FROM brand_special_dates WHERE org_id = ? AND month = ?'
    ).all(req.user.orgId, m).map((r) => ({
      date: `${y}-${String(r.month).padStart(2,'0')}-${String(r.day).padStart(2,'0')}`,
      name: r.name + (r.note ? ` (${r.note})` : ''),
      tier: r.tier || 1,
    }));
    const customDays = [...(Array.isArray(extraDays) ? extraDays : []), ...dbDates];

    const result = await planMonth({
      business:    brand,
      month, targetCount, mode,
      platformMix, constraints, customDays, country,
    });
    res.json(result);
  } catch (err) {
    console.error('[PlanPreview]', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- POST /api/plans  (persist) ------------------------------------------
router.post('/', async (req, res) => {
  try {
    const {
      month, targetCount, mode = 'hybrid',
      platformMix, constraints, items,
      autoPublish = 0,
    } = req.body || {};
    if (!month) return res.status(400).json({ error: 'month is required' });
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'items[] required' });
    }

    const planId = generateId();
    prepare(`
      INSERT INTO content_plans (id, org_id, month, target_count, mode, strategy, status, auto_publish)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(
      planId, req.user.orgId, month,
      targetCount || items.length,
      mode,
      JSON.stringify({ platformMix: platformMix || null, constraints: constraints || null }),
      autoPublish ? 1 : 0,
    );

    const insertItem = prepare(`
      INSERT INTO content_plan_items
        (id, org_id, plan_id, scheduled_for, theme, topic_brief, platforms, status, reasoning)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?)
    `);
    for (const it of items) {
      if (!it || !it.scheduled_for || !it.topic_brief) continue;
      insertItem.run(
        generateId(), req.user.orgId, planId,
        String(it.scheduled_for),
        String(it.theme || 'general').slice(0, 80),
        String(it.topic_brief).slice(0, 1000),
        JSON.stringify(Array.isArray(it.platforms) ? it.platforms : ['instagram']),
        String(it.reasoning || '').slice(0, 400),
      );
    }

    res.status(201).json(await loadPlanFull(planId, req.user.orgId));
  } catch (err) {
    console.error('[PlanCreate]', err);
    res.status(500).json({ error: err.message });
  }
});

function loadPlanFull(planId, orgId) {
  const plan = getOwnedPlan(planId, orgId);
  if (!plan) return null;
  const items = prepare(
    'SELECT * FROM content_plan_items WHERE plan_id = ? AND org_id = ? ORDER BY scheduled_for ASC'
  ).all(planId, orgId);
  return { ...presentPlan(plan), items: items.map(presentItem) };
}

// ---- GET /api/plans ------------------------------------------------------
router.get('/', (req, res) => {
  const plans = prepare(
    'SELECT * FROM content_plans WHERE org_id = ? ORDER BY month DESC, created_at DESC'
  ).all(req.user.orgId);
  res.json(plans.map(presentPlan));
});

// ---- GET /api/plans/:id --------------------------------------------------
router.get('/:id', (req, res) => {
  const full = loadPlanFull(req.params.id, req.user.orgId);
  if (!full) return res.status(404).json({ error: 'Plan not found' });
  res.json(full);
});

// ---- PUT /api/plans/:id --------------------------------------------------
const PLAN_UPDATABLE = ['status', 'auto_publish', 'target_count', 'mode', 'strategy'];
router.put('/:id', (req, res) => {
  const plan = getOwnedPlan(req.params.id, req.user.orgId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const sets = [], vals = [];
  for (const k of PLAN_UPDATABLE) {
    if (k in req.body) {
      sets.push(`${k} = ?`);
      vals.push(k === 'strategy' && req.body[k] != null ? JSON.stringify(req.body[k])
              : k === 'auto_publish' ? (req.body[k] ? 1 : 0)
              : req.body[k]);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'No updatable fields' });
  sets.push("updated_at = datetime('now')");
  vals.push(req.params.id, req.user.orgId);
  prepare(`UPDATE content_plans SET ${sets.join(', ')} WHERE id = ? AND org_id = ?`).run(...vals);
  res.json(loadPlanFull(req.params.id, req.user.orgId));
});

// ---- DELETE /api/plans/:id -----------------------------------------------
router.delete('/:id', (req, res) => {
  const plan = getOwnedPlan(req.params.id, req.user.orgId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  prepare('DELETE FROM content_plans WHERE id = ? AND org_id = ?').run(req.params.id, req.user.orgId);
  res.json({ ok: true });
});

// ---- Item CRUD -----------------------------------------------------------
router.post('/:id/items', (req, res) => {
  const plan = getOwnedPlan(req.params.id, req.user.orgId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  const { scheduled_for, theme, topic_brief, platforms, reasoning } = req.body || {};
  if (!scheduled_for || !topic_brief) return res.status(400).json({ error: 'scheduled_for and topic_brief required' });
  const id = generateId();
  prepare(`
    INSERT INTO content_plan_items
      (id, org_id, plan_id, scheduled_for, theme, topic_brief, platforms, status, reasoning)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?)
  `).run(
    id, req.user.orgId, req.params.id,
    String(scheduled_for),
    String(theme || 'general').slice(0, 80),
    String(topic_brief).slice(0, 1000),
    JSON.stringify(Array.isArray(platforms) ? platforms : ['instagram']),
    String(reasoning || '').slice(0, 400),
  );
  res.status(201).json(presentItem(prepare('SELECT * FROM content_plan_items WHERE id = ? AND org_id = ?').get(id, req.user.orgId)));
});

const ITEM_UPDATABLE = ['scheduled_for', 'theme', 'topic_brief', 'platforms', 'status', 'reasoning'];
router.put('/:id/items/:itemId', (req, res) => {
  const plan = getOwnedPlan(req.params.id, req.user.orgId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const sets = [], vals = [];
  for (const k of ITEM_UPDATABLE) {
    if (k in req.body) {
      sets.push(`${k} = ?`);
      vals.push(k === 'platforms' ? JSON.stringify(req.body[k] || []) : req.body[k]);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'No updatable fields' });
  sets.push("updated_at = datetime('now')");
  vals.push(req.params.itemId, req.params.id, req.user.orgId);
  prepare(`
    UPDATE content_plan_items SET ${sets.join(', ')}
    WHERE id = ? AND plan_id = ? AND org_id = ?
  `).run(...vals);

  const updated = prepare('SELECT * FROM content_plan_items WHERE id = ? AND org_id = ?').get(req.params.itemId, req.user.orgId);
  if (!updated) return res.status(404).json({ error: 'Item not found' });
  res.json(presentItem(updated));
});

// ---- Item actions ---------------------------------------------------------
// Generate content for an item right now (skip the 48h lead window).
router.post('/:id/items/:itemId/generate-now', async (req, res) => {
  try {
    const plan = getOwnedPlan(req.params.id, req.user.orgId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const updated = await generatePlanItemNow(req.params.itemId, req.user.orgId);
    res.json(presentItem(updated));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Approve a generated draft. Sets status=approved so the auto-publisher
// picks it up at scheduled_for. Also stamps posts.scheduled_at so the
// legacy single-post scheduler also knows when to fire.
router.post('/:id/items/:itemId/approve', (req, res) => {
  const plan = getOwnedPlan(req.params.id, req.user.orgId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  const item = prepare('SELECT * FROM content_plan_items WHERE id = ? AND plan_id = ? AND org_id = ?')
    .get(req.params.itemId, req.params.id, req.user.orgId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (!item.post_id) return res.status(400).json({ error: 'No draft to approve — generate it first' });

  prepare("UPDATE posts SET scheduled_at = ? WHERE id = ?").run(item.scheduled_for, item.post_id);
  prepare("UPDATE content_plan_items SET status = 'approved', updated_at = datetime('now') WHERE id = ?")
    .run(req.params.itemId);
  res.json(presentItem(prepare('SELECT * FROM content_plan_items WHERE id = ?').get(req.params.itemId)));
});

// Publish right now (skip waiting for scheduled_for).
router.post('/:id/items/:itemId/publish-now', async (req, res) => {
  try {
    const plan = getOwnedPlan(req.params.id, req.user.orgId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const updated = await publishPlanItemNow(req.params.itemId, req.user.orgId);
    res.json(presentItem(updated));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Skip — mark as won't be produced. The worker will leave it alone.
router.post('/:id/items/:itemId/skip', (req, res) => {
  const plan = getOwnedPlan(req.params.id, req.user.orgId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  prepare(
    "UPDATE content_plan_items SET status = 'skipped', updated_at = datetime('now') WHERE id = ? AND plan_id = ? AND org_id = ?"
  ).run(req.params.itemId, req.params.id, req.user.orgId);
  res.json({ ok: true });
});

router.delete('/:id/items/:itemId', (req, res) => {
  const plan = getOwnedPlan(req.params.id, req.user.orgId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  prepare(
    'DELETE FROM content_plan_items WHERE id = ? AND plan_id = ? AND org_id = ?'
  ).run(req.params.itemId, req.params.id, req.user.orgId);
  res.json({ ok: true });
});

module.exports = router;
