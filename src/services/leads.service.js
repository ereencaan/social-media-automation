// Leads / CRM service. All queries are scoped by orgId — callers MUST pass
// the orgId of the authenticated user (not accept it from the client).
const { prepare } = require('../config/database');
const { generateId } = require('../utils/helpers');

const VALID_STATUS = new Set(['new', 'contacted', 'qualified', 'won', 'lost']);
const VALID_ACTIVITY_TYPES = new Set([
  'note', 'email', 'call', 'message', 'status_change', 'stage_change', 'assignment',
]);

function normalizeEmail(e) {
  return e ? String(e).trim().toLowerCase() : null;
}

function rowToLead(row) {
  if (!row) return null;
  return { ...row };
}

// ---- leads --------------------------------------------------------------
function createLead(orgId, input = {}) {
  if (!orgId) throw new Error('orgId required');
  const {
    source = null, sourceRef = null,
    name = null, email = null, phone = null,
    status = 'new', stage = null, assignedTo = null, notes = null,
  } = input;

  if (!VALID_STATUS.has(status)) throw new Error(`Invalid status: ${status}`);
  if (!name && !email && !phone) {
    throw new Error('At least one of name, email, phone is required');
  }

  // If a lead with the same (org, source, sourceRef) already exists, return it
  // instead of creating a duplicate. This makes webhook intake idempotent.
  if (source && sourceRef) {
    const existing = prepare(
      'SELECT * FROM leads WHERE org_id = ? AND source = ? AND source_ref = ?'
    ).get(orgId, source, sourceRef);
    if (existing) return rowToLead(existing);
  }

  const id = generateId();
  prepare(`
    INSERT INTO leads (id, org_id, source, source_ref, name, email, phone, status, stage, assigned_to, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, orgId, source, sourceRef, name, normalizeEmail(email), phone, status, stage, assignedTo, notes);

  return rowToLead(prepare('SELECT * FROM leads WHERE id = ? AND org_id = ?').get(id, orgId));
}

function listLeads(orgId, { status, limit = 100, offset = 0 } = {}) {
  if (!orgId) throw new Error('orgId required');
  // Clamp pagination to sensible bounds
  const lim = Math.max(1, Math.min(Number(limit) || 100, 500));
  const off = Math.max(0, Number(offset) || 0);

  if (status) {
    if (!VALID_STATUS.has(status)) throw new Error(`Invalid status: ${status}`);
    return prepare(
      'SELECT * FROM leads WHERE org_id = ? AND status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(orgId, status, lim, off);
  }
  return prepare(
    'SELECT * FROM leads WHERE org_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(orgId, lim, off);
}

function getLead(orgId, leadId) {
  if (!orgId || !leadId) return null;
  return rowToLead(
    prepare('SELECT * FROM leads WHERE id = ? AND org_id = ?').get(leadId, orgId)
  );
}

// Update only allowed fields — never let callers set org_id/id via the body.
const UPDATABLE = ['name', 'email', 'phone', 'status', 'stage', 'assigned_to', 'notes', 'source', 'source_ref'];
function updateLead(orgId, leadId, patch = {}) {
  const existing = getLead(orgId, leadId);
  if (!existing) return null;

  // Map camelCase -> snake_case for the two-word fields we accept
  const mapped = { ...patch };
  if ('assignedTo' in mapped) { mapped.assigned_to = mapped.assignedTo; delete mapped.assignedTo; }
  if ('sourceRef' in mapped) { mapped.source_ref = mapped.sourceRef; delete mapped.sourceRef; }
  if ('email' in mapped) mapped.email = normalizeEmail(mapped.email);

  const sets = [];
  const vals = [];
  for (const key of UPDATABLE) {
    if (key in mapped) {
      if (key === 'status' && mapped[key] && !VALID_STATUS.has(mapped[key])) {
        throw new Error(`Invalid status: ${mapped[key]}`);
      }
      sets.push(`${key} = ?`);
      vals.push(mapped[key]);
    }
  }
  if (!sets.length) return existing;

  sets.push(`updated_at = datetime('now')`);
  vals.push(leadId, orgId);

  prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ? AND org_id = ?`).run(...vals);

  const updated = getLead(orgId, leadId);

  // If status changed, log an activity row
  if ('status' in mapped && mapped.status !== existing.status) {
    addActivity(orgId, leadId, null, {
      type: 'status_change',
      content: `${existing.status} -> ${mapped.status}`,
    });
  }
  return updated;
}

function deleteLead(orgId, leadId) {
  const existing = getLead(orgId, leadId);
  if (!existing) return false;
  prepare('DELETE FROM leads WHERE id = ? AND org_id = ?').run(leadId, orgId);
  return true;
}

// ---- activities ---------------------------------------------------------
function addActivity(orgId, leadId, userId, { type, content = null, metadata = null }) {
  if (!orgId || !leadId) throw new Error('orgId and leadId required');
  if (!type || !VALID_ACTIVITY_TYPES.has(type)) throw new Error(`Invalid activity type: ${type}`);
  // Make sure the lead belongs to this org before writing an activity
  const lead = getLead(orgId, leadId);
  if (!lead) return null;

  const id = generateId();
  const metaStr = metadata == null ? null : JSON.stringify(metadata);
  prepare(`
    INSERT INTO lead_activities (id, org_id, lead_id, user_id, type, content, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, orgId, leadId, userId || null, type, content, metaStr);

  return prepare('SELECT * FROM lead_activities WHERE id = ? AND org_id = ?').get(id, orgId);
}

function listActivities(orgId, leadId) {
  const lead = getLead(orgId, leadId);
  if (!lead) return null;
  return prepare(
    'SELECT * FROM lead_activities WHERE org_id = ? AND lead_id = ? ORDER BY created_at DESC'
  ).all(orgId, leadId);
}

module.exports = {
  createLead, listLeads, getLead, updateLead, deleteLead,
  addActivity, listActivities,
  VALID_STATUS, VALID_ACTIVITY_TYPES,
};
