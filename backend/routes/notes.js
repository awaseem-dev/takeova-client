// ─────────────────────────────────────────────────────────────────────────────
// notes.js — smart-notes spine for the mine-live dashboard.
//
// Owner brain-dumps (typed or voice-transcribed) → Claude parses into structured
// items → each item is DISPATCHED into the real subsystem on the way in → the hub
// shows what was captured and where it went.
//
//   #1 dispatch · #3 voice · #4 ask · plus the store #2 (employee memory) reads.
//
// Dispatch targets (all verified against the schema; every branch guarded so a
// missing table degrades to "left pending in the inbox", never a 500):
//   knowledge    → business_knowledge   (read by AI employees, the #2 hook)
//   social       → social_posts (status 'draft')   — text/content detected at runtime
//   follow_up    → reminders             (sales follow-up)
//   email/supplier → reminders           (a "draft + send" reminder; nothing auto-sent)
//   task         → reminders
//   contact_note → contacts.notes        (appended to the matched contact)
// Nothing is ever auto-SENT. Emails/posts land as drafts/reminders for review.
//
// WIRING (already applied this session):
//   server.js          : app.use("/api/notes", require("./routes/notes"));
//   ai-employees.js    : ${ownerKnowledge} via require("./notes").getBusinessKnowledge(getDb(), employee.user_id)
//
// Tables self-create on first use (CREATE TABLE IF NOT EXISTS) — no migration step.
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const router = express.Router();
const crypto = require("crypto");

const { auth } = require("../middleware/auth");
const { getDb } = require("../db/init");
const { callClaude } = require("./claude-helper");

const uid = () => crypto.randomUUID();

let _ready = false;
function ensureTables(db) {
  if (_ready) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, raw_text TEXT NOT NULL,
      source TEXT DEFAULT 'text', item_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'captured', created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id, created_at);

    CREATE TABLE IF NOT EXISTS note_items (
      id TEXT PRIMARY KEY, note_id TEXT, user_id TEXT NOT NULL,
      kind TEXT, title TEXT, detail TEXT, target TEXT,
      contact_hint TEXT, due_hint TEXT,
      routed_to TEXT, routed_ref TEXT,
      status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_note_items_user ON note_items(user_id, status, created_at);

    CREATE TABLE IF NOT EXISTS business_knowledge (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, text TEXT NOT NULL,
      source_note_id TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bizknow_user ON business_knowledge(user_id, created_at);
  `);
  _ready = true;
}

const KIND_TARGET = {
  task: "tasks", follow_up: "sales", email: "email", supplier: "email",
  social: "social", knowledge: "knowledge", contact_note: "contacts", other: "none",
};
const normalizeTarget = (kind) => KIND_TARGET[String(kind || "").toLowerCase()] || "none";

// Detect social_posts' content column once (base schema uses `text`, a migration adds `content`).
let _socialCols = null;
function socialColumns(db) {
  if (_socialCols) return _socialCols;
  try { _socialCols = new Set(db.prepare("PRAGMA table_info(social_posts)").all().map((r) => r.name)); }
  catch (_) { _socialCols = new Set(); }
  return _socialCols;
}

function findContact(db, userId, hint) {
  const h = String(hint || "").trim();
  if (!h) return null;
  try {
    let row = db.prepare("SELECT id FROM contacts WHERE user_id=? AND (lower(email)=lower(?) OR lower(name)=lower(?)) LIMIT 1").get(userId, h, h);
    if (!row) row = db.prepare("SELECT id FROM contacts WHERE user_id=? AND lower(name) LIKE lower(?) LIMIT 1").get(userId, "%" + h + "%");
    return row || null;
  } catch (_) { return null; }
}

// Dispatch one item. Returns {routed, routed_to, routed_ref}.
function dispatch(db, userId, item) {
  const t = item.target;
  const title = String(item.title || "").trim();
  const detail = String(item.detail || "").trim();
  try {
    if (t === "social") {
      const cols = socialColumns(db);
      const id = uid();
      const body = ((title ? title + ": " : "") + (detail || title || "")).slice(0, 2000);
      const fields = ["id", "user_id"], vals = [id, userId];
      if (cols.has("text")) { fields.push("text"); vals.push(body); }
      if (cols.has("content")) { fields.push("content"); vals.push(body); }
      if (cols.has("platforms")) { fields.push("platforms"); vals.push(JSON.stringify([])); }
      fields.push("status"); vals.push("draft");
      const sql = `INSERT INTO social_posts (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`;
      db.prepare(sql).run(...vals);
      return { routed: true, routed_to: "social drafts", routed_ref: id };
    }
    if (t === "sales" || t === "email" || t === "tasks") {
      const id = uid();
      const note = (title || detail || "Task") + (title && detail ? " — " + detail : "");
      db.prepare("INSERT INTO reminders (id, user_id, note, contact_name, due_at, done, created_at) VALUES (?,?,?,?,?,0,datetime('now'))")
        .run(id, userId, note.slice(0, 500), String(item.contact_hint || "").slice(0, 160) || null, String(item.due_hint || "").slice(0, 80) || null);
      const label = t === "email" ? "reminders (draft email)" : t === "sales" ? "reminders (follow-up)" : "reminders (task)";
      return { routed: true, routed_to: label, routed_ref: id };
    }
    if (t === "contacts") {
      const c = findContact(db, userId, item.contact_hint);
      if (c) {
        db.prepare("UPDATE contacts SET notes = COALESCE(notes,'') || ? WHERE id=?").run("\n[note] " + (detail || title), c.id);
        return { routed: true, routed_to: "contact: " + String(item.contact_hint || "").slice(0, 60), routed_ref: c.id };
      }
      return { routed: false };  // no matching contact → keep pending for manual link
    }
  } catch (_) { return { routed: false }; }
  return { routed: false };
}

const PARSE_SYSTEM = `You turn a small-business owner's messy brain-dump into structured action items.
Return ONLY a JSON object, no prose, no markdown fences. Shape:
{"items":[{"kind":"task|follow_up|email|social|supplier|knowledge|contact_note|other","title":"short imperative","detail":"specifics","contact_hint":"person/company if named else empty","due_hint":"when, if stated, else empty"}]}
Rules:
- One item per distinct intent. A single sentence can yield multiple items.
- "knowledge" = a durable fact about how the business runs (policy, price, hours, rule) — NOT a one-off task.
- "contact_note" = an observation about a specific named customer.
- Titles under 8 words. Never invent details not in the text.
- No actionable content → {"items":[]}.`;

async function parseNote(text) {
  const d = await callClaude({
    model: "claude-sonnet-4-6", maxTokens: 1024, system: PARSE_SYSTEM,
    messages: [{ role: "user", content: String(text).slice(0, 6000) }],
    temperature: 0, enableCaching: false,
  });
  const raw = (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").replace(/```json|```/g, "").trim();
  let parsed; try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
  const items = Array.isArray(parsed && parsed.items) ? parsed.items : [];
  return items.length ? items : [{ kind: "task", title: "Review note", detail: String(text).slice(0, 500), contact_hint: "", due_hint: "" }];
}

// ── POST /api/notes/capture — the front door (#1, #3) ────────────────────────
router.post("/capture", auth, async (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const text = (req.body && req.body.text ? String(req.body.text) : "").trim();
    const source = req.body && req.body.source === "voice" ? "voice" : "text";
    if (!text) return res.status(400).json({ ok: false, error: "text is required" });

    const noteId = uid();
    const items = await parseNote(text);
    db.prepare("INSERT INTO notes (id, user_id, raw_text, source, item_count, status) VALUES (?,?,?,?,?, 'captured')")
      .run(noteId, req.userId, text, source, items.length);

    const insItem = db.prepare("INSERT INTO note_items (id, note_id, user_id, kind, title, detail, target, contact_hint, due_hint, routed_to, routed_ref, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
    const insKnow = db.prepare("INSERT INTO business_knowledge (id, user_id, text, source_note_id) VALUES (?,?,?,?)");

    let routedCount = 0;
    const saved = [];
    for (const it of items) {
      const kind = String(it.kind || "other").toLowerCase();
      const target = normalizeTarget(kind);
      const itemId = uid();
      let status = "pending", routed_to = null, routed_ref = null;

      if (target === "knowledge") {
        insKnow.run(uid(), req.userId, String(it.detail || it.title || "").slice(0, 1000), noteId);
        status = "routed"; routed_to = "employee knowledge"; routedCount++;
      } else {
        const r = dispatch(db, req.userId, { target, title: it.title, detail: it.detail, contact_hint: it.contact_hint, due_hint: it.due_hint });
        if (r.routed) { status = "routed"; routed_to = r.routed_to; routed_ref = r.routed_ref; routedCount++; }
      }

      insItem.run(itemId, noteId, req.userId, kind, String(it.title || "").slice(0, 200), String(it.detail || "").slice(0, 1000), target, String(it.contact_hint || "").slice(0, 160), String(it.due_hint || "").slice(0, 80), routed_to, routed_ref, status);
      saved.push({ id: itemId, kind, title: it.title, detail: it.detail, target, contact_hint: it.contact_hint, due_hint: it.due_hint, routed_to, status });
    }

    try {
      db.prepare("INSERT INTO user_notifications (id, user_id, type, severity, title, body, action_url, action_label) VALUES (?,?,?,?,?,?,?,?)")
        .run(uid(), req.userId, "notes", "info", `Captured ${items.length} item${items.length === 1 ? "" : "s"}`, `${routedCount} routed automatically`, "#notes", "Open notes");
    } catch (_) {}
    try { if (typeof global.mineTrackUsage === "function") global.mineTrackUsage(db, req.userId, "notesCaptured"); } catch (_) {}

    res.json({ ok: true, note: { id: noteId, source, item_count: items.length }, routed: routedCount, items: saved });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "capture failed" });
  }
});

// ── GET /api/notes — hub history ─────────────────────────────────────────────
router.get("/", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const notes = db.prepare("SELECT id, raw_text, source, item_count, status, created_at FROM notes WHERE user_id=? ORDER BY created_at DESC LIMIT 50").all(req.userId);
    const items = db.prepare("SELECT id, note_id, kind, title, detail, target, contact_hint, due_hint, routed_to, status FROM note_items WHERE user_id=? ORDER BY created_at DESC LIMIT 300").all(req.userId);
    const g = {}; for (const i of items) (g[i.note_id] = g[i.note_id] || []).push(i);
    res.json({ ok: true, notes: notes.map((n) => ({ ...n, items: g[n.id] || [] })) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── GET /api/notes/items?status=pending — inbox ──────────────────────────────
router.get("/items", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const status = String(req.query.status || "pending");
    const rows = db.prepare("SELECT id, note_id, kind, title, detail, target, contact_hint, due_hint, routed_to, status, created_at FROM note_items WHERE user_id=? AND status=? ORDER BY created_at DESC LIMIT 200").all(req.userId, status);
    res.json({ ok: true, items: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── POST /api/notes/items/:id/status ─────────────────────────────────────────
router.post("/items/:id/status", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const status = String(req.body && req.body.status || "");
    if (!["pending", "routed", "done", "dismissed"].includes(status)) return res.status(400).json({ ok: false, error: "invalid status" });
    const r = db.prepare("UPDATE note_items SET status=? WHERE id=? AND user_id=?").run(status, req.params.id, req.userId);
    res.json({ ok: r.changes > 0, updated: r.changes });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── POST /api/notes/ask (#4) ─────────────────────────────────────────────────
router.post("/ask", auth, async (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const question = (req.body && req.body.question ? String(req.body.question) : "").trim();
    if (!question) return res.status(400).json({ ok: false, error: "question is required" });
    const notes = db.prepare("SELECT raw_text, created_at FROM notes WHERE user_id=? ORDER BY created_at DESC LIMIT 100").all(req.userId);
    const know = db.prepare("SELECT text FROM business_knowledge WHERE user_id=? ORDER BY created_at DESC LIMIT 100").all(req.userId);
    if (!notes.length && !know.length) return res.json({ ok: true, answer: "You haven't captured any notes yet." });
    const corpus = "BUSINESS KNOWLEDGE:\n" + know.map((k) => "- " + k.text).join("\n") + "\n\nRECENT NOTES:\n" + notes.map((n) => `(${n.created_at}) ${n.raw_text}`).join("\n");
    const d = await callClaude({
      model: "claude-sonnet-4-6", maxTokens: 600,
      system: "Answer the user's question using ONLY the notes and knowledge provided. Be concise. If the answer isn't there, say so plainly.",
      messages: [{ role: "user", content: `${corpus}\n\nQUESTION: ${question}` }], temperature: 0,
    });
    res.json({ ok: true, answer: (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── GET /api/notes/knowledge ─────────────────────────────────────────────────
router.get("/knowledge", auth, (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    const rows = db.prepare("SELECT id, text, created_at FROM business_knowledge WHERE user_id=? ORDER BY created_at DESC LIMIT 200").all(req.userId);
    res.json({ ok: true, knowledge: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── #2 employee-memory hook ──────────────────────────────────────────────────
function getBusinessKnowledge(db, userId, limit = 40) {
  try {
    ensureTables(db);
    const rows = db.prepare("SELECT text FROM business_knowledge WHERE user_id=? ORDER BY created_at DESC LIMIT ?").all(userId, limit);
    if (!rows.length) return "";
    return "\nWHAT THE OWNER HAS TOLD YOU ABOUT THIS BUSINESS:\n" + rows.map((r) => "- " + r.text).join("\n") + "\n";
  } catch (_) { return ""; }
}

module.exports = router;
module.exports.getBusinessKnowledge = getBusinessKnowledge;
