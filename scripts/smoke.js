#!/usr/bin/env node
// P0 smoke test — fast end-to-end sanity check after every deploy.
//
// Run:   node scripts/smoke.js [orgId]
//
// We load .env explicitly because this script is invoked outside the
// systemd unit, so the env vars the main process inherits aren't set
// automatically. The path matches src/app.js.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), override: true });
//
// Exercises the same code paths the HTTP routes use but bypasses session
// auth so we don't need a logged-in cookie. AI-cost paths (Claude lead
// email draft, Flux image gen) are deliberately skipped — those have
// their own UI smoke and would burn API credits on every run.
//
// What gets tested:
//   1. Lead CRM           — create lead, log activity, read back, delete
//   2. Content plan       — create stub plan + item, read back, delete
//   3. Scheduler loader   — loadPendingSchedules() doesn't crash
//   4. Email service      — verify Resend wiring (stub mode if no key)
//
// Anything that *needs* a live platform OAuth (IG/FB publish, TikTok
// upload, YouTube upload) is logged as a "MANUAL VERIFY" line instead —
// running them automatically would publish to real customer accounts.

const crypto = require('crypto');
// (dotenv already loaded at the top of the file)

const TESTS = [];
function test(name, fn) { TESTS.push({ name, fn }); }

const okMark = '\x1b[32m✓\x1b[0m';
const failMark = '\x1b[31m✗\x1b[0m';
const skipMark = '\x1b[33m∼\x1b[0m';

async function main() {
  const { getDb, prepare } = require('../src/config/database');
  await getDb();

  // Pick the org to smoke. Either argv[2] or the oldest org (likely owner).
  const orgArg = process.argv[2];
  const org = orgArg
    ? prepare('SELECT id, name FROM orgs WHERE id = ?').get(orgArg)
    : prepare('SELECT id, name FROM orgs ORDER BY created_at LIMIT 1').get();
  if (!org) {
    console.error('No org found. Provide an org id as the first arg.');
    process.exit(1);
  }
  console.log(`Smoke org: ${org.name} (${org.id})\n`);

  const owner = prepare("SELECT id, email, name FROM users WHERE org_id = ? AND role = 'owner' LIMIT 1").get(org.id);
  if (!owner) {
    console.error('No owner user for org. Aborting.');
    process.exit(1);
  }

  // ---- 1. Lead CRM ----
  test('Lead CRM: create → activity → read → delete', async () => {
    const svc = require('../src/services/leads.service');
    const lead = svc.createLead(org.id, {
      name: 'Smoke Test Lead',
      email: `smoke-${Date.now()}@example.com`,
      phone: '+447700900000',
      source: 'manual',
      notes: 'P0 smoke',
    });
    if (!lead?.id) throw new Error('createLead returned no id');

    const activity = svc.addActivity(org.id, lead.id, owner.id, {
      type: 'note',
      content: 'Smoke note',
    });
    if (!activity?.id) throw new Error('addActivity returned no id');

    const read = svc.getLead(org.id, lead.id);
    if (read?.source !== 'manual') throw new Error(`source mismatch: ${read?.source}`);

    const acts = svc.listActivities(org.id, lead.id);
    if (!acts.some((a) => a.id === activity.id)) throw new Error('activity not in list');

    svc.deleteLead(org.id, lead.id);
    const gone = svc.getLead(org.id, lead.id);
    if (gone) throw new Error('deleteLead failed — lead still queryable');
  });

  // ---- 2. Content plan ----
  test('Content plan: insert plan + item → read → delete', async () => {
    const planId = crypto.randomBytes(10).toString('hex');
    const itemId = crypto.randomBytes(10).toString('hex');
    const monthYM = new Date().toISOString().slice(0, 7); // YYYY-MM
    const whenIso = new Date(Date.now() + 86400000).toISOString(); // tomorrow

    prepare(`
      INSERT INTO content_plans (id, org_id, month, target_count, mode, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(planId, org.id, monthYM, 1, 'quota', 'draft');

    prepare(`
      INSERT INTO content_plan_items (id, org_id, plan_id, scheduled_for, topic_brief, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(itemId, org.id, planId, whenIso, 'Smoke topic', 'planned');

    const plan = prepare('SELECT * FROM content_plans WHERE id = ?').get(planId);
    if (!plan) throw new Error('plan not readable after insert');

    const item = prepare('SELECT * FROM content_plan_items WHERE id = ?').get(itemId);
    if (!item || item.topic_brief !== 'Smoke topic') throw new Error('item not readable');

    prepare('DELETE FROM content_plan_items WHERE id = ?').run(itemId);
    prepare('DELETE FROM content_plans WHERE id = ?').run(planId);
  });

  // ---- 3. Scheduler ----
  test('Scheduler: loadPendingSchedules() runs cleanly', async () => {
    const scheduler = require('../src/services/scheduler.service');
    if (typeof scheduler.loadPendingSchedules !== 'function') {
      throw new Error('scheduler.loadPendingSchedules is not exported');
    }
    // Should never throw even with an empty schedule.
    scheduler.loadPendingSchedules();
  });

  // ---- 4. Email service ----
  test('Email service: configured check + stub send', async () => {
    const email = require('../src/services/email.service');
    const configured = email.isConfigured();
    // Stub path always returns { skipped: true } when RESEND_API_KEY missing.
    // Real path returns Resend's { id, ... } payload — we don't actually
    // send so we won't get there here; we just check the function exists.
    if (typeof email.sendVerificationEmail !== 'function') {
      throw new Error('sendVerificationEmail missing');
    }
    if (typeof email.sendTrialEndingEmail !== 'function') {
      throw new Error('sendTrialEndingEmail missing');
    }
    if (typeof email.sendPaymentFailedEmail !== 'function') {
      throw new Error('sendPaymentFailedEmail missing');
    }
    if (!configured) {
      console.log(`    (RESEND_API_KEY not set — emails will log to stdout)`);
    }
  });

  // ---- 5. Webhook intake (public) ----
  test('Webhook intake: token resolves to an org', async () => {
    const intake = require('../src/services/intake.service');
    const tokenRow = prepare('SELECT intake_token FROM orgs WHERE id = ? AND intake_token IS NOT NULL').get(org.id);
    if (!tokenRow?.intake_token) {
      console.log('    (no intake_token set for this org — skipping)');
      return; // soft pass
    }
    const resolved = intake.getOrgByToken(tokenRow.intake_token);
    if (resolved?.id !== org.id) throw new Error('intake token did not resolve to the right org');
  });

  // Run all tests.
  let passed = 0, failed = 0;
  for (const { name, fn } of TESTS) {
    try {
      await fn();
      console.log(`${okMark} ${name}`);
      passed++;
    } catch (err) {
      console.log(`${failMark} ${name}`);
      console.log(`    ${err.message}`);
      failed++;
    }
  }

  console.log('\nManual smoke (not automated):');
  console.log(`${skipMark} Schedule + publish to IG/FB/LI (needs live OAuth, would post to real customer accounts)`);
  console.log(`${skipMark} AI lead-email draft (Claude/Gemini cost; verify from UI: Leads → drawer → "Draft email")`);
  console.log(`${skipMark} 48h auto-gen of plan items (runs on cron; verify with: SELECT * FROM content_plan_items WHERE status='generated' ORDER BY updated_at DESC LIMIT 5)`);

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Smoke harness crashed:', err);
  process.exit(2);
});
