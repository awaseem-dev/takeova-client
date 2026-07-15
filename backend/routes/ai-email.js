// ════════════════════════════════════════════════════════════════════
// routes/ai-email.js — Email-specific AI generation and editing
// ════════════════════════════════════════════════════════════════════
// Dedicated endpoints for composing and editing HTML emails via Claude.
// Separated from ai-agent.js because that file uses MINE_SYSTEM (website
// generation prompt) which produces wrong output for email work.
//
// ENDPOINTS
//   POST /api/ai-email/write  — generate full email from a description
//   POST /api/ai-email/edit   — surgically edit an existing email
//
// CAP: both count as 1 aiAction per call (30/mo Starter, 1000/mo Agency).
// Cheaper than aiBuilds — appropriate for small frequent generations.
//
// TO MOUNT IN server.js:
//   app.use("/api/ai-email", require("./routes/ai-email"));
// ════════════════════════════════════════════════════════════════════
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const { getDb } = require("../db/init");
const { auth } = require("../middleware/auth");

const router = express.Router();

// ─── System prompt: email-specific ────────────────────────────────
const EMAIL_SYSTEM = `You are an expert email copywriter for small business owners. You write emails that feel personal, convert well, and respect the reader's time.

OUTPUT FORMAT (strict):
Output ONLY a JSON array of blocks. No prose before or after. No markdown code fences. No explanation. Start with [ and end with ].

BLOCK TYPES:
  {"type":"heading","text":"..."}                              - Section heading (< 60 chars)
  {"type":"text","text":"..."}                                 - Paragraph (use \\n for breaks)
  {"type":"button","text":"Book now","href":"https://..."}     - CTA button
  {"type":"image","src":"https://placehold.co/560x280","alt":"desc"}  - Image
  {"type":"divider"}                                            - Horizontal rule

WRITING RULES:
- 4 to 8 blocks total. Concise beats comprehensive.
- Use {{name}} for personalisation of the recipient's name.
- Use {{business_name}} only if the business name is provided in the prompt.
- Open with a warm, specific greeting — not generic "Dear customer".
- Each text block is 1 to 3 sentences. Not walls of text.
- Exactly ONE button block (the primary CTA). Don't use more than one.
- End with a human signoff line ("Talk soon, Sarah" style), not "Regards,".
- DO NOT include an unsubscribe link or footer — that is added automatically.
- DO NOT include HTML tags, markdown, or any formatting inside text fields.
- DO NOT wrap output in code fences or prose.
`;

// ─── Helpers ──────────────────────────────────────────────────────
function getSetting(k) {
  try {
    return getDb().prepare("SELECT value FROM platform_settings WHERE key = ?").get(k)?.value || "";
  } catch { return ""; }
}

function parseBlocks(text) {
  // Extract JSON array from Claude's response, tolerating stray prose
  const first = text.indexOf("[");
  const last  = text.lastIndexOf("]");
  if (first < 0 || last < 0 || last <= first) return null;
  try {
    const parsed = JSON.parse(text.slice(first, last + 1));
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    // Filter out anything that isn't a valid block
    const valid = ["heading", "text", "button", "image", "divider"];
    return parsed.filter(b => b && typeof b === "object" && valid.indexOf(b.type) >= 0);
  } catch { return null; }
}

function checkCap(db, userId) {
  if (typeof global === "undefined" || !global.mineCheckUsage) return { ok: true };
  const usage = global.mineCheckUsage(db, userId, "aiActions");
  if (usage.blocked) {
    return {
      ok: false,
      status: 403,
      body: {
        error: "You've used all your AI actions for this month.",
        used: usage.used, cap: usage.cap, upgrade: true
      }
    };
  }
  return { ok: true };
}

function trackUsage(db, userId) {
  if (typeof global !== "undefined" && global.mineTrackUsage) {
    try { global.mineTrackUsage(db, userId, "aiActions"); } catch (_) {}
  }
}

// ─── POST /write — generate a new email ──────────────────────────
router.post("/write", auth, async (req, res) => {
  const { prompt, bizName, bizContext, tone } = req.body || {};
  if (!prompt || String(prompt).trim().length < 3) {
    return res.status(400).json({ error: "Describe the email you want to send" });
  }

  const apiKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "AI not configured — add an Anthropic API key in admin settings" });

  const db = getDb();
  const cap = checkCap(db, req.userId);
  if (!cap.ok) return res.status(cap.status).json(cap.body);

  try {
    const client = new Anthropic({ apiKey });

    // Compose the user message with any provided context
    let userMsg = `Email request: ${prompt}`;
    if (bizName) {
      userMsg = `Business: ${bizName}${bizContext ? " — " + bizContext : ""}\n\n` + userMsg;
    }
    if (tone) userMsg += `\n\nTone: ${tone}`;

    const msg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      temperature: 0,
      system: EMAIL_SYSTEM,
      messages: [{ role: "user", content: userMsg }]
    });

    const text = msg.content?.[0]?.text || "";
    const blocks = parseBlocks(text);
    if (!blocks || blocks.length === 0) {
      return res.status(502).json({
        error: "AI returned unparseable output — try again",
        raw: text.slice(0, 300)
      });
    }

    trackUsage(db, req.userId);

    // Auto-generate a subject if the first block is a heading
    let subject = null;
    const firstHeading = blocks.find(b => b.type === "heading");
    if (firstHeading && firstHeading.text) {
      subject = firstHeading.text.replace(/^hi\s+\{\{name\}\},?\s*/i, "").slice(0, 80);
    }

    res.json({ blocks, subject });
  } catch (e) {
    console.error("[ai-email/write]", e.message);
    const sanitize = (typeof global !== "undefined" && global.sanitizeError) ? global.sanitizeError : (x => x.message || "Error");
    res.status(500).json({ error: sanitize(e) });
  }
});

// ─── POST /edit — surgically edit an existing email ──────────────
router.post("/edit", auth, async (req, res) => {
  const { blocks: existing, subject, request } = req.body || {};
  if (!request || String(request).trim().length < 3) {
    return res.status(400).json({ error: "Describe what to change" });
  }
  if (!Array.isArray(existing) || existing.length === 0) {
    return res.status(400).json({ error: "No email to edit — write one first" });
  }

  const apiKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "AI not configured" });

  const db = getDb();
  const cap = checkCap(db, req.userId);
  if (!cap.ok) return res.status(cap.status).json(cap.body);

  const EDIT_SYSTEM = EMAIL_SYSTEM + `

EDIT-SPECIFIC RULES:
- You are given an existing email as JSON blocks and a change request.
- Return the FULL updated block array (not a patch, not a diff).
- Keep blocks the user did NOT ask to change exactly as they were — do not rewrite them.
- Only modify what the change request specifies. Preserve everything else.
- If asked to add a block, insert it at the logical position.
- If asked to remove/shorten, target the specific block and tighten its text.
`;

  try {
    const client = new Anthropic({ apiKey });

    const userMsg =
      `CURRENT EMAIL${subject ? " (subject: " + subject + ")" : ""}:\n` +
      JSON.stringify(existing, null, 2) +
      "\n\nCHANGE REQUEST: " + request +
      "\n\nReturn the full updated block array.";

    const msg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      temperature: 0,
      system: EDIT_SYSTEM,
      messages: [{ role: "user", content: userMsg }]
    });

    const text = msg.content?.[0]?.text || "";
    const newBlocks = parseBlocks(text);
    if (!newBlocks || newBlocks.length === 0) {
      return res.status(502).json({
        error: "AI returned unparseable output — try again",
        raw: text.slice(0, 300)
      });
    }

    trackUsage(db, req.userId);
    res.json({ blocks: newBlocks });
  } catch (e) {
    console.error("[ai-email/edit]", e.message);
    const sanitize = (typeof global !== "undefined" && global.sanitizeError) ? global.sanitizeError : (x => x.message || "Error");
    res.status(500).json({ error: sanitize(e) });
  }
});

module.exports = router;
