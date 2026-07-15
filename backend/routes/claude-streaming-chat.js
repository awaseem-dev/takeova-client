// ═══════════════════════════════════════════════════════════════════════════
// Streaming Chat Endpoints — uses streamClaude for real-time chat UIs
// ═══════════════════════════════════════════════════════════════════════════
//
// Mount in server.js:
//   app.use("/api/ai-employees", require("./routes/claude-streaming-chat"));
//
// Frontend usage (in the dashboard JavaScript):
//
//   const res = await fetch("/api/ai-employees/chat-stream", {
//     method: "POST", headers: {"Content-Type":"application/json","Authorization":`Bearer ${token}`},
//     body: JSON.stringify({ message: "What should I focus on today?", history: [] })
//   });
//   const reader = res.body.getReader();
//   const dec = new TextDecoder();
//   while (true) {
//     const {done, value} = await reader.read();
//     if (done) break;
//     for (const frame of dec.decode(value).split("\n\n")) {
//       const line = frame.split("\n").find(l => l.startsWith("data: "));
//       if (!line) continue;
//       const payload = line.slice(6).trim();
//       if (payload === "[DONE]") { /* render done state */ continue; }
//       try { const {text} = JSON.parse(payload); appendToChat(text); } catch {}
//     }
//   }
//
// This gives the user word-by-word output instead of a 10s spinner.
// ═══════════════════════════════════════════════════════════════════════════

const express = require("express");
const { teamRosterText } = require("../employee-identity");
const { auth } = require("../middleware/auth");
const { getDb } = require("../db/init");
const { streamClaude } = require("./claude-helper");

const router = express.Router();

// ─── POST /chat-stream — Take Control / AI Advisor chat with streaming ─────
router.post("/chat-stream", auth, async (req, res) => {
  const { message, history = [], role = "advisor" } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message required" });
  }

  // Load business context from the user's AI employee config
  let businessContext = "";
  try {
    const emp = getDb().prepare(`
      SELECT business_context FROM ai_employees
      WHERE user_id = ? AND business_context IS NOT NULL LIMIT 1
    `).get(req.userId);
    businessContext = emp?.business_context || "";
  } catch { /* no context available, continue without */ }

  // Set up SSE response
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
  res.flushHeaders?.();

  // Build conversation
  const messages = [...history, { role: "user", content: message }];

  const systemPrompt = role === "advisor"
    ? "You are TAKEOVA Advisor — a helpful business advisor for the user's business. Answer concisely and directly. Use the business context to make advice specific to their situation."
    : "You are Take Control — an AI COO helping the user run their business. Give tactical, actionable advice. You lead a team of AI specialists you can delegate to or speak on behalf of: " + teamRosterText() + ". When a task fits a teammate, refer to them by name.";

  await streamClaude({
    model: "claude-sonnet-4-6",
    maxTokens: 1500,
    system: systemPrompt,
    businessContext,  // automatically cached if big enough
    messages,
    onChunk: (text) => {
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    },
    onDone: (fullText, usage) => {
      // Log the interaction
      try {
        getDb().prepare(`
          INSERT INTO ai_chat_history (id, user_id, role, message, response, usage_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
          require("uuid").v4(),
          req.userId, role, message, fullText,
          JSON.stringify(usage || {}),
        );
      } catch { /* table may not exist yet; non-critical */ }
      res.write(`data: [DONE]\n\n`);
      res.end();
    },
    onError: (err) => {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    },
  });
});

// ─── Migration ─────────────────────────────────────────────────────────────
function migrate() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS ai_chat_history (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role TEXT,
      message TEXT,
      response TEXT,
      usage_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chat_user ON ai_chat_history(user_id, created_at);
  `);
}

module.exports = router;
module.exports.migrate = migrate;
