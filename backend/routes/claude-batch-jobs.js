// ═══════════════════════════════════════════════════════════════════════════
// Batch Job Runner — uses batchClaude for bulk non-urgent work at 50% cost
// ═══════════════════════════════════════════════════════════════════════════
//
// Mount in server.js:
//   const batchJobs = require("./routes/claude-batch-jobs");
//   app.use("/api/ai-employees", batchJobs);
//   batchJobs.migrate();
//
// Call batchJobs.checkJobs() periodically from your cron (every 5-15 min).
// It polls pending batches, records results, and fires completion hooks.
//
// Submit a batch job (from any agent code):
//   const { enqueueBatch } = require("./claude-batch-jobs");
//   await enqueueBatch({
//     userId,
//     jobType: "categorize_transactions",
//     items: txns.map(t => ({
//       custom_id: t.id,
//       system: "You are a bookkeeper. Categorize each transaction.",
//       user: `Transaction: ${t.description}, $${t.amount}`,
//     })),
//     onComplete: "bookkeeper_categorize", // key in HANDLERS below
//   });
// ═══════════════════════════════════════════════════════════════════════════

const express = require("express");
const { v4: uuid } = require("uuid");
const { getDb } = require("../db/init");
const { auth } = require("../middleware/auth");
const { batchClaude } = require("./claude-helper");

const router = express.Router();

// ─── Completion handlers — wire up per job type ────────────────────────────
// When a batch finishes, we call the matching handler with (userId, results).
// Add new handlers here as you build new batch job types.
const HANDLERS = {
  // Example: categorize a pile of transactions
  async bookkeeper_categorize(userId, results) {
    const db = getDb();
    for (const [txnId, result] of Object.entries(results)) {
      if (result.error) continue;
      const category = (result.text || "").trim().split("\n")[0];
      try {
        db.prepare("UPDATE qb_expenses SET category = ? WHERE id = ? AND user_id = ?")
          .run(category, txnId, userId);
      } catch { /* table may not exist — non-critical */ }
    }
  },

  // Example: draft a week of social posts at once
  async social_weekly_draft(userId, results) {
    const db = getDb();
    for (const [slotId, result] of Object.entries(results)) {
      if (result.error) continue;
      try {
        db.prepare(`
          INSERT INTO ai_employee_actions (id, user_id, role, action, details, status, created_at)
          VALUES (?, ?, 'social', 'generate_post', ?, 'pending', datetime('now'))
        `).run(uuid(), userId, JSON.stringify({ slot: slotId, draft: result.text }));
      } catch { /* actions table might not be ready; skip */ }
    }
  },

  // Example: bulk cold email drafting
  async coldemail_drafts(userId, results) {
    const db = getDb();
    for (const [prospectId, result] of Object.entries(results)) {
      if (result.error) continue;
      try {
        db.prepare(`
          INSERT INTO ai_employee_actions (id, user_id, role, action, details, status, created_at)
          VALUES (?, ?, 'coldemail', 'write_email', ?, 'pending', datetime('now'))
        `).run(uuid(), userId, JSON.stringify({ prospect: prospectId, draft: result.text }));
      } catch { /* skip */ }
    }
  },
};

// ─── Public API: enqueue a batch job ───────────────────────────────────────
async function enqueueBatch({ userId, jobType, items, onComplete, model = "claude-haiku-4-5-20251001" }) {
  // Build Anthropic batch requests
  const requests = items.map(item => ({
    custom_id: item.custom_id,
    params: {
      model,
      max_tokens: item.maxTokens || 500,
      system: item.system || "",
      messages: [{ role: "user", content: item.user }],
    },
  }));

  const batchId = await batchClaude.submit(requests);

  getDb().prepare(`
    INSERT INTO ai_batch_jobs (id, batch_id, user_id, job_type, handler, item_count, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'submitted', datetime('now'))
  `).run(uuid(), batchId, userId, jobType, onComplete, items.length);

  return batchId;
}

// ─── Public API: poll all pending batches ──────────────────────────────────
async function checkJobs() {
  const db = getDb();
  const pending = db.prepare(`
    SELECT id, batch_id, user_id, job_type, handler
    FROM ai_batch_jobs
    WHERE status IN ('submitted', 'in_progress')
    ORDER BY created_at ASC LIMIT 20
  `).all();

  let completed = 0;
  for (const job of pending) {
    try {
      const status = await batchClaude.status(job.batch_id);

      if (status.processing_status === "ended") {
        const results = await batchClaude.results(job.batch_id);
        const handler = HANDLERS[job.handler];
        if (handler) {
          await handler(job.user_id, results);
        }
        db.prepare(`
          UPDATE ai_batch_jobs
          SET status = 'completed', completed_at = datetime('now'), result_count = ?
          WHERE id = ?
        `).run(Object.keys(results).length, job.id);
        completed++;
      } else {
        db.prepare("UPDATE ai_batch_jobs SET status = ? WHERE id = ?")
          .run(status.processing_status, job.id);
      }
    } catch (err) {
      db.prepare("UPDATE ai_batch_jobs SET status = 'error', last_error = ? WHERE id = ?")
        .run(String(err).slice(0, 500), job.id);
    }
  }
  return { checked: pending.length, completed };
}

// ─── HTTP endpoints ────────────────────────────────────────────────────────
router.get("/batch-jobs", auth, (req, res) => {
  try {
    const rows = getDb().prepare(`
      SELECT id, batch_id, job_type, status, item_count, result_count, created_at, completed_at, last_error
      FROM ai_batch_jobs WHERE user_id = ?
      ORDER BY created_at DESC LIMIT 50
    `).all(req.userId);
    res.json({ jobs: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/batch-jobs/:id/cancel", auth, async (req, res) => {
  try {
    const db = getDb();
    const job = db.prepare("SELECT batch_id FROM ai_batch_jobs WHERE id = ? AND user_id = ?")
      .get(req.params.id, req.userId);
    if (!job) return res.status(404).json({ error: "not found" });
    await batchClaude.cancel(job.batch_id);
    db.prepare("UPDATE ai_batch_jobs SET status = 'cancelled' WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually trigger batch polling (for testing; normally called from cron)
router.post("/batch-jobs/check", auth, async (req, res) => {
  try {
    const result = await checkJobs();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Migration ─────────────────────────────────────────────────────────────
function migrate() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS ai_batch_jobs (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      job_type TEXT,
      handler TEXT,
      item_count INTEGER,
      result_count INTEGER,
      status TEXT DEFAULT 'submitted',
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_batch_status ON ai_batch_jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_batch_user ON ai_batch_jobs(user_id, created_at);
  `);
}

module.exports = router;
module.exports.migrate = migrate;
module.exports.enqueueBatch = enqueueBatch;
module.exports.checkJobs = checkJobs;
module.exports.HANDLERS = HANDLERS;
