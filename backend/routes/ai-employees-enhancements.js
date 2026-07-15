// ═══════════════════════════════════════════════════════════════════════════
// AI Employees — Enhancement Layer
// ═══════════════════════════════════════════════════════════════════════════
// Adds 5 capabilities to the existing AI employee system:
//   1. Outcome tracking — know which actions actually worked
//   2. Persistent contact memory — agents remember past interactions
//   3. Cross-agent handoffs — Sales → Bookkeeper on deal close, etc.
//   4. Retry queue — failed actions get retried with backoff
//   5. Approval SLA — nudge user about stale pending approvals
//
// Mount in server.js:
//   app.use('/api/ai-employees', require('./routes/ai-employees-enhancements'));
//
// Run this migration once at boot — it creates the required tables:
//   require('./routes/ai-employees-enhancements').migrate();
// ═══════════════════════════════════════════════════════════════════════════

const express = require("express");
const { v4: uuid } = require("uuid");
const { getDb } = require("../db/init");
const { auth } = require("../middleware/auth");

const router = express.Router();

// ─── Migration: create all enhancement tables ──────────────────────────────
function migrate() {
  const db = getDb();
  db.exec(`
    -- 1. OUTCOME TRACKING
    -- Every agent action gets an outcome row. Linked to ai_employee_actions.
    CREATE TABLE IF NOT EXISTS ai_employee_outcomes (
      id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      action_type TEXT,
      outcome TEXT,                -- 'success' | 'failed' | 'no_response' | 'user_corrected' | 'user_rejected'
      outcome_data TEXT,           -- JSON: e.g. {reply_received: true, conversion_value: 297}
      user_feedback TEXT,          -- optional 1-5 star rating + note from user
      measured_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_outcomes_action ON ai_employee_outcomes(action_id);
    CREATE INDEX IF NOT EXISTS idx_outcomes_user_role ON ai_employee_outcomes(user_id, role, outcome);

    -- 2. PERSISTENT CONTACT MEMORY
    -- One row per (agent, contact) pair. Agents can read/write context before every action.
    CREATE TABLE IF NOT EXISTS ai_contact_memory (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      contact_id TEXT,              -- links to contacts.id (nullable for anonymous)
      contact_email TEXT,           -- fallback identifier
      role TEXT NOT NULL,           -- which agent wrote this memory
      summary TEXT,                 -- short paragraph: "Sarah runs a yoga studio, asked about retreats, prefers morning classes"
      facts TEXT DEFAULT '[]',      -- JSON array of bullet facts: ["asked about retreats", "VIP tier", "prefers SMS"]
      preferences TEXT DEFAULT '{}', -- JSON: {channel: 'sms', tone: 'warm', timezone: 'Australia/Brisbane'}
      last_interaction TEXT,        -- ISO timestamp
      interaction_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, role, contact_email)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_lookup ON ai_contact_memory(user_id, contact_email);
    CREATE INDEX IF NOT EXISTS idx_memory_role ON ai_contact_memory(user_id, role, updated_at);

    -- 3. CROSS-AGENT HANDOFFS
    -- When one agent triggers work for another. Logged + visible in UI.
    CREATE TABLE IF NOT EXISTS ai_handoffs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      from_role TEXT,               -- 'sales'
      to_role TEXT NOT NULL,        -- 'bookkeeper'
      trigger TEXT,                 -- 'deal_closed' | 'vip_complaint' | 'manual'
      context TEXT,                 -- JSON: {deal_id, contact_id, reason: "Close — $4800 one-off"}
      status TEXT DEFAULT 'pending',-- 'pending' | 'acknowledged' | 'completed' | 'dropped'
      action_id TEXT,               -- the resulting ai_employee_actions row (when created)
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_handoffs_pending ON ai_handoffs(user_id, status, created_at);

    -- 4. RETRY QUEUE
    -- Failed actions get parked here and retried with exponential backoff.
    CREATE TABLE IF NOT EXISTS ai_retry_queue (
      id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT,
      action_type TEXT,
      payload TEXT,                 -- JSON original action details
      attempts INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 5,
      last_error TEXT,
      next_retry_at TEXT,           -- when to retry next (exponential)
      status TEXT DEFAULT 'pending',-- 'pending' | 'exhausted' | 'succeeded' | 'cancelled'
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_retry_due ON ai_retry_queue(status, next_retry_at);

    -- 5. APPROVAL SLA / NUDGES
    -- Tracks when we last nudged the user about a pending action.
    CREATE TABLE IF NOT EXISTS ai_approval_nudges (
      id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      first_nudge_at TEXT,
      last_nudge_at TEXT,
      nudge_count INTEGER DEFAULT 0,
      dismissed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_nudges_user ON ai_approval_nudges(user_id, dismissed);
  `);
// Change 9: schema-drift ALTERs for ai_retry_queue
try { db.exec("ALTER TABLE ai_retry_queue ADD COLUMN attempts INTEGER DEFAULT 0"); } catch(_){}
// Change 9: schema-drift ALTERs for ai_employee_outcomes
try { db.exec("ALTER TABLE ai_employee_outcomes ADD COLUMN outcome_data TEXT"); } catch(_){}
try { db.exec("ALTER TABLE ai_employee_outcomes ADD COLUMN user_feedback TEXT"); } catch(_){}
  console.log("[ai-employees-enhancements] tables ready");
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. OUTCOME TRACKING
// ═══════════════════════════════════════════════════════════════════════════

// Called internally by action handlers after the action completes.
// Example: recordOutcome(actionId, userId, 'sales', 'send_followup_email', 'success', { replied: true });
function recordOutcome(actionId, userId, role, actionType, outcome, data = {}) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO ai_employee_outcomes (id, action_id, user_id, role, action_type, outcome, outcome_data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uuid(), actionId, userId, role, actionType, outcome, JSON.stringify(data));
  } catch (err) {
    console.error("[outcome] failed to record:", err.message);
  }
}

// Upgrade/finalize an outcome when a LATER signal arrives (email opened, proposal
// signed, etc). Matches the most recent row for this action_id + role. No-op if none.
function updateOutcome(actionId, role, outcome, dataPatch = {}) {
  try {
    const db = getDb();
    const row = db.prepare(
      "SELECT id, outcome_data FROM ai_employee_outcomes WHERE action_id = ? AND role = ? ORDER BY created_at DESC LIMIT 1"
    ).get(actionId, role);
    if (!row) return;
    let merged;
    try { merged = Object.assign(JSON.parse(row.outcome_data || "{}"), dataPatch || {}); }
    catch (_) { merged = dataPatch || {}; }
    db.prepare("UPDATE ai_employee_outcomes SET outcome = ?, outcome_data = ? WHERE id = ?")
      .run(outcome, JSON.stringify(merged), row.id);
  } catch (err) {
    console.error("[outcome] failed to update:", err.message);
  }
}

// GET /api/ai-employees/outcomes/stats — agent scorecard
router.get("/outcomes/stats", auth, (req, res) => {
  try {
    const db = getDb();
    const days = parseInt(req.query.days) || 30;
    const rows = db.prepare(`
      SELECT role,
             action_type,
             COUNT(*) as total,
             SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as succeeded,
             SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) as failed,
             SUM(CASE WHEN outcome = 'no_response' THEN 1 ELSE 0 END) as no_response,
             SUM(CASE WHEN outcome = 'user_corrected' THEN 1 ELSE 0 END) as corrected,
             SUM(CASE WHEN outcome = 'user_rejected' THEN 1 ELSE 0 END) as rejected
      FROM ai_employee_outcomes
      WHERE user_id = ? AND created_at > datetime('now', '-' || ? || ' days')
      GROUP BY role, action_type
      ORDER BY role, total DESC
    `).all(req.userId, days);

    // Roll up to per-role success rate
    const byRole = {};
    for (const r of rows) {
      if (!byRole[r.role]) byRole[r.role] = { total: 0, succeeded: 0, actions: [] };
      byRole[r.role].total += r.total;
      byRole[r.role].succeeded += r.succeeded;
      byRole[r.role].actions.push(r);
    }
    for (const role in byRole) {
      byRole[role].success_rate = byRole[role].total > 0
        ? Math.round((byRole[role].succeeded / byRole[role].total) * 100)
        : null;
    }
    res.json({ days, by_role: byRole, details: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai-employees/outcomes/:actionId/feedback — user rates an action
router.post("/outcomes/:actionId/feedback", auth, (req, res) => {
  try {
    const { rating, note } = req.body; // rating 1-5
    const db = getDb();
    const outcome = db.prepare("SELECT * FROM ai_employee_outcomes WHERE action_id = ?").get(req.params.actionId);
    if (!outcome) return res.status(404).json({ error: "outcome not found" });
    db.prepare("UPDATE ai_employee_outcomes SET user_feedback = ? WHERE id = ?")
      .run(JSON.stringify({ rating, note, at: new Date().toISOString() }), outcome.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. PERSISTENT CONTACT MEMORY
// ═══════════════════════════════════════════════════════════════════════════

// Called by agents before acting on a contact. Returns memory or null.
function getMemory(userId, role, contactEmail) {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT summary, facts, preferences, last_interaction, interaction_count
      FROM ai_contact_memory
      WHERE user_id = ? AND role = ? AND contact_email = ?
    `).get(userId, role, contactEmail?.toLowerCase());
    if (!row) return null;
    return {
      summary: row.summary,
      facts: JSON.parse(row.facts || "[]"),
      preferences: JSON.parse(row.preferences || "{}"),
      last_interaction: row.last_interaction,
      interaction_count: row.interaction_count,
    };
  } catch { return null; }
}

// Called by agents after acting. Updates memory with new facts.
// Example:  upsertMemory(userId, 'sales', 'sarah@example.com', {
//   summary: "Asked about retreats, runs yoga studio",
//   newFacts: ["interested in Byron Bay retreat"],
//   preferences: { channel: 'sms' }
// });
function upsertMemory(userId, role, contactEmail, { summary, newFacts = [], preferences = {} }) {
  try {
    const db = getDb();
    const email = contactEmail?.toLowerCase();
    const existing = db.prepare(`
      SELECT id, facts, preferences FROM ai_contact_memory
      WHERE user_id = ? AND role = ? AND contact_email = ?
    `).get(userId, role, email);

    if (existing) {
      // Merge facts (dedupe) + preferences
      const oldFacts = JSON.parse(existing.facts || "[]");
      const mergedFacts = Array.from(new Set([...oldFacts, ...newFacts])).slice(-50); // cap at 50
      const mergedPrefs = { ...JSON.parse(existing.preferences || "{}"), ...preferences };
      db.prepare(`
        UPDATE ai_contact_memory
        SET summary = COALESCE(?, summary),
            facts = ?,
            preferences = ?,
            last_interaction = datetime('now'),
            interaction_count = interaction_count + 1,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(summary, JSON.stringify(mergedFacts), JSON.stringify(mergedPrefs), existing.id);
    } else {
      db.prepare(`
        INSERT INTO ai_contact_memory (id, user_id, contact_email, role, summary, facts, preferences, last_interaction, interaction_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), 1)
      `).run(uuid(), userId, email, role, summary || "", JSON.stringify(newFacts), JSON.stringify(preferences));
    }
  } catch (err) {
    console.error("[memory] upsert failed:", err.message);
  }
}

// GET /api/ai-employees/memory/:email — what does any agent know about this person?
router.get("/memory/:email", auth, (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT role, summary, facts, preferences, last_interaction, interaction_count
      FROM ai_contact_memory
      WHERE user_id = ? AND contact_email = ?
      ORDER BY updated_at DESC
    `).all(req.userId, req.params.email.toLowerCase());
    rows.forEach(r => {
      r.facts = JSON.parse(r.facts || "[]");
      r.preferences = JSON.parse(r.preferences || "{}");
    });
    res.json({ email: req.params.email, memories: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/ai-employees/memory/:email — forget this person (GDPR/privacy)
router.delete("/memory/:email", auth, (req, res) => {
  try {
    getDb().prepare("DELETE FROM ai_contact_memory WHERE user_id = ? AND contact_email = ?")
      .run(req.userId, req.params.email.toLowerCase());
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. CROSS-AGENT HANDOFFS
// ═══════════════════════════════════════════════════════════════════════════

// Called by one agent to trigger another.
// Example: handoff(userId, 'sales', 'bookkeeper', 'deal_closed', { dealId, amount: 4800 });
function handoff(userId, fromRole, toRole, trigger, context = {}) {
  try {
    const db = getDb();
    const id = uuid();
    db.prepare(`
      INSERT INTO ai_handoffs (id, user_id, from_role, to_role, trigger, context)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, userId, fromRole, toRole, trigger, JSON.stringify(context));
    return id;
  } catch (err) {
    console.error("[handoff] failed:", err.message);
    return null;
  }
}

// GET /api/ai-employees/handoffs — view recent handoffs
router.get("/handoffs", auth, (req, res) => {
  try {
    const rows = getDb().prepare(`
      SELECT id, from_role, to_role, trigger, context, status, created_at, completed_at
      FROM ai_handoffs
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 50
    `).all(req.userId);
    rows.forEach(r => { try { r.context = JSON.parse(r.context || "{}"); } catch {} });
    res.json({ handoffs: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai-employees/handoffs/:id/complete — mark handoff as done
router.post("/handoffs/:id/complete", auth, (req, res) => {
  try {
    getDb().prepare(`
      UPDATE ai_handoffs SET status = 'completed', completed_at = datetime('now'), action_id = ?
      WHERE id = ? AND user_id = ?
    `).run(req.body.action_id || null, req.params.id, req.userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. RETRY QUEUE
// ═══════════════════════════════════════════════════════════════════════════

// Called by action handlers when an action fails.
// Example: queueRetry(actionId, userId, 'sales', 'send_followup_email', {to: 'sarah@...', body: '...'}, err);
function queueRetry(actionId, userId, role, actionType, payload, error) {
  try {
    const db = getDb();
    const nextAt = new Date(Date.now() + 60_000).toISOString(); // first retry in 1 min
    db.prepare(`
      INSERT INTO ai_retry_queue (id, action_id, user_id, role, action_type, payload, last_error, next_retry_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uuid(), actionId, userId, role, actionType, JSON.stringify(payload), String(error).slice(0, 500), nextAt);
  } catch (err) {
    console.error("[retry] queue failed:", err.message);
  }
}

// Processor — call this from your cron endpoint (every 1-5 min).
// Example: setInterval(processRetries, 60_000);
async function processRetries(executor) {
  try {
    const db = getDb();
    const due = db.prepare(`
      SELECT * FROM ai_retry_queue
      WHERE status = 'pending' AND next_retry_at <= datetime('now')
      ORDER BY next_retry_at ASC LIMIT 20
    `).all();

    for (const item of due) {
      try {
        // executor is the function that actually re-runs the action.
        // Wire it in from ai-employees.js:  processRetries(myActionExecutor)
        await executor({
          actionId: item.action_id, userId: item.user_id,
          role: item.role, actionType: item.action_type,
          payload: JSON.parse(item.payload || "{}"),
        });
        db.prepare("UPDATE ai_retry_queue SET status='succeeded', completed_at=datetime('now') WHERE id=?").run(item.id);
      } catch (err) {
        const nextAttempts = item.attempts + 1;
        if (nextAttempts >= item.max_attempts) {
          db.prepare("UPDATE ai_retry_queue SET status='exhausted', attempts=?, last_error=?, completed_at=datetime('now') WHERE id=?")
            .run(nextAttempts, String(err).slice(0, 500), item.id);
        } else {
          // Exponential backoff: 1min, 5min, 25min, 2h, 10h
          const backoffMs = 60_000 * Math.pow(5, nextAttempts);
          const nextAt = new Date(Date.now() + backoffMs).toISOString();
          db.prepare("UPDATE ai_retry_queue SET attempts=?, last_error=?, next_retry_at=? WHERE id=?")
            .run(nextAttempts, String(err).slice(0, 500), nextAt, item.id);
        }
      }
    }
    return { processed: due.length };
  } catch (err) {
    console.error("[retry] processor error:", err.message);
    return { processed: 0, error: err.message };
  }
}

// GET /api/ai-employees/retries — inspect the queue
router.get("/retries", auth, (req, res) => {
  try {
    const rows = getDb().prepare(`
      SELECT id, action_id, role, action_type, attempts, max_attempts, last_error, next_retry_at, status, created_at
      FROM ai_retry_queue WHERE user_id = ?
      ORDER BY created_at DESC LIMIT 100
    `).all(req.userId);
    res.json({ queue: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai-employees/retries/:id/cancel — give up on a stuck retry
router.post("/retries/:id/cancel", auth, (req, res) => {
  try {
    getDb().prepare("UPDATE ai_retry_queue SET status='cancelled', completed_at=datetime('now') WHERE id=? AND user_id=?")
      .run(req.params.id, req.userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. APPROVAL SLA / NUDGES
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/ai-employees/approvals/stale — pending actions older than N hours
router.get("/approvals/stale", auth, (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const rows = getDb().prepare(`
      SELECT a.id, a.role, a.action, a.details, a.created_at,
             COALESCE(n.nudge_count, 0) as nudge_count,
             n.last_nudge_at
      FROM ai_employee_actions a
      LEFT JOIN ai_approval_nudges n ON a.id = n.action_id
      WHERE a.user_id = ?
        AND a.status = 'pending'
        AND a.created_at < datetime('now', '-' || ? || ' hours')
        AND (n.dismissed IS NULL OR n.dismissed = 0)
      ORDER BY a.created_at ASC
      LIMIT 50
    `).all(req.userId, hours);
    res.json({ count: rows.length, stale: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai-employees/approvals/:id/nudge — mark a nudge as sent
router.post("/approvals/:id/nudge", auth, (req, res) => {
  try {
    const db = getDb();
    const existing = db.prepare("SELECT id, nudge_count FROM ai_approval_nudges WHERE action_id = ?").get(req.params.id);
    if (existing) {
      db.prepare(`
        UPDATE ai_approval_nudges
        SET last_nudge_at = datetime('now'), nudge_count = nudge_count + 1
        WHERE id = ?
      `).run(existing.id);
    } else {
      db.prepare(`
        INSERT INTO ai_approval_nudges (id, action_id, user_id, first_nudge_at, last_nudge_at, nudge_count)
        VALUES (?, ?, ?, datetime('now'), datetime('now'), 1)
      `).run(uuid(), req.params.id, req.userId);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai-employees/approvals/:id/dismiss-nudge — user said "stop bugging me"
router.post("/approvals/:id/dismiss-nudge", auth, (req, res) => {
  try {
    getDb().prepare(`
      INSERT INTO ai_approval_nudges (id, action_id, user_id, dismissed)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(action_id) DO UPDATE SET dismissed = 1
    `).run(uuid(), req.params.id, req.userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.migrate = migrate;
module.exports.recordOutcome = recordOutcome;
module.exports.updateOutcome = updateOutcome;
module.exports.getMemory = getMemory;
module.exports.upsertMemory = upsertMemory;
module.exports.handoff = handoff;
module.exports.queueRetry = queueRetry;
module.exports.processRetries = processRetries;
