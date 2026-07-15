const express = require("express");
const multer  = require("multer");
const path    = require("path");
const { v4: uuid } = require("uuid");
const { getDb }    = require("../db/init");
const { auth }     = require("../middleware/auth");
const { getMulterStorage, getFileUrl, isS3Enabled, deleteFromS3 } = require("../utils/s3");

const router  = express.Router();
const MAX_SIZE = (parseInt(process.env.MAX_FILE_SIZE_MB) || 10) * 1024 * 1024;

// Storage: S3 if configured, local disk otherwise (automatic fallback)
const storage = getMulterStorage("uploads");

const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    const allowedExts = [".jpg",".jpeg",".png",".gif",".webp",".svg",".pdf",".mp4",".webm",".mp3",".docx",".xlsx",".csv",".txt",".zip"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} not allowed`));
    }
  },
});

// POST /api/files/upload — upload a file (S3 or local)
router.post("/upload", auth, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  // Magic-byte validation — only possible for local uploads; S3 files aren't on local disk
  if (req.file.path && !req.file.key) {
    const { validateUploadedFile } = require("../lib/file-validator");
    const validation = validateUploadedFile(req.file.path, "any");
    if (!validation.valid) {
      try { require("fs").unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: "Invalid file: " + validation.reason });
    }
  }

  const db = getDb();
  const { v4: fid } = require("uuid");
  const fileUrl = getFileUrl(req.file, process.env.BACKEND_URL);
  const s3Key   = req.file.key || null; // multer-s3 sets .key
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS uploaded_files (
      id TEXT PRIMARY KEY, user_id TEXT, filename TEXT, original_name TEXT,
      mimetype TEXT, size INTEGER, url TEXT, s3_key TEXT,
      storage TEXT DEFAULT 'local', created_at TEXT DEFAULT (datetime('now'))
    )`);
    db.prepare("INSERT INTO uploaded_files (id, user_id, filename, original_name, mimetype, size, url, s3_key, storage) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(fid(), req.userId, req.file.filename || req.file.key, req.file.originalname,
           req.file.mimetype, req.file.size, fileUrl, s3Key,
           isS3Enabled() ? "s3" : "local");
  } catch(e) { /* non-fatal */ }
  res.json({ success: true, url: fileUrl, filename: req.file.filename || req.file.key, size: req.file.size, storage: isS3Enabled() ? "s3" : "local" });
});

// POST /api/files/upload-multiple
router.post("/upload-multiple", auth, upload.array("files", 10), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: "No files uploaded" });

  // Magic-byte validation for local uploads
  const { validateUploadedFile } = require("../lib/file-validator");
  const fsMod = require("fs");
  for (const f of req.files) {
    if (f.path && !f.key) {
      const validation = validateUploadedFile(f.path, "any");
      if (!validation.valid) {
        // Delete ALL uploaded files in this batch — fail atomically
        req.files.forEach(x => { if (x.path) { try { fsMod.unlinkSync(x.path); } catch {} } });
        return res.status(400).json({ error: "Invalid file (" + f.originalname + "): " + validation.reason });
      }
    }
  }

  const urls = req.files.map(f => getFileUrl(f, process.env.BACKEND_URL));
  res.json({ success: true, urls, count: req.files.length, storage: isS3Enabled() ? "s3" : "local" });
});

// GET /api/files/:filename — serve local files (not needed for S3 — URLs are direct)
router.get("/:filename", (req, res) => {
  const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, "");
  const dir = process.env.UPLOAD_DIR || "./uploads";
  const filepath = require("path").join(dir, filename);
  if (!require("fs").existsSync(filepath)) return res.status(404).json({ error: "File not found" });
  res.sendFile(filepath, { root: "/" });
});

// DELETE /api/files/:filename
router.delete("/:id", auth, async (req, res) => {
  const db = getDb();
  try {
    const file = db.prepare("SELECT * FROM uploaded_files WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!file) return res.status(404).json({ error: "File not found" });
    if (file.storage === "s3" && file.s3_key) {
      await deleteFromS3(file.s3_key);
    } else if (file.filename) {
      const fp = require("path").join(process.env.UPLOAD_DIR || "./uploads", file.filename);
      try { require("fs").unlinkSync(fp); } catch(e) {}
    }
    db.prepare("DELETE FROM uploaded_files WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});


// ══════════════════════════════════════════════════════════════════════════════
//  CLAUDE FILES API — Document Intelligence
//  Upload PDFs/images → Claude extracts structured business data
// ══════════════════════════════════════════════════════════════════════════════

const multerMemory = require("multer")({ storage: require("multer").memoryStorage() });

// POST /api/files/extract — upload a document, Claude extracts business data
router.post("/extract", auth, multerMemory.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const { intent } = req.body; // "invoice", "receipt", "contract", "business_card", "auto"

    const apiKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(400).json({ error: "ANTHROPIC_API_KEY not configured" });

    const base64 = req.file.buffer.toString("base64");
    const mimeType = req.file.mimetype; // image/jpeg, image/png, application/pdf

    // Detect intent from filename if auto
    const filename = (req.file.originalname || "").toLowerCase();
    const detectedIntent = intent || (
      filename.includes("invoice") || filename.includes("inv") ? "invoice" :
      filename.includes("receipt") ? "receipt" :
      filename.includes("contract") || filename.includes("agreement") ? "contract" :
      "auto"
    );

    const prompts = {
      invoice: `Extract all data from this invoice/receipt. Return JSON: { vendor_name, amount_total, amount_tax, currency, invoice_date, due_date, invoice_number, line_items: [{description, qty, unit_price, total}], payment_method, notes }`,
      receipt: `Extract receipt data. Return JSON: { vendor_name, total_amount, tax_amount, date, items: [{name, price}], payment_method, category }`,
      contract: `Extract key contract terms. Return JSON: { parties: [], effective_date, expiry_date, value_amount, currency, key_obligations: [], payment_terms, notice_period, governing_law, summary }`,
      business_card: `Extract contact info from this business card. Return JSON: { name, title, company, email, phone, website, address }`,
      auto: `Analyse this document and extract all relevant business data. Return JSON with appropriate fields based on document type. Include a "document_type" field.`,
    };

    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });

    // Use Files API for PDFs, direct base64 for images
    let messageContent;
    if (mimeType === "application/pdf") {
      // Upload to Files API first
      const { Blob } = require("buffer");
      const fileBlob = new Blob([req.file.buffer], { type: "application/pdf" });
      const uploadedFile = await client.beta.files.upload({
        file: new File([fileBlob], req.file.originalname || "document.pdf", { type: "application/pdf" }),
      });
      messageContent = [
        { type: "text", text: prompts[detectedIntent] + "\n\nReturn ONLY valid JSON, no markdown." },
        { type: "document", source: { type: "file", file_id: uploadedFile.id } },
      ];
    } else {
      messageContent = [
        { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
        { type: "text", text: prompts[detectedIntent] + "\n\nReturn ONLY valid JSON, no markdown." },
      ];
    }

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      temperature: 0,
      betas: mimeType === "application/pdf" ? ["files-api-2025-04-14"] : undefined,
      messages: [{ role: "user", content: messageContent }],
    });

    const rawText = response.content.find(b => b.type === "text")?.text || "{}";
    const cleaned = rawText.replace(/```json|```/g, "").trim();

    let extracted;
    try { extracted = JSON.parse(cleaned); }
    catch(e) { extracted = { raw: rawText, parse_error: true }; }

    // Auto-actions based on intent
    const db = getDb();
    let autoAction = null;

    if (detectedIntent === "receipt" || detectedIntent === "invoice") {
      // Auto-create expense record
      try {
        db.prepare(`CREATE TABLE IF NOT EXISTS expenses (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL, description TEXT,
          amount REAL DEFAULT 0, category TEXT DEFAULT 'General',
          date TEXT, source TEXT DEFAULT 'manual', vendor TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )`).run();
        const { v4: uuid } = require("uuid");
        const amount = parseFloat(extracted.amount_total || extracted.total_amount || 0);
        const vendor = extracted.vendor_name || "Unknown vendor";
        if (amount > 0) {
          db.prepare("INSERT INTO expenses (id, user_id, description, amount, category, date, source, created_at) VALUES (?,?,?,?,?,?,?,datetime('now')) ON CONFLICT DO NOTHING")
            .run(uuid(), req.userId, vendor, amount, extracted.category || "General", extracted.invoice_date || extracted.date || new Date().toISOString().split("T")[0], "claude_extract");
          autoAction = { type: "expense_created", vendor, amount };
        }
      } catch(e) { /* non-fatal */ }
    }

    if (detectedIntent === "business_card" && extracted.name) {
      // Auto-create contact
      try {
        const { v4: uuid } = require("uuid");
        const existing = db.prepare("SELECT id FROM contacts WHERE user_id=? AND (email=? OR (name=? AND phone=?))").get(req.userId, extracted.email||"", extracted.name, extracted.phone||"");
        if (!existing) {
          db.prepare("INSERT INTO contacts (id, user_id, name, email, phone, company, source, status, created_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))")
            .run(uuid(), req.userId, extracted.name, extracted.email||null, extracted.phone||null, extracted.company||null, "business_card", "lead");
          autoAction = { type: "contact_created", name: extracted.name };
        }
      } catch(e) { /* non-fatal */ }
    }

    res.json({ success: true, intent: detectedIntent, extracted, auto_action: autoAction, filename: req.file.originalname });
  } catch(e) {
    console.error("[Files Extract]", e.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// GET /api/files/extract-history — recent extractions
router.get("/extract-history", auth, (req, res) => {
  try {
    const db = getDb();
    try { db.exec("CREATE TABLE IF NOT EXISTS document_extractions (id TEXT PRIMARY KEY, user_id TEXT, filename TEXT, intent TEXT, extracted_json TEXT, auto_action TEXT, created_at TEXT DEFAULT (datetime('now')))"); } catch(e) {}
    const history = db.prepare("SELECT id, filename, intent, auto_action, created_at FROM document_extractions WHERE user_id=? ORDER BY created_at DESC LIMIT 20").all(req.userId);
    res.json({ history });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

module.exports = router;
