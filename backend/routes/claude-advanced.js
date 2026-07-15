// ═══════════════════════════════════════════════════════════════════════════
// Claude Advanced — Files API, PDF input, Citations
// ═══════════════════════════════════════════════════════════════════════════
//
// Three new capabilities that extend what agents can do:
//
// 1. Files API     — upload a file once, reference by file_id across agents
// 2. PDF input     — agents read PDFs natively (invoices, contracts, proposals)
// 3. Citations     — agents ground responses in source documents with refs
//
// Mount in server.js:
//   app.use("/api/ai-employees", require("./routes/claude-advanced"));
//   require("./routes/claude-advanced").migrate();
//
// Or use helpers directly from other route files:
//   const { uploadFile, callWithFile, callWithCitations } = require("./claude-advanced");
// ═══════════════════════════════════════════════════════════════════════════

const express = require("express");
const multer = require("multer");
const { v4: uuid } = require("uuid");
const { getDb } = require("../db/init");
const { auth } = require("../middleware/auth");

const router = express.Router();
const ANTHROPIC_VERSION = "2023-06-01";
const FILES_BETA = "files-api-2025-04-14";  // beta header required for Files API

function apiHeaders(extra = {}) {
  return {
    "x-api-key": process.env.ANTHROPIC_API_KEY,
    "anthropic-version": ANTHROPIC_VERSION,
    ...extra,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. FILES API — upload once, reference by file_id
// ═══════════════════════════════════════════════════════════════════════════
//
// Usage (server-side helper):
//   const { fileId } = await uploadFile(buffer, "brand-guide.pdf", "application/pdf");
//   // Later, reuse fileId in any Claude call:
//   await callWithFile({ fileId, prompt: "What's our brand voice?" });

async function uploadFile(buffer, filename, mimeType) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), filename);

  const r = await fetch("https://api.anthropic.com/v1/files", {
    method: "POST",
    headers: apiHeaders({ "anthropic-beta": FILES_BETA }),
    body: form,
  });
  if (!r.ok) throw new Error(`Files upload ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return { fileId: d.id, filename: d.filename, size: d.size_bytes, type: d.mime_type };
}

async function deleteFile(fileId) {
  const r = await fetch(`https://api.anthropic.com/v1/files/${fileId}`, {
    method: "DELETE",
    headers: apiHeaders({ "anthropic-beta": FILES_BETA }),
  });
  return r.ok;
}

async function listFiles() {
  const r = await fetch("https://api.anthropic.com/v1/files", {
    headers: apiHeaders({ "anthropic-beta": FILES_BETA }),
  });
  if (!r.ok) throw new Error(`Files list ${r.status}`);
  return await r.json();
}

// ─── HTTP: POST /files/upload — from dashboard (brand kit, contracts, etc) ─
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },  // 30MB cap (Anthropic's limit is 32MB)
});

router.post("/files/upload", auth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no file" });
    const kind = req.body.kind || "general";  // e.g. "brand-kit", "contract-template", "past-proposal"
    const info = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);

    // Persist mapping so we can find files later by purpose
    getDb().prepare(`
      INSERT INTO ai_files (id, user_id, file_id, filename, mime_type, size_bytes, kind, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(uuid(), req.userId, info.fileId, info.filename, info.type, info.size, kind, req.body.description || null);

    res.json({ ok: true, ...info, kind });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/files", auth, (req, res) => {
  try {
    const rows = getDb().prepare(`
      SELECT file_id, filename, mime_type, size_bytes, kind, description, created_at
      FROM ai_files WHERE user_id = ?
      ORDER BY created_at DESC
    `).all(req.userId);
    res.json({ files: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/files/:fileId", auth, async (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare("SELECT file_id FROM ai_files WHERE user_id = ? AND file_id = ?")
      .get(req.userId, req.params.fileId);
    if (!row) return res.status(404).json({ error: "not found" });
    await deleteFile(req.params.fileId);
    db.prepare("DELETE FROM ai_files WHERE user_id = ? AND file_id = ?")
      .run(req.userId, req.params.fileId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. PDF INPUT — agents read PDFs natively
// ═══════════════════════════════════════════════════════════════════════════
//
// Two paths:
//   (a) via file_id (after uploading to Files API)
//   (b) via base64 inline (one-off reads, no persistence)
//
// Usage from agent code:
//   const analysis = await callWithFile({
//     fileId: invoice.file_id,
//     prompt: "Extract line items, total, and due date as JSON.",
//     maxTokens: 1000,
//   });
//
// For PDFs: Anthropic automatically renders each page + extracts text.
// No OCR step. Good for invoices, contracts, proposals, receipts.

async function callWithFile({
  fileId,
  pdfBase64,                // alternative: inline PDF
  pdfMimeType = "application/pdf",
  prompt,
  model = "claude-sonnet-4-6",
  maxTokens = 1500,
  system = "",
}) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  if (!fileId && !pdfBase64) throw new Error("fileId or pdfBase64 required");

  const source = fileId
    ? { type: "file", file_id: fileId }
    : { type: "base64", media_type: pdfMimeType, data: pdfBase64 };

  const body = {
    model,
    max_tokens: maxTokens,
    system: system || undefined,
    messages: [{
      role: "user",
      content: [
        { type: "document", source },
        { type: "text", text: prompt },
      ],
    }],
  };

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: apiHeaders({ "Content-Type": "application/json", "anthropic-beta": fileId ? FILES_BETA : undefined }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PDF call ${r.status}: ${await r.text()}`);
  const d = await r.json();
  const text = d.content?.find(b => b.type === "text")?.text || "";
  return { text, raw: d, usage: d.usage };
}

// HTTP: POST /files/:fileId/ask — ask a question about a previously uploaded file
router.post("/files/:fileId/ask", auth, async (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare("SELECT file_id FROM ai_files WHERE user_id = ? AND file_id = ?")
      .get(req.userId, req.params.fileId);
    if (!row) return res.status(404).json({ error: "not found" });

    const result = await callWithFile({
      fileId: row.file_id,
      prompt: req.body.prompt || "Summarize this document.",
      system: req.body.system || "",
      maxTokens: req.body.maxTokens || 1500,
    });
    res.json({ answer: result.text, usage: result.usage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. CITATIONS — agents ground responses in source documents
// ═══════════════════════════════════════════════════════════════════════════
//
// How it works: you pass documents alongside the user prompt, with
// citations.enabled: true. Claude returns answer text interleaved with
// {type: "citations"} blocks referencing specific source passages.
//
// Usage:
//   const {text, citations} = await callWithCitations({
//     documents: [
//       { title: "Q3 report", content: q3Text },
//       { title: "Product manual", content: manualText },
//     ],
//     prompt: "What should I focus on next quarter?",
//   });
//   // text:       "Focus on reducing churn [1] and expanding..."
//   // citations:  [{ index: 1, source: "Q3 report", quote: "churn rate up 12%..." }]

async function callWithCitations({
  documents,
  prompt,
  model = "claude-sonnet-4-6",
  maxTokens = 2000,
  system = "",
}) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  if (!Array.isArray(documents) || documents.length === 0) throw new Error("documents array required");

  // Build content array: each document block + the final user question
  const content = [];
  for (const doc of documents) {
    content.push({
      type: "document",
      source: {
        type: "text",
        media_type: "text/plain",
        data: doc.content,
      },
      title: doc.title || "Source",
      context: doc.context || undefined,
      citations: { enabled: true },
    });
  }
  content.push({ type: "text", text: prompt });

  const body = {
    model,
    max_tokens: maxTokens,
    system: system || undefined,
    messages: [{ role: "user", content }],
  };

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: apiHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Citations call ${r.status}: ${await r.text()}`);
  const d = await r.json();

  // Reassemble the streaming output — text blocks + citation blocks alternate
  let text = "";
  const citations = [];
  let citationIdx = 0;
  for (const block of (d.content || [])) {
    if (block.type === "text") {
      text += block.text;
      // Check if this text block has attached citations (API pattern)
      if (Array.isArray(block.citations)) {
        for (const c of block.citations) {
          citationIdx++;
          citations.push({
            index: citationIdx,
            source: c.document_title || `Source ${c.document_index + 1}`,
            quote: c.cited_text || "",
            document_index: c.document_index,
          });
          // Append marker inline
          text += ` [${citationIdx}]`;
        }
      }
    }
  }

  return { text, citations, raw: d, usage: d.usage };
}

// HTTP: POST /citations/ask — ask with inline documents
router.post("/citations/ask", auth, async (req, res) => {
  try {
    const { documents, prompt, system } = req.body;
    if (!Array.isArray(documents)) return res.status(400).json({ error: "documents array required" });
    if (!prompt) return res.status(400).json({ error: "prompt required" });

    const result = await callWithCitations({ documents, prompt, system });
    res.json({ answer: result.text, citations: result.citations, usage: result.usage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Migration ─────────────────────────────────────────────────────────────
function migrate() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS ai_files (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      file_id TEXT NOT NULL UNIQUE,
      filename TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      kind TEXT,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ai_files_user ON ai_files(user_id, kind, created_at);
  `);
}

module.exports = router;
module.exports.migrate = migrate;
module.exports.uploadFile = uploadFile;
module.exports.deleteFile = deleteFile;
module.exports.listFiles = listFiles;
module.exports.callWithFile = callWithFile;
module.exports.callWithCitations = callWithCitations;
