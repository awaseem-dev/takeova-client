// ═══════════════════════════════════════════════════════════════════
// MARKETING MATERIALS — admin uploads swipe copy + banners/images
// affiliates fetch them via public endpoint on their dashboard.
// ═══════════════════════════════════════════════════════════════════

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { getDb } = require("../db/init");
const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, "..", "uploads", "marketing");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ─── storage: writes files to /uploads/marketing/, keeps extension ───
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().slice(0, 8) || ".bin";
    const name = crypto.randomBytes(12).toString("hex") + ext;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB max per asset
  fileFilter: (req, file, cb) => {
    // only images + a few doc types
    const ok = /image\/(png|jpeg|gif|webp|svg\+xml)/.test(file.mimetype);
    cb(ok ? null : new Error("Only image files allowed (PNG, JPG, GIF, WebP, SVG)"), ok);
  }
});

// ─── table init (idempotent) ─────────────────────────────────────────
function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS marketing_materials (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,              -- 'swipe' | 'banner' | 'video' | 'other'
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    platform TEXT DEFAULT '',        -- 'email' | 'twitter' | 'instagram' | 'linkedin' | 'tiktok' | 'generic'
    content TEXT DEFAULT '',         -- swipe-copy text; blank for files
    file_url TEXT DEFAULT '',        -- for banners/images
    file_size INTEGER DEFAULT 0,
    dimensions TEXT DEFAULT '',      -- e.g. "1080x1920"
    thumbnail_url TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_marketing_type ON marketing_materials(type, active, sort_order)`);
}

// ─── simple admin auth (reuse app-level middleware if mounted with it) ─
function adminOnly(req, res, next) {
  // Expect either req.user.role === 'admin' (from JWT auth middleware) OR x-admin-key header.
  const adminKey = process.env.ADMIN_API_KEY;
  if (req.headers["x-admin-key"] && adminKey && req.headers["x-admin-key"] === adminKey) return next();
  if (req.user && req.user.role === "admin") return next();
  return res.status(403).json({ error: "Admin only" });
}

// ═══════════════════════════════════════════════════════════════════
// PUBLIC: affiliates fetch active materials
// GET /api/marketing/list?type=swipe|banner
// ═══════════════════════════════════════════════════════════════════
router.get("/list", (req, res) => {
  const db = getDb();
  ensureTable(db);
  const type = req.query.type;
  let rows;
  if (type) {
    rows = db.prepare(`SELECT id, type, title, description, platform, content, file_url, file_size, dimensions, thumbnail_url, created_at FROM marketing_materials WHERE type = ? AND active = 1 ORDER BY sort_order ASC, created_at DESC`).all(type);
  } else {
    rows = db.prepare(`SELECT id, type, title, description, platform, content, file_url, file_size, dimensions, thumbnail_url, created_at FROM marketing_materials WHERE active = 1 ORDER BY type ASC, sort_order ASC, created_at DESC`).all();
  }
  // Group by type for convenience
  const grouped = { swipe: [], banner: [], video: [], other: [] };
  for (const r of rows) {
    if (grouped[r.type]) grouped[r.type].push(r);
    else grouped.other.push(r);
  }
  res.json({ success: true, materials: rows, grouped });
});

// ═══════════════════════════════════════════════════════════════════
// ADMIN: upload + CRUD
// ═══════════════════════════════════════════════════════════════════

// POST /api/marketing/admin/swipe — create swipe copy (no file)
router.post("/admin/swipe", adminOnly, (req, res) => {
  const db = getDb();
  ensureTable(db);
  const { title, description, platform, content, sort_order } = req.body;
  if (!title || !content) return res.status(400).json({ error: "title and content required" });
  const id = crypto.randomBytes(8).toString("hex");
  db.prepare(`INSERT INTO marketing_materials (id, type, title, description, platform, content, sort_order) VALUES (?,?,?,?,?,?,?)`)
    .run(id, "swipe", title.trim(), (description||"").trim(), (platform||"generic").toLowerCase(), content, parseInt(sort_order)||0);
  res.json({ success: true, id });
});

// POST /api/marketing/admin/banner — upload image
router.post("/admin/banner", adminOnly, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  // Magic-byte validation — verify file content actually matches claimed image type
  const { validateUploadedFile } = require("../lib/file-validator");
  const validation = validateUploadedFile(req.file.path, "image");
  if (!validation.valid) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(400).json({ error: "Invalid image: " + validation.reason });
  }

  const db = getDb();
  ensureTable(db);
  const { title, description, dimensions, platform, sort_order } = req.body;
  if (!title) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: "title required" }); }
  const id = crypto.randomBytes(8).toString("hex");
  const publicUrl = "/uploads/marketing/" + req.file.filename;
  db.prepare(`INSERT INTO marketing_materials (id, type, title, description, platform, file_url, file_size, dimensions, thumbnail_url, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, "banner", title.trim(), (description||"").trim(), (platform||"generic").toLowerCase(), publicUrl, req.file.size, dimensions||"", publicUrl, parseInt(sort_order)||0);
  res.json({ success: true, id, url: publicUrl });
});

// PUT /api/marketing/admin/:id — edit metadata (not file)
router.put("/admin/:id", adminOnly, (req, res) => {
  const db = getDb();
  ensureTable(db);
  const { title, description, platform, content, sort_order, active } = req.body;
  const existing = db.prepare("SELECT * FROM marketing_materials WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const fields = [], vals = [];
  if (title !== undefined)       { fields.push("title = ?");       vals.push(title); }
  if (description !== undefined) { fields.push("description = ?"); vals.push(description); }
  if (platform !== undefined)    { fields.push("platform = ?");    vals.push((platform||"").toLowerCase()); }
  if (content !== undefined)     { fields.push("content = ?");     vals.push(content); }
  if (sort_order !== undefined)  { fields.push("sort_order = ?");  vals.push(parseInt(sort_order)||0); }
  if (active !== undefined)      { fields.push("active = ?");      vals.push(active ? 1 : 0); }
  if (!fields.length) return res.status(400).json({ error: "No changes" });
  fields.push("updated_at = datetime('now')");
  vals.push(req.params.id);
  db.prepare(`UPDATE marketing_materials SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
  res.json({ success: true });
});

// DELETE /api/marketing/admin/:id — remove (also deletes file if banner)
router.delete("/admin/:id", adminOnly, (req, res) => {
  const db = getDb();
  ensureTable(db);
  const row = db.prepare("SELECT * FROM marketing_materials WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Not found" });
  if (row.file_url && row.file_url.startsWith("/uploads/marketing/")) {
    try { fs.unlinkSync(path.join(__dirname, "..", row.file_url)); } catch (e) {}
  }
  db.prepare("DELETE FROM marketing_materials WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// GET /api/marketing/admin/all — list everything including inactive
router.get("/admin/all", adminOnly, (req, res) => {
  const db = getDb();
  ensureTable(db);
  const rows = db.prepare("SELECT * FROM marketing_materials ORDER BY type, sort_order, created_at DESC").all();
  res.json({ success: true, materials: rows });
});

module.exports = router;
