// ─────────────────────────────────────────────────────────────────────────────
// agent-loop.js — closes the AI-employee loop.
//
// MINE already records outcomes (ai_employee_outcomes), can queue retries with
// backoff (queueRetry/processRetries), hand off between agents (handoff), and
// remember contacts (upsertMemory). What was missing is the CONTROLLER that
// observes an outcome and decides the next step. This is that controller — the
// "act → observe → evaluate → retry/handoff/learn/escalate" edge.
//
// It does NOT bypass the send path. A "retry" decision enqueues into the existing
// ai_retry_queue; the actual re-send fires when processRetries() is given an
// executor (the one human-gated step — see WIRING note at the bottom).
//
//   server.js:  app.use("/api/agent-loop", require("./routes/agent-loop"));
//               setInterval(() => require("./routes/agent-loop").runLoopTick(getDb()).catch(()=>{}), 5*60*1000);
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const uid = () => crypto.randomUUID();

const { getDb } = require("../db/init");
let enh = {};
try { enh = require("./ai-employees-enhancements"); } catch (_) {}
const queueRetry = enh.queueRetry || function () {};
const handoff = enh.handoff || function () { return null; };
const upsertMemory = enh.upsertMemory || function () {};

// ── Tunables / guardrails ────────────────────────────────────────────────────
const MAX_ATTEMPTS = 3;            // hard cap on auto-retries per action
const WAIT_WINDOW_MIN = 2880;      // treat "no_response" as actionable after 48h
const COOLDOWN_MIN = 15;           // min gap between loop touches of one action

// Cross-agent handoff fallbacks. If a role isn't here, we escalate to the owner
// instead of inventing a target.
const HANDOFF_FALLBACK = {
  sales: "support", support: "sales", marketing: "content", content: "marketing",
  bookkeeper: "support", outreach: "sales",
};

// Map the stored autonomy value to a mode (mirrors ai-employees.js getAutonomyMode).
function autonomyMode(raw) {
  const a = String(raw || "semi").toLowerCase();
  if (a === "manual" || a === "review") return "manual";
  if (a === "suggest" || a === "semi") return "suggest";
  return "auto"; // 'full' | 'auto'
}

// ── PURE decision engine (unit-tested) ───────────────────────────────────────
// state: { outcome, attempts, maxAttempts, waitedMin, waitWindowMin, autonomy }
// returns { step, reason }  step ∈ done|learn|retry|handoff|escalate|wait
function decideLoopStep(state) {
  const { outcome } = state;
  const attempts = state.attempts || 0;
  const maxAttempts = state.maxAttempts || MAX_ATTEMPTS;
  const waitedMin = state.waitedMin || 0;
  const waitWindowMin = state.waitWindowMin || WAIT_WINDOW_MIN;
  const mode = state.autonomy || "suggest";

  if (outcome === "success") return { step: "done", reason: "succeeded" };
  if (outcome === "user_rejected") return { step: "done", reason: "owner rejected — not retrying" };
  if (outcome === "user_corrected") return { step: "learn", reason: "owner corrected — remember it" };

  // At/over the cap → stop retrying. Auto hands off; otherwise the owner takes over.
  function atCap() { return mode === "auto" ? { step: "handoff", reason: "retries exhausted — handing off" } : { step: "escalate", reason: "retries exhausted — needs owner" }; }

  if (outcome === "failed") {
    if (attempts >= maxAttempts) return atCap();
    if (mode === "manual") return { step: "escalate", reason: "manual mode — owner approves retry" };
    return { step: "retry", reason: "failed — retrying" };
  }

  if (outcome === "no_response") {
    if (waitedMin < waitWindowMin) return { step: "wait", reason: "still inside the wait window" };
    if (attempts >= maxAttempts) return atCap();
    if (mode === "manual") return { step: "escalate", reason: "manual mode — owner approves follow-up" };
    return { step: "retry", reason: "no reply past window — following up" };
  }

  return { step: "wait", reason: "no actionable outcome yet" };
}

// ── Tables ────────────────────────────────────────────────────────────────────
let _ready = false;
function ensureTables(db) {
  if (_ready) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_loop_state (
      action_id       TEXT PRIMARY KEY,
      user_id         TEXT,
      role            TEXT,
      attempts        INTEGER DEFAULT 0,
      last_step       TEXT,
      last_outcome    TEXT,
      next_eligible_at TEXT,
      resolved        INTEGER DEFAULT 0,
      updated_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_loopstate_open ON agent_loop_state(resolved, next_eligible_at);
  `);
  _ready = true;
}

function parseTs(s) {
  if (!s) return NaN;
  s = String(s).trim();
  return s.includes("T") ? Date.parse(s) : Date.parse(s.replace(" ", "T") + "Z");
}
function minutesSince(iso) {
  const t = parseTs(iso);
  if (isNaN(t)) return 0;
  return Math.max(0, (Date.now() - t) / 60000);
}

// ── The tick: observe outcomes → decide → drive the existing primitives ───────
function runLoopTick(db, opts) {
  db = db || getDb();
  ensureTables(db);
  const o = opts || {};
  const maxAttempts = o.maxAttempts || MAX_ATTEMPTS;
  const waitWindowMin = o.waitWindowMin || WAIT_WINDOW_MIN;
  const cooldownMin = o.cooldownMin || COOLDOWN_MIN;
  const summary = { scanned: 0, retried: 0, handed_off: 0, escalated: 0, learned: 0, done: 0, waited: 0 };

  // Latest outcome per action in the last 30 days.
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT o.action_id, o.user_id, o.role, o.action_type, o.outcome, o.outcome_data,
             MAX(o.created_at) AS outcome_at
      FROM ai_employee_outcomes o
      WHERE o.created_at >= datetime('now','-30 days')
      GROUP BY o.action_id
    `).all();
  } catch (_) { return summary; }

  const getState = db.prepare("SELECT attempts, resolved, next_eligible_at FROM agent_loop_state WHERE action_id=?");
  const upsertState = db.prepare(`
    INSERT INTO agent_loop_state (action_id, user_id, role, attempts, last_step, last_outcome, next_eligible_at, resolved, updated_at)
    VALUES (?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(action_id) DO UPDATE SET attempts=excluded.attempts, last_step=excluded.last_step,
      last_outcome=excluded.last_outcome, next_eligible_at=excluded.next_eligible_at, resolved=excluded.resolved, updated_at=datetime('now')
  `);
  const notify = db.prepare("INSERT INTO user_notifications (id, user_id, type, severity, title, body, action_url, action_label) VALUES (?,?,?,?,?,?,?,?)");

  for (const r of rows) {
    const st = getState.get(r.action_id) || { attempts: 0, resolved: 0, next_eligible_at: null };
    if (st.resolved) continue;
    if (st.next_eligible_at) { const ne = parseTs(st.next_eligible_at); if (!isNaN(ne) && ne > Date.now()) continue; }
    summary.scanned++;

    let autonomy = "suggest";
    try {
      const emp = db.prepare("SELECT autonomy FROM ai_employees WHERE user_id=? AND role=?").get(r.user_id, r.role);
      autonomy = autonomyMode(emp && emp.autonomy);
    } catch (_) {}

    const decision = decideLoopStep({
      outcome: r.outcome, attempts: st.attempts || 0, maxAttempts,
      waitedMin: minutesSince(r.outcome_at), waitWindowMin, autonomy,
    });

    const nextEligible = new Date(Date.now() + cooldownMin * 60000).toISOString();
    let data = {}; try { data = JSON.parse(r.outcome_data || "{}"); } catch (_) {}

    switch (decision.step) {
      case "done":
        upsertState.run(r.action_id, r.user_id, r.role, st.attempts || 0, "done", r.outcome, nextEligible, 1);
        summary.done++; break;

      case "learn":
        try {
          if (data.contact_email) upsertMemory(r.user_id, r.role, data.contact_email, { newFacts: [data.correction || "owner corrected a prior action"] });
        } catch (_) {}
        upsertState.run(r.action_id, r.user_id, r.role, st.attempts || 0, "learn", r.outcome, nextEligible, 1);
        summary.learned++; break;

      case "retry":
        try { queueRetry(r.action_id, r.user_id, r.role, r.action_type || "follow_up", { reason: decision.reason, attempt: (st.attempts || 0) + 1, source_outcome: r.outcome }, "agent-loop:" + r.outcome); } catch (_) {}
        upsertState.run(r.action_id, r.user_id, r.role, (st.attempts || 0) + 1, "retry", r.outcome, nextEligible, 0);
        summary.retried++; break;

      case "handoff": {
        const to = HANDOFF_FALLBACK[String(r.role || "").toLowerCase()];
        if (to) { try { handoff(r.user_id, r.role, to, "loop_exhausted", { action_id: r.action_id, outcome: r.outcome }); } catch (_) {} summary.handed_off++; }
        else { try { notify.run(uid(), r.user_id, "agent_loop", "warning", "An employee needs you", `${r.role}: action stuck after ${st.attempts || 0} tries`, "#ai-employees", "Review"); } catch (_) {} summary.escalated++; }
        upsertState.run(r.action_id, r.user_id, r.role, st.attempts || 0, to ? "handoff" : "escalate", r.outcome, nextEligible, 1);
        break;
      }

      case "escalate":
        try { notify.run(uid(), r.user_id, "agent_loop", "warning", "An employee needs you", `${r.role}: ${decision.reason}`, "#ai-employees", "Review"); } catch (_) {}
        upsertState.run(r.action_id, r.user_id, r.role, st.attempts || 0, "escalate", r.outcome, nextEligible, 1);
        summary.escalated++; break;

      default: // wait
        upsertState.run(r.action_id, r.user_id, r.role, st.attempts || 0, "wait", r.outcome, nextEligible, 0);
        summary.waited++;
    }
  }
  return summary;
}

// ── Routes ────────────────────────────────────────────────────────────────────
// Internal/cron trigger (no user auth — guarded by CRON_SECRET or INTERNAL_API_KEY).
router.post("/tick", (req, res) => {
  const secret = req.headers["x-cron-secret"] || req.headers["x-internal-key"] || (req.body && req.body.secret);
  const expected = process.env.CRON_SECRET || process.env.INTERNAL_API_KEY;
  if (expected && secret !== expected) return res.status(401).json({ ok: false, error: "unauthorized" });
  try { res.json({ ok: true, summary: runLoopTick(getDb(), req.body || {}) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Per-user view of what the loop is doing.
let _authMw; try { _authMw = require("../middleware/auth").auth; } catch (_) { _authMw = (req, _r, n) => n(); }
router.get("/status", _authMw, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const rows = db.prepare("SELECT action_id, role, attempts, last_step, last_outcome, resolved, updated_at FROM agent_loop_state WHERE user_id=? ORDER BY updated_at DESC LIMIT 100").all(req.userId);
    const open = rows.filter((r) => !r.resolved).length;
    res.json({ ok: true, open, items: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
module.exports.decideLoopStep = decideLoopStep;
module.exports.runLoopTick = runLoopTick;
module.exports.autonomyMode = autonomyMode;

// ── WIRING NOTE — the one human-gated step ───────────────────────────────────
// The controller enqueues retries into ai_retry_queue. To actually RE-SEND, give
// the existing processRetries() an executor that re-runs the action through the
// normal send path (which keeps baseline-enforcement / approval intact), e.g.:
//
//   const { processRetries } = require("./ai-employees-enhancements");
//   setInterval(() => processRetries(async (job) => {
//     // re-dispatch job.action_id through the existing employee send entrypoint
//   }), 60_000);
//
// Left unwired on purpose: auto re-sending can't be verified without the live
// send path + ANTHROPIC/Twilio/SendGrid keys. Decision logic is fully tested.
