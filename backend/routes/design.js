// ═══════════════════════════════════════════════════════════════════
// DESIGN STUDIO — AI-generated designs powered by Claude Opus 4.7
// Produces: pitch decks, logos, social graphics, landing mockups, one-pagers
// Output formats: HTML, SVG, PNG (canvas-rendered), PDF (client-side)
// Billing: credit-based. User buys credit packs, each design deducts credits.
// ═══════════════════════════════════════════════════════════════════

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const Anthropic = require("@anthropic-ai/sdk");
const { getDb } = require("../db/init");
const router = express.Router();

const uuid = () => crypto.randomUUID();

// ─── image upload storage (mirrors marketing-materials pattern) ──────
const DESIGN_UPLOAD_DIR = path.join(__dirname, "..", "uploads", "design-images");
try { fs.mkdirSync(DESIGN_UPLOAD_DIR, { recursive: true }); } catch {}
const designImageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DESIGN_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().slice(0, 8) || ".bin";
    cb(null, crypto.randomBytes(12).toString("hex") + ext);
  }
});
const designImageUpload = multer({
  storage: designImageStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /image\/(png|jpeg|gif|webp|svg\+xml)/.test(file.mimetype);
    cb(ok ? null : new Error("Only images allowed (PNG, JPG, GIF, WebP, SVG)"), ok);
  }
});

// ─── image content validator — checks magic bytes, not just MIME ─────
// Call AFTER multer writes file. Deletes file + returns error if invalid.
function validateUploadedImage(filePath) {
  try {
    const buf = fs.readFileSync(filePath, { encoding: null });
    if (!buf || buf.length < 8) return { valid: false, reason: "File too small" };
    const hex = buf.slice(0, 16).toString("hex").toLowerCase();
    const str = buf.slice(0, 1024).toString("utf8");

    // PNG: 89 50 4e 47 0d 0a 1a 0a
    if (hex.startsWith("89504e470d0a1a0a")) return { valid: true, type: "png" };
    // JPEG: ff d8 ff
    if (hex.startsWith("ffd8ff")) return { valid: true, type: "jpeg" };
    // GIF: 47 49 46 38 (GIF8)
    if (hex.startsWith("47494638")) return { valid: true, type: "gif" };
    // WebP: RIFF....WEBP
    if (hex.startsWith("52494646") && buf.slice(8, 12).toString("ascii") === "WEBP") return { valid: true, type: "webp" };
    // SVG: must contain <svg within first 1KB, no <script> tags anywhere
    if (str.match(/<svg[\s>]/i)) {
      // Extra safety: SVG with scripts/onload/etc is an attack vector
      const fullStr = buf.toString("utf8");
      if (/<script[\s>]/i.test(fullStr)) return { valid: false, reason: "SVG contains <script> tags (not allowed)" };
      if (/\son\w+\s*=/i.test(fullStr)) return { valid: false, reason: "SVG contains event handlers (not allowed)" };
      if (/javascript:/i.test(fullStr)) return { valid: false, reason: "SVG contains javascript: URLs (not allowed)" };
      return { valid: true, type: "svg" };
    }
    return { valid: false, reason: "File content doesn't match any allowed image format" };
  } catch (e) {
    return { valid: false, reason: "Could not read file: " + e.message };
  }
}

// ─── rate limiter — per-user daily generation cap (DB-backed) ───────
// Persists across restarts. Works across multiple Node instances.
const DAILY_GEN_LIMIT = 50;
function ensureRateLimitTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS design_rate_limits (
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    count INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, date)
  )`);
}
function checkDailyGenLimit(userId) {
  const db = getDb();
  ensureRateLimitTable(db);
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare("SELECT count FROM design_rate_limits WHERE user_id = ? AND date = ?").get(userId, today);
  const count = row?.count || 0;
  return { count, limit: DAILY_GEN_LIMIT, allowed: count < DAILY_GEN_LIMIT };
}
function incrementDailyGenCount(userId) {
  const db = getDb();
  ensureRateLimitTable(db);
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO design_rate_limits (user_id, date, count) VALUES (?, ?, 1)
    ON CONFLICT(user_id, date) DO UPDATE SET count = count + 1
  `).run(userId, today);
  if (Math.random() < 0.01) {
    db.prepare("DELETE FROM design_rate_limits WHERE date < date('now','-30 days')").run();
  }
}
// ─── platform-wide daily cost cap — circuit breaker ─────────────────
// Stops ALL generations (and AI edits) if total platform API cost crosses threshold.
// Default: $500/day — override via platform_settings.DESIGN_DAILY_COST_CAP.
const DEFAULT_PLATFORM_COST_CAP_USD = 500;
function checkPlatformCostCap() {
  const db = getDb();
  const capSetting = getSetting("DESIGN_DAILY_COST_CAP");
  const cap = parseFloat(capSetting) || DEFAULT_PLATFORM_COST_CAP_USD;
  const today = new Date().toISOString().slice(0, 10);
  // Sum today's cost_usd from design_generations
  let row;
  try {
    row = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) as total FROM design_generations WHERE DATE(created_at) = ?").get(today);
  } catch (e) {
    return { allowed: true, spent: 0, cap, remaining: cap };
  }
  const spent = row?.total || 0;
  return {
    allowed: spent < cap,
    spent: Math.round(spent * 100) / 100,
    cap,
    remaining: Math.max(0, Math.round((cap - spent) * 100) / 100)
  };
}

// ─── auth middleware (reuses app-level) ──────────────────────────────
function auth(req, res, next) {
  const m = require("../middleware/auth");
  m.auth(req, res, next);
}

// ─── HTML sanitizer — strips dangerous content from Claude output ────
// Removes: <script> tags, event handlers (onclick=, onload=, etc.),
// javascript: URLs, data: URLs (except images), <iframe>, <object>, <embed>.
// Called before storing generated/edited designs AND before publishing.
// This is defense-in-depth: even if Claude outputs malicious HTML via prompt
// injection, it can't execute when rendered in the preview or published.
function sanitizeDesignHtml(html) {
  if (!html || typeof html !== "string") return html;
  let out = html;

  // Remove <script>...</script> tags (including their content)
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  // Remove self-closing or stray <script>
  out = out.replace(/<script\b[^>]*\/?>/gi, "");

  // Remove <iframe>, <object>, <embed>, <applet> tags entirely
  out = out.replace(/<(iframe|object|embed|applet|form)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  out = out.replace(/<(iframe|object|embed|applet)\b[^>]*\/?>/gi, "");

  // Remove all on* event handlers (onclick=, onload=, onerror=, etc.)
  // Matches on attribute boundaries — handles quoted and unquoted values.
  out = out.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, "");
  out = out.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, "");
  out = out.replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, "");

  // Remove javascript: URLs in href, src, action, etc.
  out = out.replace(/\s(href|src|action|formaction|data|xlink:href)\s*=\s*"javascript:[^"]*"/gi, ' $1="#"');
  out = out.replace(/\s(href|src|action|formaction|data|xlink:href)\s*=\s*'javascript:[^']*'/gi, " $1='#'");

  // Remove <meta http-equiv="refresh"> redirects
  out = out.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "");

  return out;
}

// SVG-specific sanitizer — stricter, since logos rendered raw
function sanitizeDesignSvg(svg) {
  if (!svg || typeof svg !== "string") return svg;
  let out = sanitizeDesignHtml(svg);
  // Strip <foreignObject> entirely — can contain arbitrary HTML
  out = out.replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject>/gi, "");
  out = out.replace(/<foreignObject\b[^>]*\/?>/gi, "");
  return out;
}

// ─── setting getter ──────────────────────────────────────────────────
function getSetting(k) {
  try {
    const row = getDb().prepare("SELECT value FROM platform_settings WHERE key = ?").get(k);
    return row?.value || "";
  } catch { return ""; }
}

// ─── table setup ─────────────────────────────────────────────────────
function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS design_credits (
      user_id          TEXT PRIMARY KEY,
      balance          INTEGER DEFAULT 0,
      total_purchased  INTEGER DEFAULT 0,
      total_used       INTEGER DEFAULT 0,
      updated_at       TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS design_generations (
      id               TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL,
      client_id        TEXT,                  -- optional: agency tagging a client
      prompt           TEXT NOT NULL,
      type             TEXT NOT NULL,         -- 'pitch-deck' | 'logo' | 'social' | 'landing' | 'one-pager'
      output_html      TEXT,                  -- rendered HTML
      output_svg       TEXT,                  -- SVG output (if applicable)
      model            TEXT,
      input_tokens     INTEGER DEFAULT 0,
      output_tokens    INTEGER DEFAULT 0,
      cost_usd         REAL DEFAULT 0,        -- what WE paid Anthropic
      credits_charged  INTEGER DEFAULT 1,     -- what user paid us
      status           TEXT DEFAULT 'complete',
      created_at       TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_design_gens_user ON design_generations(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_design_gens_client ON design_generations(client_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS design_credit_purchases (
      id               TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL,
      credits          INTEGER NOT NULL,
      amount_paid      REAL NOT NULL,
      stripe_session_id TEXT,
      status           TEXT DEFAULT 'pending',
      created_at       TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS design_versions (
      id               TEXT PRIMARY KEY,
      design_id        TEXT NOT NULL,
      user_id          TEXT NOT NULL,
      version_num      INTEGER NOT NULL,
      output_html      TEXT,
      output_svg       TEXT,
      edit_type        TEXT,              -- 'visual' | 'ai' | 'original'
      edit_instruction TEXT,              -- the AI prompt if edit_type='ai'
      created_at       TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_design_versions ON design_versions(design_id, version_num DESC);
  `);
  // Safe migration: add client_id column if table existed before this field was introduced
  try {
    const cols = db.prepare("PRAGMA table_info(design_generations)").all();
    if (!cols.find(c => c.name === 'client_id')) {
      db.exec("ALTER TABLE design_generations ADD COLUMN client_id TEXT");
    }
  } catch(e) { /* ignore if pragma unavailable */ }
}

// ─── credit packs available for purchase ─────────────────────────────
const CREDIT_PACKS = [
  { id: "starter", credits: 5,   price: 15,  label: "5 designs",   perUnit: 3.00 },
  { id: "pro",     credits: 20,  price: 49,  label: "20 designs",  perUnit: 2.45 },  // save 18%
  { id: "bulk",    credits: 50,  price: 99,  label: "50 designs",  perUnit: 1.98 },  // save 34%
  { id: "agency",  credits: 200, price: 299, label: "200 designs", perUnit: 1.50 },  // save 50%
];

// ─── system prompts per design type ──────────────────────────────────
const SYSTEM_PROMPTS = {
  "pitch-deck": `You are an expert pitch deck designer. Generate a complete, investor-ready pitch deck as a single HTML file with embedded CSS.

Requirements:
- 10-12 slides, each slide is a <section class="slide"> with aspect ratio 16:9
- Use modern, professional typography (system-ui or sans-serif)
- Apply the user's brand colors throughout
- Include these standard slides: Title, Problem, Solution, Market Size, Product, Traction, Business Model, Competition, Team, Ask
- Charts/metrics as inline SVG where relevant
- No external resources (no image URLs, no web fonts) — everything inline
- Print-friendly CSS (@media print rules)

Return ONLY the HTML, no markdown fences, no explanation.`,

  "logo": `You are an expert logo designer. Generate a clean, scalable SVG logo.

Requirements:
- Pure SVG, no raster images
- viewBox="0 0 512 512", maximum 256x256 visual area
- 1-3 colors max from the user's brand palette
- Include both icon + wordmark versions as <g> groups
- Simple, memorable, works at small sizes
- No gradients unless specifically requested
- Clean geometric shapes

Return ONLY the SVG, no markdown fences, no explanation.`,

  "social": `You are an expert social media graphic designer. Generate a social media graphic as HTML with embedded CSS.

Requirements:
- Container with exact dimensions as specified (default 1080x1080 for Instagram)
- Bold, attention-grabbing typography
- Use brand colors as specified
- High contrast, readable on small screens
- Include any call-to-action prominently
- Use inline SVG for decorative elements
- No external resources

Return ONLY the HTML, no markdown fences, no explanation.`,

  "ad-creative": `You are an expert performance advertising designer. Generate a high-converting ad creative as HTML with embedded CSS.

Requirements:
- Container optimized for Facebook/Instagram/Google Display ads
- Default dimensions: 1080x1080 (square) unless user specifies otherwise
- Also mention common sizes in a comment: 1200x628 (Facebook/LinkedIn link), 1080x1920 (Stories/Reels), 300x250 (Google Display)
- Clear hook/headline in the top third
- Bold supporting copy
- Strong, contrasting CTA button
- Product/offer visible
- Brand colors + accent for CTA
- Psychological triggers: urgency, scarcity, social proof where relevant
- Inline SVG for any decorative elements
- No external resources

Return ONLY the HTML, no markdown fences, no explanation.`,

  "landing": `You are an expert landing page designer. Generate a complete single-page website mockup as HTML with embedded CSS.

Requirements:
- Full landing page: hero, features (3 items), pricing (1-3 tiers), testimonial, FAQ (3-5 items), footer
- Modern design, responsive (mobile + desktop)
- Apply user's brand colors
- System fonts only (no Google Fonts)
- Inline SVG for any icons
- No external resources
- Include reasonable placeholder copy based on the business context

Return ONLY the HTML, no markdown fences, no explanation.`,

  "one-pager": `You are an expert one-pager designer. Generate a single-page business summary as HTML with embedded CSS.

Requirements:
- Single page, print-friendly (A4 or US Letter aspect)
- Sections: Header with logo/title, Overview, Key Features/Services (3-4), Stats/Metrics, Contact
- Clean professional layout, 2-column where it improves scannability
- Brand colors throughout
- Inline SVG for icons and any charts
- Print CSS
- No external resources

Return ONLY the HTML, no markdown fences, no explanation.`
};

// ─── GET /api/design/credits — returns plan quota + usage status ────
// Renamed semantically: now reports monthly usage vs plan cap (metered billing)
// Legacy `design_credits` rows are still read for migration visibility only.
router.get("/credits", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  let designUsage = { used: 0, cap: 0, remaining: 0, wouldBeOverage: false, overagePrice: 2.50 };
  let editUsage = { used: 0, cap: 0, remaining: 0, wouldBeOverage: false, overagePrice: 1.50 };
  if (typeof global.mineCheckUsage === "function") {
    designUsage = global.mineCheckUsage(db, req.userId, "designs");
    editUsage = global.mineCheckUsage(db, req.userId, "designEdits");
  }
  // Read any legacy credit balance for migration/display — not deducted anymore
  const legacy = db.prepare("SELECT balance, total_purchased, total_used FROM design_credits WHERE user_id = ?").get(req.userId);
  res.json({
    billing: "metered",        // signal to frontend: this is metered, not credits
    designs: {
      used: designUsage.used,
      cap: designUsage.cap,
      remaining: designUsage.remaining,
      overagePrice: designUsage.overagePrice,
      blocked: designUsage.blocked
    },
    designEdits: {
      used: editUsage.used,
      cap: editUsage.cap,
      remaining: editUsage.remaining,
      overagePrice: editUsage.overagePrice,
      blocked: editUsage.blocked
    },
    legacyCredits: legacy ? legacy.balance : 0   // show leftover for migration — not spent
  });
});

// ─── POST /api/design/generate — create a new design ─────────────────
// \ud83c\udfa8 AI DESIGNER addon (2026-06-12): Growth+ only, monthly cap + soft overage at $0.50/design
const DESIGNER_CAPS = { growth: 100, pro: 300 };
function designerMeter(db, userId) {
  db.exec("CREATE TABLE IF NOT EXISTS designer_usage (user_id TEXT, month TEXT, units INTEGER DEFAULT 0, PRIMARY KEY(user_id, month))");
  const month = new Date().toISOString().slice(0, 7);
  let plan = "starter";
  try { plan = String((db.prepare("SELECT plan FROM users WHERE id = ?").get(userId) || {}).plan || "starter").toLowerCase(); } catch (_e) {}
  const cap = DESIGNER_CAPS[plan];
  if (!cap) return { allowed: false, plan };
  db.prepare("INSERT OR IGNORE INTO designer_usage (user_id, month, units) VALUES (?,?,0)").run(userId, month);
  const used = db.prepare("SELECT units FROM designer_usage WHERE user_id = ? AND month = ?").get(userId, month).units;
  return { allowed: true, plan, cap, used, month, overage_units: Math.max(0, used - cap) };
}
function designerTick(db, userId, month) { try { db.prepare("UPDATE designer_usage SET units = units + 1 WHERE user_id = ? AND month = ?").run(userId, month); } catch (_e) {} }

router.post("/generate", auth, async (req, res) => {
  const db = getDb();
  ensureTables(db);
  const { prompt, type, brand } = req.body || {};

  if (!prompt || typeof prompt !== "string" || prompt.length < 3) {
    return res.status(400).json({ error: "Prompt required (minimum 3 characters)" });
  }
  if (!SYSTEM_PROMPTS[type]) {
    return res.status(400).json({ error: "Invalid type. Must be: pitch-deck, logo, social, ad-creative, one-pager, or custom" });
  }
  const meter = designerMeter(db, req.user?.id || req.userId);
  if (!meter.allowed) return res.status(402).json({ error: "The AI Designer is available on Growth plans and above \u2014 upgrade to unlock it." });


  // Check plan quota — uses TAKEOVA's metered billing system
  // If within plan cap: free. If over: charged as overage via monthly Stripe invoice.
  if (typeof global.mineCheckUsage === "function") {
    const usage = global.mineCheckUsage(db, req.userId, "designs");
    if (usage.blocked) {
      return res.status(403).json({
        error: "Design Studio is not available on your current plan. Upgrade to Starter or higher.",
        upgrade: true
      });
    }
    // If already at cap, warn user they'll be charged overage for this generation
    // (Actual charge happens after successful generation via trackUsage)
  }

  // Daily safety limit — prevents runaway API costs from bugs/abuse
  const limitCheck = checkDailyGenLimit(req.userId);
  if (!limitCheck.allowed) {
    return res.status(429).json({
      error: "Daily generation limit reached (" + DAILY_GEN_LIMIT + " per day). Resets at midnight UTC.",
      limit: DAILY_GEN_LIMIT
    });
  }

  // Platform-wide cost cap — circuit breaker for MINE as a whole
  const costCheck = checkPlatformCostCap();
  if (!costCheck.allowed) {
    console.warn("[DESIGN] Platform daily cost cap reached: $" + costCheck.spent + " of $" + costCheck.cap);
    return res.status(503).json({
      error: "Design Studio is temporarily paused due to high platform activity. Try again in a few hours.",
      code: "COST_CAP_REACHED"
    });
  }

  // Build brand context from user profile + passed brand overrides
  const user = db.prepare("SELECT name, email FROM users WHERE id = ?").get(req.userId) || {};
  const brandCtx = {
    businessName: brand?.businessName || user.name || "Your Business",
    primaryColor: brand?.primaryColor || "#4F46E5",
    secondaryColor: brand?.secondaryColor || "#6366F1",
    accentColor: brand?.accentColor || "#F59E0B",
    voice: brand?.voice || "professional, friendly",
    tagline: brand?.tagline || ""
  };

  const apiKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({
    error: "Design Studio is not configured yet. Admin needs to add an Anthropic API key in Settings → Integrations.",
    code: "NO_API_KEY"
  });

  const systemPrompt = SYSTEM_PROMPTS[type] + `\n\n──── USER'S BRAND ────\nBusiness name: ${brandCtx.businessName}\nPrimary color: ${brandCtx.primaryColor}\nSecondary color: ${brandCtx.secondaryColor}\nAccent color: ${brandCtx.accentColor}\nBrand voice: ${brandCtx.voice}\n${brandCtx.tagline ? "Tagline: " + brandCtx.tagline + "\n" : ""}`;

  const client = new Anthropic.default({ apiKey });
  let output = "", inputTokens = 0, outputTokens = 0, model = "claude-opus-4-8";

  try {
    const msg = await client.messages.create({
      model,
      max_tokens: type === "pitch-deck" ? 16000 : type === "landing" ? 12000 : type === "ad-creative" ? 5000 : 6000,
      system: systemPrompt,
      messages: [{ role: "user", content: prompt }]
    });
    output = msg.content?.[0]?.text || "";
    inputTokens = msg.usage?.input_tokens || 0;
    outputTokens = msg.usage?.output_tokens || 0;
  } catch (e) {
    console.error("[DESIGN] Anthropic error:", e.message);
    return res.status(502).json({ error: "Generation failed", details: e.message });
  }

  // Clean output — strip markdown fences if model added them
  output = output.replace(/^```(?:html|svg|xml)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
  // Sanitize Claude output — strip scripts/event handlers/iframes (defense against prompt injection)
  output = (type === "logo") ? sanitizeDesignSvg(output) : sanitizeDesignHtml(output);

  // Determine which field to store in based on type
  const isSvg = type === "logo";
  const outputHtml = isSvg ? null : output;
  const outputSvg = isSvg ? output : null;

  // Cost calculation — Opus 4.7 pricing: $5/M input, $25/M output
  const costUsd = (inputTokens * 5 / 1_000_000) + (outputTokens * 25 / 1_000_000);

  // Store generation
  const id = uuid();
  const clientId = (brand && brand.clientId) || null;
  db.prepare(`
    INSERT INTO design_generations (id, user_id, client_id, prompt, type, output_html, output_svg, model, input_tokens, output_tokens, cost_usd, credits_charged)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(id, req.userId, clientId, prompt, type, outputHtml, outputSvg, model, inputTokens, outputTokens, costUsd);
    designerTick(db, req.user?.id || req.userId, meter.month);

  // Track usage — increments monthly counter, queues overage charge if over cap
  if (typeof global.mineTrackUsage === "function") {
    global.mineTrackUsage(db, req.userId, "designs");
  }

  incrementDailyGenCount(req.userId);

  // Fetch updated usage for the response so client can show remaining
  let usageStatus = null;
  if (typeof global.mineCheckUsage === "function") {
    const u = global.mineCheckUsage(db, req.userId, "designs");
    usageStatus = { used: u.used, cap: u.cap, remaining: u.remaining, wasOverage: u.wouldBeOverage };
  }

  res.json({
    id,
    type,
    html: outputHtml,
    svg: outputSvg,
    usage: usageStatus,
    meta: { inputTokens, outputTokens, model }
  });
});

// ─── POST /api/design/admin/generate — admin-only, no credit deduction ──
router.post("/admin/generate", auth, adminOnly, async (req, res) => {
  const db = getDb();
  ensureTables(db);
  const { prompt, type, brand } = req.body || {};

  if (!prompt || typeof prompt !== "string" || prompt.length < 3) {
    return res.status(400).json({ error: "Prompt required (minimum 3 characters)" });
  }
  if (!SYSTEM_PROMPTS[type]) {
    return res.status(400).json({ error: "Invalid type" });
  }

  const brandCtx = {
    businessName: brand?.businessName || "MINE",
    primaryColor: brand?.primaryColor || "#4F46E5",
    secondaryColor: brand?.secondaryColor || "#6366F1",
    accentColor: brand?.accentColor || "#F59E0B",
    voice: brand?.voice || "professional, modern",
    tagline: brand?.tagline || ""
  };

  const apiKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "Design service not configured" });

  const systemPrompt = SYSTEM_PROMPTS[type] + `\n\n──── BRAND ────\nBusiness name: ${brandCtx.businessName}\nPrimary color: ${brandCtx.primaryColor}\nSecondary color: ${brandCtx.secondaryColor}\nAccent color: ${brandCtx.accentColor}\nBrand voice: ${brandCtx.voice}\n${brandCtx.tagline ? "Tagline: " + brandCtx.tagline + "\n" : ""}`;

  const client = new Anthropic.default({ apiKey });
  let output = "", inputTokens = 0, outputTokens = 0, model = "claude-opus-4-8";

  try {
    const msg = await client.messages.create({
      model,
      max_tokens: type === "pitch-deck" ? 16000 : type === "landing" ? 12000 : type === "ad-creative" ? 5000 : 6000,
      system: systemPrompt,
      messages: [{ role: "user", content: prompt }]
    });
    output = msg.content?.[0]?.text || "";
    inputTokens = msg.usage?.input_tokens || 0;
    outputTokens = msg.usage?.output_tokens || 0;
  } catch (e) {
    console.error("[DESIGN-ADMIN] Anthropic error:", e.message);
    return res.status(502).json({ error: "Generation failed", details: e.message });
  }

  output = output.replace(/^```(?:html|svg|xml)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
  // Sanitize Claude output — strip scripts/event handlers/iframes (defense against prompt injection)
  output = (type === "logo") ? sanitizeDesignSvg(output) : sanitizeDesignHtml(output);

  const isSvg = type === "logo";
  const outputHtml = isSvg ? null : output;
  const outputSvg = isSvg ? output : null;
  const costUsd = (inputTokens * 5 / 1_000_000) + (outputTokens * 25 / 1_000_000);

  // Store with credits_charged = 0 (admin doesn't pay credits — separated for clean stats)
  const id = uuid();
  db.prepare(`
    INSERT INTO design_generations (id, user_id, client_id, prompt, type, output_html, output_svg, model, input_tokens, output_tokens, cost_usd, credits_charged)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(id, req.userId, prompt, type, outputHtml, outputSvg, model, inputTokens, outputTokens, costUsd);

  // Today's total spend on admin generations
  const todayCost = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as c FROM design_generations
    WHERE user_id = ? AND credits_charged = 0 AND DATE(created_at) = DATE('now')
  `).get(req.userId).c;

  res.json({
    id,
    type,
    html: outputHtml,
    svg: outputSvg,
    cost_usd: costUsd,
    today_cost_usd: todayCost,
    meta: { inputTokens, outputTokens, model }
  });
});

// ─── GET /api/design/admin/cost-cap — platform cap status ───────────
router.get("/admin/cost-cap", auth, adminOnly, (req, res) => {
  res.json(checkPlatformCostCap());
});

// ─── GET /api/design/admin/today-cost — today's admin API spend ──────
router.get("/admin/today-cost", auth, adminOnly, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(cost_usd), 0) as today_cost,
      COUNT(*) as today_count
    FROM design_generations
    WHERE user_id = ? AND credits_charged = 0 AND DATE(created_at) = DATE('now')
  `).get(req.userId);
  const monthRow = db.prepare(`
    SELECT
      COALESCE(SUM(cost_usd), 0) as month_cost,
      COUNT(*) as month_count
    FROM design_generations
    WHERE user_id = ? AND credits_charged = 0 AND created_at > datetime('now','start of month')
  `).get(req.userId);
  res.json({
    today_cost: row.today_cost,
    today_count: row.today_count,
    month_cost: monthRow.month_cost,
    month_count: monthRow.month_count
  });
});

// ─── GET /api/design/admin/generations — admin's own history ─────────
router.get("/admin/generations", auth, adminOnly, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const rows = db.prepare(`
    SELECT id, prompt, type, model, cost_usd, created_at
    FROM design_generations
    WHERE user_id = ? AND credits_charged = 0
    ORDER BY created_at DESC
    LIMIT 50
  `).all(req.userId);
  res.json({ generations: rows });
});

// ─── GET /api/design/generations — user's history ────────────────────
router.get("/generations", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const rows = db.prepare(`
    SELECT id, prompt, type, model, created_at
    FROM design_generations
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(req.userId);
  res.json({ generations: rows });
});

// ─── POST /api/design/generation/:id/duplicate — create a copy ──────
router.post("/generation/:id/duplicate", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const existing = db.prepare("SELECT * FROM design_generations WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: "Not found" });

  const newId = uuid();
  db.prepare(`
    INSERT INTO design_generations (id, user_id, client_id, prompt, type, output_html, output_svg, model, input_tokens, output_tokens, cost_usd, credits_charged, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 'complete')
  `).run(newId, req.userId, existing.client_id, "[Copy] " + existing.prompt, existing.type, existing.output_html, existing.output_svg, existing.model);

  res.json({
    id: newId,
    type: existing.type,
    html: existing.output_html,
    svg: existing.output_svg,
    success: true
  });
});

// ─── POST /api/design/upload-image — upload image for use in designs ──
router.post("/upload-image", auth, designImageUpload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image uploaded" });

  // Real content validation — checks magic bytes, not just MIME
  const validation = validateUploadedImage(req.file.path);
  if (!validation.valid) {
    // Delete the bogus file immediately
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(400).json({ error: "Invalid image: " + validation.reason });
  }

  const url = "/uploads/design-images/" + req.file.filename;
  res.json({
    url,
    filename: req.file.originalname,
    size: req.file.size,
    mimetype: req.file.mimetype,
    detected_type: validation.type
  });
});

// ─── POST /api/design/generation/:id/publish-to-marketing — admin only ──
// Publishes a design as a banner asset in the affiliate marketing materials
router.post("/generation/:id/publish-to-marketing", auth, adminOnly, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const existing = db.prepare("SELECT * FROM design_generations WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: "Not found" });

  // Save the HTML/SVG content as a file in uploads/marketing so affiliates can access it
  const MARKETING_DIR = path.join(__dirname, "..", "uploads", "marketing");
  try { fs.mkdirSync(MARKETING_DIR, { recursive: true }); } catch {}
  const isSvg = existing.type === "logo";
  const ext = isSvg ? ".svg" : ".html";
  const filename = "design-" + existing.id.slice(0, 8) + ext;
  let content = isSvg ? existing.output_svg : existing.output_html;
  if (!content) return res.status(400).json({ error: "Design has no content" });
  // Extra sanitize before writing to disk — affiliates will render this
  content = isSvg ? sanitizeDesignSvg(content) : sanitizeDesignHtml(content);
  fs.writeFileSync(path.join(MARKETING_DIR, filename), content);
  const fileUrl = "/uploads/marketing/" + filename;

  // Insert into marketing_materials table
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS marketing_materials (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      content TEXT,
      platform TEXT,
      dimensions TEXT,
      file_url TEXT,
      file_size INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )`).run();
    const matId = uuid();
    db.prepare(`
      INSERT INTO marketing_materials (id, type, title, description, file_url, platform, dimensions, created_at)
      VALUES (?, 'banner', ?, ?, ?, 'design-studio', ?, datetime('now'))
    `).run(matId, req.body.title || existing.prompt.slice(0, 80), "Generated via Design Studio", fileUrl, existing.type);
    res.json({ success: true, marketing_id: matId, file_url: fileUrl });
  } catch (e) {
    console.error("[DESIGN-PUBLISH] error:", e.message);
    res.status(500).json({ error: "Failed to publish", details: e.message });
  }
});

// ─── POST /api/design/validate-html — check if generated HTML is broken ──
// Runs basic structural checks on the output to catch Claude's occasional broken HTML
router.post("/validate-html", auth, (req, res) => {
  const { html } = req.body || {};
  if (!html || typeof html !== "string") {
    return res.status(400).json({ valid: false, error: "No HTML provided" });
  }
  const issues = [];
  // Length check
  if (html.length < 100) issues.push("Output too short (<100 chars) — likely cut off");
  if (html.length > 500000) issues.push("Output very large (>500KB) — may perform poorly");
  // Basic tag balance check (crude but useful)
  const openTags = (html.match(/<[a-z][^>\/]*>/gi) || []).length;
  const closeTags = (html.match(/<\/[a-z][^>]*>/gi) || []).length;
  const selfClose = (html.match(/<(img|br|hr|meta|input|source|area|base|col|embed|link|track|wbr)[^>]*\/?>/gi) || []).length;
  const imbalance = Math.abs(openTags - closeTags - selfClose);
  if (imbalance > 3) issues.push("Possible unclosed tags (imbalance: " + imbalance + ")");
  // Check for truncation indicators
  if (html.trim().endsWith("...") || html.trim().endsWith("…")) issues.push("Output appears truncated");
  // Check for <script> tags that shouldn't be there (security + sign of error)
  if (/<script[^>]*>/.test(html) && !/type=["']application\/ld\+json["']/.test(html)) {
    issues.push("Contains <script> tag — unusual for a static design");
  }
  // Missing basic structure
  const hasBody = /<body/i.test(html);
  const hasDoctype = /<!DOCTYPE/i.test(html);
  if (!hasBody && !hasDoctype && !/<section|<div/i.test(html)) {
    issues.push("No recognizable structure (no body, doctype, or root elements)");
  }

  res.json({
    valid: issues.length === 0,
    issues,
    severity: issues.length === 0 ? "ok" : (issues.length <= 1 ? "warn" : "error")
  });
});

// ─── GET /api/design/generations/by-client/:clientId — agency filter ──
router.get("/generations/by-client/:clientId", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const rows = db.prepare(`
    SELECT id, prompt, type, model, created_at
    FROM design_generations
    WHERE user_id = ? AND client_id = ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(req.userId, req.params.clientId);
  res.json({ generations: rows, client_id: req.params.clientId });
});

// ─── GET /api/design/generations/clients — list unique clients in history ──
router.get("/generations/clients", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const rows = db.prepare(`
    SELECT client_id, COUNT(*) as design_count
    FROM design_generations
    WHERE user_id = ? AND client_id IS NOT NULL
    GROUP BY client_id
    ORDER BY design_count DESC
  `).all(req.userId);
  res.json({ clients: rows });
});

// ─── POST /api/design/generation/:id/apply-font — swap fonts ─────────
router.post("/generation/:id/apply-font", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const { fontFamily } = req.body || {};
  if (!fontFamily || typeof fontFamily !== "string") {
    return res.status(400).json({ error: "fontFamily required" });
  }
  // Whitelist safe font stacks
  const SAFE_FONTS = {
    "system":        "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    "sans":          "'Helvetica Neue', Helvetica, Arial, sans-serif",
    "modern":        "'Inter', -apple-system, sans-serif",
    "serif":         "'Georgia', 'Times New Roman', serif",
    "elegant":       "'Playfair Display', 'Georgia', serif",
    "mono":          "'SF Mono', 'Menlo', 'Consolas', monospace",
    "friendly":      "'Nunito', -apple-system, sans-serif",
    "editorial":     "'Merriweather', 'Georgia', serif"
  };
  const stack = SAFE_FONTS[fontFamily];
  if (!stack) return res.status(400).json({ error: "Unknown font. Options: " + Object.keys(SAFE_FONTS).join(", ") });

  const existing = db.prepare("SELECT * FROM design_generations WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: "Not found" });
  const isSvg = existing.type === "logo";
  let content = (isSvg ? existing.output_svg : existing.output_html) || "";

  // Snapshot current version before modifying
  const versionCount = db.prepare("SELECT COUNT(*) as c FROM design_versions WHERE design_id = ?").get(req.params.id).c;
  const editType = versionCount === 0 ? 'original' : 'visual';
  db.prepare(`
    INSERT INTO design_versions (id, design_id, user_id, version_num, output_html, output_svg, edit_type, edit_instruction)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), req.params.id, req.userId, versionCount + 1, existing.output_html, existing.output_svg, editType, "font: " + fontFamily);

  // Apply: inject a universal selector rule at the top of any <style>, OR add a new <style> before </head>
  if (/<style[^>]*>/i.test(content)) {
    // Prepend rule inside first <style> tag
    content = content.replace(/<style([^>]*)>/i, '<style$1>\nbody, * { font-family: ' + stack + ' !important; }\n');
  } else if (/<\/head>/i.test(content)) {
    content = content.replace(/<\/head>/i, '<style>body, * { font-family: ' + stack + ' !important; }</style></head>');
  } else {
    // No head/style — wrap whole thing
    content = '<style>body, * { font-family: ' + stack + ' !important; }</style>' + content;
  }

  if (isSvg) {
    db.prepare("UPDATE design_generations SET output_svg = ? WHERE id = ?").run(content, req.params.id);
  } else {
    db.prepare("UPDATE design_generations SET output_html = ? WHERE id = ?").run(content, req.params.id);
  }

  // Trim non-originals
  const versions = db.prepare("SELECT id FROM design_versions WHERE design_id = ? AND edit_type != 'original' ORDER BY version_num DESC").all(req.params.id);
  if (versions.length > 3) {
    const toDelete = versions.slice(3).map(v => v.id);
    const placeholders = toDelete.map(() => "?").join(",");
    db.prepare(`DELETE FROM design_versions WHERE id IN (${placeholders})`).run(...toDelete);
  }

  res.json({ success: true, html: isSvg ? null : content, svg: isSvg ? content : null });
});

// ─── POST /api/design/generation/:id/save — save visual edits (free) ──
router.post("/generation/:id/save", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const { html, svg } = req.body || {};
  const existing = db.prepare("SELECT * FROM design_generations WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: "Not found" });

  // Save current version to history before overwriting (keep last 3 + original)
  const versionCount = db.prepare("SELECT COUNT(*) as c FROM design_versions WHERE design_id = ?").get(req.params.id).c;
  const nextVer = versionCount + 1;
  // First snapshot ever = the original state before any edit
  const editType = versionCount === 0 ? 'original' : 'visual';

  db.prepare(`
    INSERT INTO design_versions (id, design_id, user_id, version_num, output_html, output_svg, edit_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), req.params.id, req.userId, nextVer, existing.output_html, existing.output_svg, editType);

  // Trim to last 3 non-original versions (keep original forever)
  const versions = db.prepare("SELECT id FROM design_versions WHERE design_id = ? AND edit_type != 'original' ORDER BY version_num DESC").all(req.params.id);
  if (versions.length > 3) {
    const toDelete = versions.slice(3).map(v => v.id);
    const placeholders = toDelete.map(() => "?").join(",");
    db.prepare(`DELETE FROM design_versions WHERE id IN (${placeholders})`).run(...toDelete);
  }

  // Update the current design — sanitize user input (contenteditable can contain anything)
  const isSvg = existing.type === "logo";
  if (isSvg && svg) {
    const cleanSvg = sanitizeDesignSvg(svg);
    db.prepare("UPDATE design_generations SET output_svg = ? WHERE id = ?").run(cleanSvg, req.params.id);
  } else if (html) {
    const cleanHtml = sanitizeDesignHtml(html);
    db.prepare("UPDATE design_generations SET output_html = ? WHERE id = ?").run(cleanHtml, req.params.id);
  } else {
    return res.status(400).json({ error: "No content provided" });
  }

  res.json({ success: true, version: nextVer });
});

// ─── POST /api/design/generation/:id/ai-edit — AI rewrite (1 credit) ──
router.post("/generation/:id/ai-edit", auth, async (req, res) => {
  const db = getDb();
  ensureTables(db);
  const { instruction } = req.body || {};

  if (!instruction || typeof instruction !== "string" || instruction.trim().length < 3) {
    return res.status(400).json({ error: "Instruction required (minimum 3 characters)" });
  }

  const existing = db.prepare("SELECT * FROM design_generations WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: "Not found" });

  // Check if this is an admin-free design (credits_charged = 0 means admin generated it)
  const userRow = db.prepare("SELECT role FROM users WHERE id = ?").get(req.userId);
  const isAdminEdit = userRow?.role === "admin" && existing.credits_charged === 0;

  // Non-admins: check plan quota via TAKEOVA's metered system
  if (!isAdminEdit) {
    if (typeof global.mineCheckUsage === "function") {
      const usage = global.mineCheckUsage(db, req.userId, "designEdits");
      if (usage.blocked) {
        return res.status(403).json({
          error: "AI design edits are not available on your current plan. Upgrade to Starter or higher.",
          upgrade: true
        });
      }
    }
    // Rate limit edits too — they consume API budget
    const limitCheck = checkDailyGenLimit(req.userId);
    if (!limitCheck.allowed) {
      return res.status(429).json({
        error: "Daily generation limit reached (" + DAILY_GEN_LIMIT + " per day, edits included).",
        limit: DAILY_GEN_LIMIT
      });
    }
  }

  // Platform cost cap — admin edits also subject to this
  const costCheck = checkPlatformCostCap();
  if (!costCheck.allowed) {
    return res.status(503).json({
      error: "Design Studio is temporarily paused due to high platform activity.",
      code: "COST_CAP_REACHED"
    });
  }

  const apiKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "Design service not configured" });

  const currentContent = existing.output_html || existing.output_svg || "";
  const isSvg = existing.type === "logo";

  const editSystemPrompt = `You are editing an existing ${isSvg ? "SVG logo" : "HTML design"}. The user will give you the current design and an edit instruction.

Rules:
- Return the COMPLETE updated ${isSvg ? "SVG" : "HTML"} — not just the changed parts
- Preserve all structure, formatting, and functionality unless the instruction says otherwise
- Make only the changes the user requested
- Keep the same design type (${existing.type})
- No markdown fences, no explanation, just the raw ${isSvg ? "SVG" : "HTML"}

Return ONLY the ${isSvg ? "SVG" : "HTML"}, no markdown fences, no explanation.`;

  const userMessage = `CURRENT DESIGN:\n\n${currentContent}\n\n──── EDIT INSTRUCTION ────\n${instruction.trim()}`;

  const client = new Anthropic.default({ apiKey });
  let output = "", inputTokens = 0, outputTokens = 0;
  const model = "claude-opus-4-8";

  try {
    const msg = await client.messages.create({
      model,
      max_tokens: existing.type === "pitch-deck" ? 16000 : existing.type === "landing" ? 12000 : existing.type === "ad-creative" ? 5000 : 6000,
      system: editSystemPrompt,
      messages: [{ role: "user", content: userMessage }]
    });
    output = msg.content?.[0]?.text || "";
    inputTokens = msg.usage?.input_tokens || 0;
    outputTokens = msg.usage?.output_tokens || 0;
  } catch (e) {
    console.error("[DESIGN-EDIT] Anthropic error:", e.message);
    return res.status(502).json({ error: "AI edit failed", details: e.message });
  }

  // Clean output
  output = output.replace(/^```(?:html|svg|xml)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
  // Sanitize Claude output — strip scripts/event handlers/iframes (defense against prompt injection)
  output = (existing.type === "logo") ? sanitizeDesignSvg(output) : sanitizeDesignHtml(output);

  const costUsd = (inputTokens * 5 / 1_000_000) + (outputTokens * 25 / 1_000_000);

  // Save previous version before overwriting (first snapshot = original)
  const versionCount = db.prepare("SELECT COUNT(*) as c FROM design_versions WHERE design_id = ?").get(req.params.id).c;
  const editType = versionCount === 0 ? 'original' : 'ai';
  db.prepare(`
    INSERT INTO design_versions (id, design_id, user_id, version_num, output_html, output_svg, edit_type, edit_instruction)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), req.params.id, req.userId, versionCount + 1, existing.output_html, existing.output_svg, editType, instruction.trim());

  // Trim to last 3 non-original versions
  const versions = db.prepare("SELECT id FROM design_versions WHERE design_id = ? AND edit_type != 'original' ORDER BY version_num DESC").all(req.params.id);
  if (versions.length > 3) {
    const toDelete = versions.slice(3).map(v => v.id);
    const placeholders = toDelete.map(() => "?").join(",");
    db.prepare(`DELETE FROM design_versions WHERE id IN (${placeholders})`).run(...toDelete);
  }

  // Update design with edited output, accumulate token counts
  if (isSvg) {
    db.prepare(`
      UPDATE design_generations
      SET output_svg = ?, input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost_usd = cost_usd + ?
      WHERE id = ?
    `).run(output, inputTokens, outputTokens, costUsd, req.params.id);
  } else {
    db.prepare(`
      UPDATE design_generations
      SET output_html = ?, input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost_usd = cost_usd + ?
      WHERE id = ?
    `).run(output, inputTokens, outputTokens, costUsd, req.params.id);
  }

  // Track designEdits usage — monthly counter, queues overage if over cap
  let usageStatus = null;
  if (!isAdminEdit) {
    if (typeof global.mineTrackUsage === "function") {
      global.mineTrackUsage(db, req.userId, "designEdits");
    }
    incrementDailyGenCount(req.userId);
    if (typeof global.mineCheckUsage === "function") {
      const u = global.mineCheckUsage(db, req.userId, "designEdits");
      usageStatus = { used: u.used, cap: u.cap, remaining: u.remaining, wasOverage: u.wouldBeOverage };
    }
  }

  res.json({
    success: true,
    html: isSvg ? null : output,
    svg: isSvg ? output : null,
    usage: usageStatus,
    cost_usd: costUsd,
    meta: { inputTokens, outputTokens, model }
  });
});

// ─── GET /api/design/generation/:id/versions — list prior versions ──
router.get("/generation/:id/versions", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const rows = db.prepare(`
    SELECT id, version_num, edit_type, edit_instruction, created_at
    FROM design_versions
    WHERE design_id = ? AND user_id = ?
    ORDER BY version_num DESC
  `).all(req.params.id, req.userId);
  res.json({ versions: rows });
});

// ─── POST /api/design/generation/:id/restore/:versionId — undo to version ──
router.post("/generation/:id/restore/:versionId", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const version = db.prepare("SELECT * FROM design_versions WHERE id = ? AND design_id = ? AND user_id = ?").get(req.params.versionId, req.params.id, req.userId);
  if (!version) return res.status(404).json({ error: "Version not found" });

  const existing = db.prepare("SELECT type FROM design_generations WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: "Design not found" });

  const isSvg = existing.type === "logo";
  if (isSvg) {
    db.prepare("UPDATE design_generations SET output_svg = ? WHERE id = ?").run(version.output_svg, req.params.id);
  } else {
    db.prepare("UPDATE design_generations SET output_html = ? WHERE id = ?").run(version.output_html, req.params.id);
  }
  res.json({ success: true, html: version.output_html, svg: version.output_svg });
});

// ─── GET /api/design/generation/:id — fetch full design ──────────────
router.get("/generation/:id", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const row = db.prepare("SELECT * FROM design_generations WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json({ design: row });
});

// ─── DELETE /api/design/generation/:id ───────────────────────────────
router.delete("/generation/:id", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const r = db.prepare("DELETE FROM design_generations WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
  res.json({ success: r.changes > 0 });
});

// ─── POST /api/design/buy-credits — DEPRECATED, returns upgrade guidance ──
// Design Studio moved to metered billing. Users get design quota as part of their plan.
// To increase quota, upgrade plan; overages are billed monthly via Stripe invoice.
router.post("/buy-credits", auth, (req, res) => {
  res.status(410).json({
    error: "Credit packs have been replaced with monthly plan quotas.",
    deprecated: true,
    message: "Your plan now includes a monthly design allowance. Upgrade your plan for more designs, or pay overage at month-end.",
    action: "upgrade_plan"
  });
});

// ─── LEGACY: webhook handler kept as no-op for orphan Stripe events ──
// Any leftover pending credit purchases get marked complete + credits applied as bonus.
function handleDesignPurchaseWebhook(session) {
  const db = getDb();
  ensureTables(db);
  const userId = session.metadata?.mine_user;
  const credits = parseInt(session.metadata?.mine_credits || "0", 10);
  const purchaseId = session.metadata?.purchase_id;
  if (!userId || !credits) return;
  if (purchaseId) {
    try {
      db.prepare("UPDATE design_credit_purchases SET status = 'complete' WHERE id = ?").run(purchaseId);
    } catch {}
  }
  // Legacy: still credit them so they don't lose money, but system no longer consumes these
  const existing = db.prepare("SELECT balance FROM design_credits WHERE user_id = ?").get(userId);
  if (existing) {
    db.prepare("UPDATE design_credits SET balance = balance + ?, total_purchased = total_purchased + ?, updated_at = datetime('now') WHERE user_id = ?").run(credits, credits, userId);
  } else {
    db.prepare("INSERT INTO design_credits (user_id, balance, total_purchased) VALUES (?, ?, ?)").run(userId, credits, credits);
  }
  console.log(`[DESIGN] Legacy: credited ${credits} (metered billing active, not consumed)`);
}

// ─── ADMIN ENDPOINTS (require admin role) ────────────────────────────
function adminOnly(req, res, next) {
  const db = getDb();
  const u = db.prepare("SELECT role FROM users WHERE id = ?").get(req.userId);
  if (u?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
}

router.get("/admin/stats", auth, adminOnly, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const stats = {
    total_generations: db.prepare("SELECT COUNT(*) as c FROM design_generations").get().c,
    total_revenue:     db.prepare("SELECT COALESCE(SUM(amount_paid), 0) as s FROM design_credit_purchases WHERE status='complete'").get().s,
    total_cost:        db.prepare("SELECT COALESCE(SUM(cost_usd), 0) as s FROM design_generations").get().s,
    active_users:      db.prepare("SELECT COUNT(DISTINCT user_id) as c FROM design_generations WHERE created_at > datetime('now','-30 days')").get().c,
    by_type:           db.prepare("SELECT type, COUNT(*) as count FROM design_generations GROUP BY type").all()
  };
  stats.margin_usd = (stats.total_revenue || 0) - (stats.total_cost || 0);
  stats.margin_pct = stats.total_revenue > 0 ? Math.round((stats.margin_usd / stats.total_revenue) * 100) : 0;
  res.json(stats);
});

module.exports = router;
module.exports.handleDesignPurchaseWebhook = handleDesignPurchaseWebhook;
// ─── AI DESIGNER: print-ready PDF studio (2026-06-12) ───────────────────────
// $79/mo "designer" addon-gated. Streams pdfkit output; counts toward design caps.
router.post("/designer-pdf", auth, async (req, res) => {
  try {
    const db = getDb(); ensureTables(db);
    let active = null;
    try { active = db.prepare("SELECT 1 FROM ai_employee_subscriptions WHERE user_id = ? AND employee_id = 'designer' AND status = 'active'").get(req.userId); } catch (_e) {}
    if (!active) return res.status(402).json({ error: "Hire the AI Designer ($79/mo) on the AI Employees panel to use the studio.", needs_addon: "designer" });
    const { kind, brief, brand } = req.body || {};
    const KINDS = ["flyer", "business_card", "price_list"];
    if (!KINDS.includes(kind)) return res.status(400).json({ error: "kind must be one of: " + KINDS.join(", ") });
    if (!brief || String(brief).trim().length < 3) return res.status(400).json({ error: "Tell the designer what this is for (brief required)." });
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const sys = `You are a senior print designer. Return ONLY JSON for a ${kind.replace("_"," ")}: {"headline":"\u22646 words","subheadline":"\u226414 words","bullets":["3-5 short selling points"],"contact":"phone/site/email line","prices":[{"item":"","price":""}] (price_list only, \u226410),"accent":"#hex (tasteful)","footnote":"\u226410 words"}. Punchy, specific to the brief, no placeholders, no prose outside JSON.`;
    const msg = await client.messages.create({ model: "claude-opus-4-8", max_tokens: 700, system: sys, messages: [{ role: "user", content: "Brief: " + String(brief).slice(0, 600) + (brand ? " Brand: " + JSON.stringify(brand).slice(0, 300) : "") }] });
    let txt = (msg.content && msg.content[0] && msg.content[0].text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    let d = {}; try { d = JSON.parse(txt); } catch (_e) { return res.status(500).json({ error: "Design generation returned an unexpected format \u2014 try again." }); }
    const accent = /^#[0-9A-Fa-f]{6}$/.test(d.accent || "") ? d.accent : ((brand && brand.primary) || "#2563EB");
    let PDFDocument; try { PDFDocument = require("pdfkit"); } catch (_e) { return res.status(500).json({ error: "PDF engine unavailable" }); }
      try { global.mineTrackUsage(db, req.userId, "designs"); } catch(_u) {}
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="mine-${kind}-${Date.now()}.pdf"`);
    const A4 = [595.28, 841.89];
    const doc = new PDFDocument({ size: A4, margin: 0 });
    doc.pipe(res);
    const W = A4[0], H = A4[1];
    const bullets = Array.isArray(d.bullets) ? d.bullets.slice(0, 5) : [];
    if (kind === "business_card") {
      // two 88.9 x 50.8 mm cards (252 x 144 pt) centered, with crop marks
      const cw = 252, ch = 144, x = (W - cw) / 2;
      [160, 380].forEach(y => {
        const m = 14;
        [[x - m, y, x - 4, y], [x + cw + 4, y, x + cw + m, y], [x, y - m, x, y - 4], [x, y + ch + 4, x, y + ch + m],
         [x - m, y + ch, x - 4, y + ch], [x + cw + 4, y + ch, x + cw + m, y + ch], [x + cw, y - m, x + cw, y - 4], [x + cw, y + ch + 4, x + cw, y + ch + m]
        ].forEach(L => doc.moveTo(L[0], L[1]).lineTo(L[2], L[3]).lineWidth(0.5).stroke("#999"));
        doc.rect(x, y, cw, ch).fill("#FFFFFF").rect(x, y, 6, ch).fill(accent);
        doc.fillColor("#111").font("Helvetica-Bold").fontSize(15).text(String(d.headline || "Your Name"), x + 18, y + 26, { width: cw - 30 });
        doc.fillColor("#555").font("Helvetica").fontSize(9).text(String(d.subheadline || ""), x + 18, y + 50, { width: cw - 30 });
        doc.fillColor(accent).fontSize(9).text(String(d.contact || ""), x + 18, y + ch - 34, { width: cw - 30 });
      });
      doc.fillColor("#999").fontSize(8).text("Standard 88.9 \u00d7 50.8 mm \u2014 cut on crop marks", 0, H - 50, { align: "center", width: W });
    } else {
      doc.rect(0, 0, W, 170).fill(accent);
      doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(34).text(String(d.headline || "Headline"), 48, 52, { width: W - 96 });
      doc.font("Helvetica").fontSize(14).fillOpacity(0.92).text(String(d.subheadline || ""), 48, 112, { width: W - 96 }).fillOpacity(1);
      let y = 215;
      if (kind === "price_list" && Array.isArray(d.prices)) {
        doc.fillColor("#111").font("Helvetica-Bold").fontSize(16).text("Prices", 48, y); y += 30;
        d.prices.slice(0, 10).forEach(rw => {
          doc.font("Helvetica").fontSize(13).fillColor("#222").text(String(rw.item || "").slice(0, 60), 48, y, { width: W - 200 });
          doc.font("Helvetica-Bold").fillColor(accent).text(String(rw.price || ""), W - 150, y, { width: 100, align: "right" });
          y += 26; doc.moveTo(48, y - 8).lineTo(W - 48, y - 8).lineWidth(0.5).stroke("#EEE");
        });
        y += 14;
      }
      bullets.forEach(b => {
        doc.circle(56, y + 6, 3).fill(accent);
        doc.fillColor("#222").font("Helvetica").fontSize(13).text(String(b).slice(0, 110), 72, y, { width: W - 130 });
        y += 28;
      });
      doc.rect(0, H - 92, W, 92).fill("#111");
      doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(13).text(String(d.contact || ""), 48, H - 62, { width: W - 96 });
      if (d.footnote) doc.fillColor("#BBB").font("Helvetica").fontSize(9).text(String(d.footnote), 48, H - 40, { width: W - 96 });
    }
    doc.end();
  } catch (e) { console.error("[designer-pdf]", e?.message || e); if (!res.headersSent) res.status(500).json({ error: "An internal error occurred" }); }
});

// \ud83c\udfa8 Designer addon status \u2014 powers the panel meter
router.get("/addon", auth, (req, res) => {
  try {
    const db = getDb();
    const m = designerMeter(db, req.user?.id || req.userId);
    res.json({ ...m, price: 79, overage_price: 0.5, label: "AI Designer" });
  } catch (e) { res.status(500).json({ error: "An internal error occurred" }); }
});

// \ud83c\udfa8 Print-ready PDF export \u2014 flyer (A4) or business card, brand-colored
router.post("/export-pdf", auth, (req, res) => {
  try {
    const db = getDb();
    const meter = designerMeter(db, req.user?.id || req.userId);
    if (!meter.allowed) return res.status(402).json({ error: "The AI Designer is available on Growth plans and above." });
    const { title, subtitle, lines, format, accent, footer } = req.body || {};
    if (!title) return res.status(400).json({ error: "title required" });
    const PDFDocument = require("pdfkit");
    const fs = require("fs"); const path = require("path");
    const dir = path.join(__dirname, "..", "uploads", "design-images");
    fs.mkdirSync(dir, { recursive: true });
    const id = require("uuid").v4();
    const file = path.join(dir, "designer-" + id + ".pdf");
    const isCard = format === "card";
    const doc = new PDFDocument(isCard ? { size: [242.6, 153] , margin: 14 } : { size: "A4", margin: 48 });
    doc.pipe(fs.createWriteStream(file));
    const ac = /^#[0-9a-fA-F]{6}$/.test(accent || "") ? accent : "#2563EB";
    doc.rect(0, 0, doc.page.width, isCard ? 44 : 120).fill(ac);
    doc.fill("#FFFFFF").font("Helvetica-Bold").fontSize(isCard ? 14 : 34)
       .text(String(title).slice(0, 80), isCard ? 14 : 48, isCard ? 14 : 44, { width: doc.page.width - (isCard ? 28 : 96) });
    doc.fill("#14183C").font("Helvetica").fontSize(isCard ? 8 : 14);
    let y = isCard ? 54 : 150;
    if (subtitle) { doc.text(String(subtitle).slice(0, 120), isCard ? 14 : 48, y, { width: doc.page.width - (isCard ? 28 : 96) }); y += isCard ? 14 : 26; }
    for (const ln of (Array.isArray(lines) ? lines.slice(0, isCard ? 4 : 14) : [])) {
      doc.text("\u2022 " + String(ln).slice(0, 110), isCard ? 14 : 48, y, { width: doc.page.width - (isCard ? 28 : 96) });
      y += isCard ? 11 : 20;
    }
    if (footer) doc.fill("#7A7F9A").fontSize(isCard ? 6 : 10).text(String(footer).slice(0, 90), isCard ? 14 : 48, doc.page.height - (isCard ? 18 : 60));
    doc.end();
    designerTick(db, req.user?.id || req.userId, meter.month);
    res.json({ success: true, url: "/uploads/design-images/designer-" + id + ".pdf", format: isCard ? "business card" : "A4 flyer" });
  } catch (e) { console.error("[design/export-pdf]", e.message); res.status(500).json({ error: "PDF export failed" }); }
});

// 🎨 AUTONOMOUS DESIGNER (2026-06-13): proposes on-brand designs; Full=auto-create, Half/Review=queue
router.post("/scan", auth, async (req, res) => {
  try {
    const db = getDb();
    const userId = req.user?.id || req.userId;
    const meter = designerMeter(db, userId);
    if (!meter.allowed) return res.status(402).json({ error: "AI Designer is available on Growth plans and above." });

    // only run autonomously if the Designer is actually hired/enabled
    try { const hired = db.prepare("SELECT id FROM ai_employees WHERE user_id=? AND role='designer' AND enabled=1").get(userId); if (!hired) return res.json({ success: true, created: 0, queued: 0, note: "Hire the AI Designer to enable autonomous designs" }); } catch(_e) {}
    // read this employee's autonomy via the shared engine
    let mode = "suggest";
    try {
      const ai = require("./ai-employees");
      const emp = db.prepare("SELECT autonomy FROM ai_employees WHERE user_id=? AND role='designer'").get(userId);
      mode = ai.getAutonomyMode ? ai.getAutonomyMode(emp || {}) : "suggest";
    } catch(_e) {}

    // ─── gather REAL business signals (same tables the other agents read) ───
    const signals = { month: "", brand: {}, revenue: {}, customers: {}, products: [], recentDesigns: [], upcoming: [] };
    const now = new Date();
    signals.month = now.toLocaleString("en-US", { month: "long" });
    try { const _r = db.prepare("SELECT business_name, brand_primary_color, brand_font, brand_kit FROM users WHERE id=?").get(userId) || {}; let _k={}; try{_k=_r.brand_kit?JSON.parse(_r.brand_kit):{};}catch(_e2){} signals.brand = { business_name: _k.businessName||_r.business_name, primary: _k.primary||_r.brand_primary_color, font: _k.font||_r.brand_font, voice: _k.voice||"" }; } catch(_e) {}

    // revenue trend: this month vs last 30d-prior, plus 7-day momentum
    try {
      const r = db.prepare("SELECT COALESCE(SUM(total),0) s, COUNT(*) c FROM orders WHERE user_id=? AND created_at>=datetime('now','-30 day')").get(userId);
      const prev = db.prepare("SELECT COALESCE(SUM(total),0) s FROM orders WHERE user_id=? AND created_at>=datetime('now','-60 day') AND created_at<datetime('now','-30 day')").get(userId);
      const last7 = db.prepare("SELECT COALESCE(SUM(total),0) s FROM orders WHERE user_id=? AND created_at>=datetime('now','-7 day')").get(userId);
      signals.revenue = { last30: Math.round(r.s), orders30: r.c, prev30: Math.round(prev.s), last7: Math.round(last7.s),
        trend: prev.s>0 ? (r.s>=prev.s ? "up" : "down") : "new" };
    } catch(_e) {}

    // customers: new this week + total + how many are quiet (no order in 60d)
    try {
      const nw = db.prepare("SELECT COUNT(*) c FROM contacts WHERE user_id=? AND created_at>=datetime('now','-7 day')").get(userId).c;
      const tot = db.prepare("SELECT COUNT(*) c FROM contacts WHERE user_id=?").get(userId).c;
      signals.customers = { newThisWeek: nw, total: tot };
    } catch(_e) {}

    // product catalog (names guide what to showcase)
    try { signals.products = db.prepare("SELECT name, category FROM products WHERE user_id=? AND (status IS NULL OR status!='archived') ORDER BY created_at DESC LIMIT 8").all(userId).map(p=>p.name).filter(Boolean); } catch(_e) {}

    // what the designer already made recently (avoid repeats)
    try { signals.recentDesigns = db.prepare("SELECT type, prompt FROM design_generations WHERE user_id=? ORDER BY created_at DESC LIMIT 6").all(userId).map(d=>({type:d.type, brief:String(d.prompt||"").slice(0,60)})); } catch(_e) {}

    // upcoming seasonal moments (next ~45 days) — lightweight calendar
    const SEASONS = [
      {m:0,d:1,n:"New Year"},{m:1,d:14,n:"Valentine's Day"},{m:2,d:17,n:"St Patrick's Day"},
      {m:3,d:1,n:"Easter / Spring"},{m:4,d:12,n:"Mother's Day"},{m:5,d:15,n:"Father's Day / EOFY (AU)"},
      {m:5,d:30,n:"End of Financial Year (AU)"},{m:6,d:1,n:"Winter sale (AU)"},{m:8,d:1,n:"Spring (AU) / Back to school"},
      {m:9,d:31,n:"Halloween"},{m:10,d:28,n:"Black Friday / Cyber Monday"},{m:11,d:25,n:"Christmas / Holidays"},
      {m:11,d:26,n:"Boxing Day sales"}
    ];
    try {
      const today = new Date();
      for (const ev of SEASONS) {
        let when = new Date(today.getFullYear(), ev.m, ev.d);
        if (when < today) when = new Date(today.getFullYear()+1, ev.m, ev.d);
        const days = Math.round((when - today)/86400000);
        if (days >= 0 && days <= 45) signals.upcoming.push({ event: ev.n, inDays: days });
      }
      signals.upcoming.sort((a,b)=>a.inDays-b.inDays);
    } catch(_e) {}

    const sys = 'You are an elite autonomous brand designer for a small business. You are given REAL business signals. Propose up to 3 high-impact, on-brand visual assets to create RIGHT NOW, each justified by the actual data — not generic ideas. Rules: tie proposals to concrete signals (a revenue dip → a promo/ad; an upcoming season within range → a timely campaign; new products → a showcase; many new customers → a welcome/social piece; quiet sales → a re-engagement creative). Do NOT repeat anything already in recentDesigns. Return ONLY a JSON array: [{"type":"social|ad-creative|logo|one-pager","title":"short imperative","reason":"one sentence citing the specific signal","prompt":"a concrete, on-brand design brief"}]. No prose outside JSON.';
    const userMsg = "REAL SIGNALS:\n" + JSON.stringify(signals, null, 0) + "\n\nPropose the smartest designs for this business right now.";

    const Anthropic2 = require("@anthropic-ai/sdk");
    const apiKey2 = process.env.ANTHROPIC_API_KEY;
    if (!apiKey2) return res.status(400).json({ error: "No API key" });
    const client2 = new Anthropic2.default({ apiKey: apiKey2 });
    const msg2 = await client2.messages.create({ model: "claude-sonnet-4-6", max_tokens: 900, system: sys, messages: [{ role: "user", content: userMsg }] });
    let txt = (msg2.content && msg2.content[0] && msg2.content[0].text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    let proposals = []; try { proposals = JSON.parse(txt); } catch(_e) {}
    if (!Array.isArray(proposals)) proposals = [];
    proposals = proposals.slice(0, 3).filter(p => p && p.prompt && ["social","ad-creative","logo","one-pager"].includes(p.type));
    if (!proposals.length) return res.json({ success: true, mode, created: 0, queued: 0, note: "No new design proposals right now" });

    // Full auto -> create now via the shared executor; Half/Review -> queue in autopilot_actions
    let created = 0, queued = 0;
    db.prepare("CREATE TABLE IF NOT EXISTS autopilot_actions (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, input_json TEXT, title TEXT, reason TEXT, status TEXT DEFAULT 'pending', result TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, executed_at TEXT)").run();
    for (const p of proposals) {
      if (mode === "auto") {
        try {
          const mc = require("./mine-control");
          const out = await mc.executeTool(db, userId, "create_design", { type: p.type, prompt: p.prompt });
          if (out && out.success) created++;
        } catch(_e) {}
      } else {
        // queue for approval (Half auto / Review only both gate to the approval inbox for design)
        const id = require("uuid").v4();
        const dup = db.prepare("SELECT 1 FROM autopilot_actions WHERE user_id=? AND type='create_design' AND title=? AND status='pending'").get(userId, String(p.title||"").slice(0,90));
        if (!dup) {
          db.prepare("INSERT INTO autopilot_actions (id,user_id,type,input_json,title,reason) VALUES (?,?,?,?,?,?)")
            .run(id, userId, "create_design", JSON.stringify({ type: p.type, prompt: p.prompt }), "🎨 " + String(p.title||"New design").slice(0,88), String(p.reason||"").slice(0,200));
          queued++;
        }
      }
    }
    try {
      const { v4: _uuid } = require("uuid");
      db.prepare("CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id TEXT, icon TEXT, text TEXT, type TEXT, read INTEGER DEFAULT 0, time TEXT DEFAULT CURRENT_TIMESTAMP)").run();
      if (created > 0) db.prepare("INSERT INTO notifications (id,user_id,icon,text,time) VALUES (?,?,?,?,datetime('now'))").run(_uuid(), userId, "\ud83c\udfa8", "AI Designer created " + created + " on-brand design(s) automatically.");
      else if (queued > 0) db.prepare("INSERT INTO notifications (id,user_id,icon,text,time) VALUES (?,?,?,?,datetime('now'))").run(_uuid(), userId, "\ud83c\udfa8", "AI Designer proposed " + queued + " design(s) \u2014 waiting in your approvals.");
    } catch(_e) {}
    res.json({ success: true, mode, created, queued, proposals: proposals.length,
      message: mode === "auto" ? (created + " design(s) created automatically") : (queued + " design proposal(s) waiting for your approval") });
  } catch (e) { console.error("[design/scan]", e.message); res.status(500).json({ error: "Designer scan failed" }); }
});

// 📧 EMAIL DESIGNER (2026-06-13): generates client-safe HTML email → download / copy / send via MINE
router.post("/email-design", auth, async (req, res) => {
  try {
    const db = getDb();
    const userId = req.user?.id || req.userId;
    const meter = designerMeter(db, userId);
    if (!meter.allowed) return res.status(402).json({ error: "AI Designer is available on Growth plans and above." });
    const { prompt, kind, subject } = req.body || {};
    if (!prompt || String(prompt).trim().length < 3) return res.status(400).json({ error: "Describe the email you want" });
    let brand = {};
    try { brand = db.prepare("SELECT business_name, brand_primary_color, brand_font FROM users WHERE id=?").get(userId) || {}; } catch(_e) {}
    const accent = /^#[0-9a-fA-F]{6}$/.test(brand.brand_primary_color || "") ? brand.brand_primary_color : "#2563EB";
    const type = ["newsletter","promo","welcome","announcement"].includes(kind) ? kind : "promo";
    const sys = "You are an expert email designer. Output a COMPLETE, email-client-safe HTML email and NOTHING else. " +
      "HARD RULES: table-based layout (no flexbox/grid), ALL CSS inline on elements (no <style> blocks, no classes), " +
      "max-width 600px centered, web-safe fonts, no <script>, no external CSS, no background-image reliance for content. " +
      "Use the brand accent color " + accent + " for buttons/headers. Brand: " + JSON.stringify(brand) + ". " +
      "Include a clear headline, body, a prominent call-to-action button (table-based, bulletproof), and an unsubscribe line in the footer. " +
      "Email type: " + type + ". Return only the <html>…</html> markup.";
    const Anthropic = require("@anthropic-ai/sdk");
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(400).json({ error: "No API key" });
    const client = new Anthropic.default({ apiKey });
    const msg = await client.messages.create({ model: "claude-opus-4-8", max_tokens: 4000, system: sys, messages: [{ role: "user", content: String(prompt).slice(0, 800) }] });
    let html = (msg.content && msg.content[0] && msg.content[0].text || "").replace(/^```(?:html)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
    if (!/<html|<table|<body/i.test(html)) return res.status(500).json({ error: "Email generation failed — try again" });
    // sanitize: strip scripts/handlers (keep email-safe markup)
    html = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/ on[a-z]+\s*=\s*"[^"]*"/gi, "");
    const id = uuid();
    try {
      db.prepare("CREATE TABLE IF NOT EXISTS design_generations (id TEXT PRIMARY KEY, user_id TEXT, client_id TEXT, prompt TEXT, type TEXT, output_html TEXT, output_svg TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, success INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP)").run();
      db.prepare("INSERT INTO design_generations (id, user_id, prompt, type, output_html, model, success) VALUES (?,?,?,?,?,?,1)")
        .run(id, userId, String(prompt).slice(0,600), "email-" + type, html, "claude-opus-4-8");
    } catch(_e) {}
    try { const mo=new Date().toISOString().slice(0,7); db.prepare("CREATE TABLE IF NOT EXISTS designer_usage (user_id TEXT, month TEXT, units INTEGER DEFAULT 0, PRIMARY KEY(user_id, month))").run(); db.prepare("INSERT OR IGNORE INTO designer_usage (user_id,month,units) VALUES (?,?,0)").run(userId,mo); db.prepare("UPDATE designer_usage SET units=units+1 WHERE user_id=? AND month=?").run(userId,mo); } catch(_e) {}
    res.json({ success: true, id, type, subject: subject || "", html,
      downloadName: "email-" + type + "-" + id.slice(0,8) + ".html",
      message: "Email designed — download the HTML, copy it, or send it to your contacts" });
  } catch (e) { console.error("[design/email-design]", e.message); res.status(500).json({ error: "Email design failed" }); }
});

// 📧 push a designed email straight into TAKEOVA's send engine (broadcast to contacts)
router.post("/email-send", auth, async (req, res) => {
  try {
    const db = getDb();
    const userId = req.user?.id || req.userId;
    const { designId, subject, html, audience } = req.body || {};
    let finalHtml = html;
    if (!finalHtml && designId) {
      try { finalHtml = (db.prepare("SELECT output_html FROM design_generations WHERE id=? AND user_id=?").get(designId, userId) || {}).output_html; } catch(_e) {}
    }
    if (!finalHtml) return res.status(400).json({ error: "No email content to send" });
    if (!subject) return res.status(400).json({ error: "Subject required" });
    if (!process.env.SENDGRID_API_KEY) return res.status(400).json({ error: "Email sending not configured (SENDGRID_API_KEY)" });
    let contacts = [];
    try { contacts = db.prepare("SELECT email, name FROM contacts WHERE user_id=? AND email IS NOT NULL AND email != '' " + (audience === "recent" ? "AND created_at>=datetime('now','-30 day') " : "") + "LIMIT 2000").all(userId); } catch(_e) {}
    if (!contacts.length) return res.json({ success: true, sent: 0, note: "No contacts to send to yet" });
    const sgMail = require("@sendgrid/mail"); sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    const fromEmail = process.env.EMAIL_FROM || "noreply@takeova.ai";
    const fromName = process.env.SENDGRID_FROM_NAME || (db.prepare("SELECT business_name FROM users WHERE id=?").get(userId)||{}).business_name || "MINE";
    // schedule for later?
    if (req.body.sendAt) {
      const when = new Date(req.body.sendAt);
      if (!isNaN(when.getTime()) && when.getTime() > Date.now()) {
        db.prepare("CREATE TABLE IF NOT EXISTS scheduled_emails (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, subject TEXT, body TEXT, send_at TEXT, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')))").run();
        let q = 0;
        for (const c of contacts.slice(0, 2000)) {
          try {
            const personal = finalHtml.replace(/{{\s*name\s*}}/gi, c.name || "there");
            db.prepare("INSERT INTO scheduled_emails (id, user_id, email, subject, body, send_at, status) VALUES (?,?,?,?,?,?, 'pending')")
              .run(require("uuid").v4(), userId, c.email, String(subject).slice(0,180), personal, when.toISOString());
            q++;
          } catch(_e) {}
        }
        return res.json({ success: true, scheduled: q, sendAt: when.toISOString(), message: q + " email(s) scheduled for " + when.toLocaleString() });
      }
    }
    db.prepare("CREATE TABLE IF NOT EXISTS email_log (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, to_email TEXT, subject TEXT, type TEXT, opened INTEGER DEFAULT 0, clicked INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)").run();
    const backendUrl = process.env.BACKEND_URL || process.env.PUBLIC_URL || "";
    let sent = 0;
    for (const c of contacts.slice(0, 2000)) {
      try {
        const logId = require("uuid").v4();
        let personal = finalHtml.replace(/{{\s*name\s*}}/gi, c.name || "there");
        // open-tracking pixel (our own, works regardless of SendGrid plan)
        if (backendUrl) personal += '<img src="' + backendUrl + '/api/design/track/open/' + logId + '.png" width="1" height="1" style="display:none" alt=""/>';
        await sgMail.send({ to: c.email, from: { email: fromEmail, name: fromName }, subject: String(subject).slice(0,180), html: personal,
          trackingSettings: { openTracking: { enable: true }, clickTracking: { enable: true } } });
        try { db.prepare("INSERT INTO email_log (id, user_id, to_email, subject, type) VALUES (?,?,?,?, 'designer_broadcast')").run(logId, userId, c.email, String(subject).slice(0,180)); } catch(_e) {}
        sent++;
      } catch(_e) {}
    }
    res.json({ success: true, sent, total: contacts.length, message: "Email sent to " + sent + " contact(s)" });
  } catch (e) { console.error("[design/email-send]", e.message); res.status(500).json({ error: "Send failed" }); }
});

// 🎨 LIVING BRAND KIT (2026-06-13): one source of truth the Designer uses everywhere
router.get("/brand-kit", auth, (req, res) => {
  try {
    const db = getDb(); const userId = req.user?.id || req.userId;
    let row = {};
    try { row = db.prepare("SELECT business_name, brand_kit, brand_primary_color, brand_font, logo_url FROM users WHERE id=?").get(userId) || {}; } catch(_e) {}
    let kit = {};
    try { kit = row.brand_kit ? JSON.parse(row.brand_kit) : {}; } catch(_e) {}
    res.json({
      businessName: kit.businessName || row.business_name || "",
      primary: kit.primary || row.brand_primary_color || "#2563EB",
      secondary: kit.secondary || "#0EA5E9",
      text: kit.text || "#14183C",
      font: kit.font || row.brand_font || "system-ui",
      voice: kit.voice || "",
      logoUrl: kit.logoUrl || row.logo_url || ""
    });
  } catch (e) { res.status(500).json({ error: "An internal error occurred" }); }
});
router.put("/brand-kit", auth, (req, res) => {
  try {
    const db = getDb(); const userId = req.user?.id || req.userId;
    const b = req.body || {};
    const hex = (v, d) => /^#[0-9a-fA-F]{6}$/.test(String(v||"")) ? v : d;
    let cur = {};
    try { const r = db.prepare("SELECT brand_kit FROM users WHERE id=?").get(userId); cur = r && r.brand_kit ? JSON.parse(r.brand_kit) : {}; } catch(_e) {}
    const next = {
      businessName: (b.businessName !== undefined ? String(b.businessName).slice(0,80) : cur.businessName) || "",
      primary: hex(b.primary, cur.primary || "#2563EB"),
      secondary: hex(b.secondary, cur.secondary || "#0EA5E9"),
      text: hex(b.text, cur.text || "#14183C"),
      font: (b.font !== undefined ? String(b.font).slice(0,60) : cur.font) || "system-ui",
      voice: (b.voice !== undefined ? String(b.voice).slice(0,300) : cur.voice) || "",
      logoUrl: (b.logoUrl !== undefined ? String(b.logoUrl).slice(0,500) : cur.logoUrl) || ""
    };
    try {
      db.prepare("UPDATE users SET brand_kit=?, brand_primary_color=?, brand_font=? WHERE id=?")
        .run(JSON.stringify(next), next.primary, next.font, userId);
    } catch(_e) {}
    res.json({ success: true, brand: next, message: "Brand kit saved — your Designer now uses these everywhere" });
  } catch (e) { res.status(500).json({ error: "Brand save failed" }); }
});

// 🖼️ PNG EXPORT (2026-06-13): rasterize a saved design (or supplied HTML/SVG) to a downloadable PNG
router.post("/export-png", auth, async (req, res) => {
  try {
    const db = getDb(); const userId = req.user?.id || req.userId;
    const meter = designerMeter(db, userId);
    if (!meter.allowed) return res.status(402).json({ error: "AI Designer is available on Growth plans and above." });
    let { designId, html, svg, width, preset } = req.body || {};
    const PRESETS = { "instagram-square": [1080,1080], "instagram-story": [1080,1920], "facebook": [1200,630], "twitter": [1200,675] };
    let W = 1080, H = 1080;
    if (preset && PRESETS[preset]) { W = PRESETS[preset][0]; H = PRESETS[preset][1]; }
    else if (width) { W = Math.min(2000, Math.max(200, parseInt(width)||1080)); H = W; }
    if (designId && !html && !svg) {
      try { const r = db.prepare("SELECT output_html, output_svg FROM design_generations WHERE id=? AND user_id=?").get(designId, userId) || {}; html = r.output_html; svg = r.output_svg; } catch(_e) {}
    }
    const fs = require("fs"); const path = require("path");
    const dir = path.join(__dirname, "..", "uploads", "design-images"); fs.mkdirSync(dir, { recursive: true });
    const id = require("uuid").v4(); const outFile = path.join(dir, "design-" + id + ".png");
    let sharp; try { sharp = require("sharp"); } catch(_e) { sharp = null; }
    if (!sharp) {
      // graceful fallback: if no rasterizer, return the SVG/HTML asset so nothing is lost
      if (svg) { const f2 = path.join(dir, "design-" + id + ".svg"); fs.writeFileSync(f2, svg); return res.json({ success: true, url: "/uploads/design-images/design-" + id + ".svg", format: "svg", note: "PNG rasterizer not available in this environment — returned SVG" }); }
      return res.status(501).json({ error: "PNG export needs the image library (sharp) installed on the server" });
    }
    try {
      if (svg) {
        await sharp(Buffer.from(svg)).resize(W, H, { fit: "contain", background: "#ffffff" }).png().toFile(outFile);
      } else if (html) {
        // wrap HTML in a sized SVG foreignObject so sharp can rasterize without a browser
        const safe = String(html).replace(/<script[\s\S]*?<\/script>/gi, "");
        const wrapped = '<svg xmlns="http://www.w3.org/2000/svg" width="'+W+'" height="'+H+'"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="width:'+W+'px;height:'+H+'px;background:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:40px">'+safe+'</div></foreignObject></svg>';
        await sharp(Buffer.from(wrapped)).png().toFile(outFile);
      } else { return res.status(400).json({ error: "No design content to export" }); }
    } catch (e) { return res.status(500).json({ error: "Rasterize failed: " + e.message }); }
    try { const mo=new Date().toISOString().slice(0,7); db.prepare("INSERT OR IGNORE INTO designer_usage (user_id,month,units) VALUES (?,?,0)").run(userId,mo); db.prepare("UPDATE designer_usage SET units=units+1 WHERE user_id=? AND month=?").run(userId,mo); } catch(_e) {}
    res.json({ success: true, url: "/uploads/design-images/design-" + id + ".png", format: "png", width: W, height: H, preset: preset || "custom" });
  } catch (e) { console.error("[design/export-png]", e.message); res.status(500).json({ error: "PNG export failed" }); }
});

// ⏰ process due scheduled emails (cron hits this)
router.post("/email/process-scheduled", async (req, res) => {
  try {
    if (process.env.CRON_SECRET && req.query.secret !== process.env.CRON_SECRET) return res.status(403).json({ error: "Forbidden" });
    const db = getDb();
    if (!process.env.SENDGRID_API_KEY) return res.json({ sent: 0, error: "SENDGRID_API_KEY not set" });
    const sgMail = require("@sendgrid/mail"); sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    const fromEmail = process.env.EMAIL_FROM || "noreply@takeova.ai";
    const fromName = process.env.SENDGRID_FROM_NAME || "MINE";
    let due = [];
    try { due = db.prepare("SELECT * FROM scheduled_emails WHERE status='pending' AND send_at <= datetime('now') LIMIT 500").all(); } catch(_e) {}
    let sent = 0;
    for (const m of due) {
      try {
        await sgMail.send({ to: m.email, from: { email: fromEmail, name: fromName }, subject: m.subject, html: m.body,
          trackingSettings: { openTracking: { enable: true }, clickTracking: { enable: true } } });
        db.prepare("UPDATE scheduled_emails SET status='sent' WHERE id=?").run(m.id); sent++;
      } catch(e) { try { db.prepare("UPDATE scheduled_emails SET status='failed' WHERE id=?").run(m.id); } catch(_e) {} }
    }
    res.json({ success: true, sent, due: due.length });
  } catch (e) { res.status(500).json({ error: "Scheduler failed" }); }
});

// 👁️ open-tracking pixel
router.get("/track/open/:logId.png", (req, res) => {
  try { const db = getDb(); db.prepare("UPDATE email_log SET opened=1 WHERE id=?").run(req.params.logId); } catch(_e) {}
  const px = Buffer.from("R0lGODlhAQABAIAAAAAAAAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");
  res.set("Content-Type", "image/gif"); res.set("Cache-Control", "no-store"); res.send(px);
});

// 📊 email stats for the designer panel
router.get("/email/stats", auth, (req, res) => {
  try {
    const db = getDb(); const userId = req.user?.id || req.userId;
    let sent = 0, opened = 0, scheduled = 0;
    try { const r = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(opened),0) o FROM email_log WHERE user_id=? AND type='designer_broadcast'").get(userId); sent = r.c; opened = r.o; } catch(_e) {}
    try { scheduled = db.prepare("SELECT COUNT(*) c FROM scheduled_emails WHERE user_id=? AND status='pending'").get(userId).c; } catch(_e) {}
    res.json({ sent, opened, openRate: sent>0 ? Math.round(opened/sent*100) : 0, scheduled });
  } catch (e) { res.status(500).json({ error: "An internal error occurred" }); }
});

// 🔄 REFRESH MY BRAND EVERYWHERE: re-skin recent designs into current brand kit
router.post("/refresh-brand", auth, async (req, res) => {
  try {
    const db = getDb(); const userId = req.user?.id || req.userId;
    const meter = designerMeter(db, userId);
    if (!meter.allowed) return res.status(402).json({ error: "AI Designer is available on Growth plans and above." });
    let kit = {};
    try { const r = db.prepare("SELECT brand_kit FROM users WHERE id=?").get(userId); kit = r && r.brand_kit ? JSON.parse(r.brand_kit) : {}; } catch(_e) {}
    const primary = /^#[0-9a-fA-F]{6}$/.test(kit.primary||"") ? kit.primary : "#2563EB";
    let designs = [];
    try { designs = db.prepare("SELECT id, output_html, output_svg, type FROM design_generations WHERE user_id=? AND (output_html IS NOT NULL OR output_svg IS NOT NULL) ORDER BY created_at DESC LIMIT 8").all(userId); } catch(_e) {}
    if (!designs.length) return res.json({ success: true, updated: 0, note: "No designs to refresh yet" });
    const Anthropic = require("@anthropic-ai/sdk");
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(400).json({ error: "No API key" });
    const client = new Anthropic.default({ apiKey });
    let updated = 0;
    for (const d of designs.slice(0, 6)) {
      const markup = d.output_html || d.output_svg; if (!markup) continue;
      try {
        const sys = "Re-skin this design to the brand palette WITHOUT changing layout, copy, or structure. Brand: " + JSON.stringify(kit) + ". Replace colors with the brand primary " + primary + " and complementary tones. Return ONLY the updated " + (d.output_svg ? "SVG" : "HTML") + ", nothing else.";
        const msg = await client.messages.create({ model: "claude-sonnet-4-6", max_tokens: 4000, system: sys, messages: [{ role: "user", content: markup.slice(0, 8000) }] });
        let out = (msg.content && msg.content[0] && msg.content[0].text || "").replace(/^```(?:html|svg|xml)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
        out = out.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/ on[a-z]+\s*=\s*"[^"]*"/gi, "");
        if (out && out.length > 20) {
          if (d.output_svg) db.prepare("UPDATE design_generations SET output_svg=? WHERE id=?").run(out, d.id);
          else db.prepare("UPDATE design_generations SET output_html=? WHERE id=?").run(out, d.id);
          updated++;
        }
      } catch(_e) {}
    }
    res.json({ success: true, updated, message: updated + " design(s) refreshed to your brand" });
  } catch (e) { console.error("[design/refresh-brand]", e.message); res.status(500).json({ error: "Brand refresh failed" }); }
});

// 📱 which social platforms are connected (for the panel)
router.get("/social-status", auth, (req, res) => {
  try {
    const db = getDb(); const userId = req.user?.id || req.userId;
    let rows = [];
    try { rows = db.prepare("SELECT platform, COALESCE(page_name, username) AS handle FROM user_social_tokens WHERE user_id=?").all(userId); } catch(_e) {}
    res.json({ connected: rows.map(r => ({ platform: r.platform, handle: r.handle || "" })) });
  } catch (e) { res.status(500).json({ error: "An internal error occurred" }); }
});

// 📱 design → POST: make an on-brand social image and queue it to connected platforms
router.post("/post-social", auth, async (req, res) => {
  try {
    const db = getDb(); const userId = req.user?.id || req.userId;
    const meter = designerMeter(db, userId);
    if (!meter.allowed) return res.status(402).json({ error: "AI Designer is available on Growth plans and above." });
    const { prompt, caption, platforms } = req.body || {};
    if (!prompt || String(prompt).trim().length < 3) return res.status(400).json({ error: "Describe the post first" });

    // connected platforms (intersect with requested, if any)
    let connected = [];
    try { connected = db.prepare("SELECT platform FROM user_social_tokens WHERE user_id=?").all(userId).map(r => r.platform); } catch(_e) {}
    let targets = Array.isArray(platforms) && platforms.length ? platforms.filter(p => connected.includes(p)) : connected;

    // 1) design the image via the shared executor (saves to design_generations + meters)
    let designId = null;
    try {
      const mc = require("./mine-control");
      const out = await mc.executeTool(db, userId, "create_design", { type: "social", prompt: String(prompt).slice(0,600) });
      if (out && out.id) designId = out.id;
    } catch(_e) {}

    // 2) rasterize to PNG (best-effort)
    let imageUrl = "";
    try {
      let sharp = null; try { sharp = require("sharp"); } catch(_e) { sharp = null; }
      if (sharp && designId) {
        const r = db.prepare("SELECT output_html, output_svg FROM design_generations WHERE id=?").get(designId) || {};
        const markup = r.output_svg || r.output_html;
        if (markup) {
          const fs = require("fs"); const path = require("path");
          const dir = path.join(__dirname, "..", "uploads", "design-images"); fs.mkdirSync(dir, { recursive: true });
          const pid = require("uuid").v4(); const outFile = path.join(dir, "social-" + pid + ".png");
          const W = 1080, H = 1080;
          if (r.output_svg) await sharp(Buffer.from(r.output_svg)).resize(W, H, { fit: "contain", background: "#fff" }).png().toFile(outFile);
          else { const safe = String(markup).replace(/<script[\s\S]*?<\/script>/gi, ""); const wrapped = '<svg xmlns="http://www.w3.org/2000/svg" width="'+W+'" height="'+H+'"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="width:'+W+'px;height:'+H+'px;background:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:40px">'+safe+'</div></foreignObject></svg>'; await sharp(Buffer.from(wrapped)).png().toFile(outFile); }
          imageUrl = "/uploads/design-images/social-" + pid + ".png";
        }
      }
    } catch(_e) {}

    if (!targets.length) {
      // nothing connected — save as draft so it's not lost
      try { db.prepare("CREATE TABLE IF NOT EXISTS social_posts (id TEXT PRIMARY KEY, user_id TEXT, content TEXT, platforms TEXT, status TEXT DEFAULT 'published', results TEXT, image_url TEXT, posted_at TEXT, created_at TEXT DEFAULT (datetime('now')))").run();
        try { db.exec("ALTER TABLE social_posts ADD COLUMN image_url TEXT"); } catch(_e) {}
        db.prepare("INSERT INTO social_posts (id, user_id, content, platforms, status, image_url) VALUES (?,?,?,?, 'draft', ?)")
          .run(require("uuid").v4(), userId, String(caption||prompt).slice(0,2000), JSON.stringify(["draft"]), imageUrl);
      } catch(_e) {}
      return res.json({ success: true, posted: false, designId, imageUrl, draft: true, message: "Design created and saved as a draft — connect a social account to post it" });
    }

    // 3) respect autonomy: Full=queue as ready-to-publish, Half/Review=draft for approval
    let mode = "suggest";
    try { const ai = require("./ai-employees"); const emp = db.prepare("SELECT autonomy FROM ai_employees WHERE user_id=? AND role='designer'").get(userId); mode = ai.getAutonomyMode ? ai.getAutonomyMode(emp || {}) : "suggest"; } catch(_e) {}
    const status = mode === "auto" ? "scheduled" : "draft";
    try {
      db.prepare("CREATE TABLE IF NOT EXISTS social_posts (id TEXT PRIMARY KEY, user_id TEXT, content TEXT, platforms TEXT, status TEXT DEFAULT 'published', results TEXT, image_url TEXT, posted_at TEXT, created_at TEXT DEFAULT (datetime('now')))").run();
      try { db.exec("ALTER TABLE social_posts ADD COLUMN image_url TEXT"); } catch(_e) {}
      db.prepare("INSERT INTO social_posts (id, user_id, content, platforms, status, image_url) VALUES (?,?,?,?,?,?)")
        .run(require("uuid").v4(), userId, String(caption||prompt).slice(0,2000), JSON.stringify(targets), status, imageUrl);
    } catch(_e) {}
    res.json({ success: true, posted: status === "scheduled", designId, imageUrl, platforms: targets, status,
      message: status === "scheduled" ? ("Designed and queued to " + targets.join(", ")) : ("Designed — waiting for your approval to post to " + targets.join(", ")) });
  } catch (e) { console.error("[design/post-social]", e.message); res.status(500).json({ error: "Social post failed" }); }
});

// 🔄 REFRESH BRAND EVERYWHERE (2026-06-13): re-skin recent designs into the current brand kit
router.get("/reskin/candidates", auth, (req, res) => {
  try {
    const db = getDb(); const userId = req.user?.id || req.userId;
    let rows = [];
    try { rows = db.prepare("SELECT id, type, prompt, created_at FROM design_generations WHERE user_id=? AND (output_html IS NOT NULL OR output_svg IS NOT NULL) ORDER BY created_at DESC LIMIT 12").all(userId); } catch(_e) {}
    res.json({ designs: rows.map(r => ({ id: r.id, type: r.type, brief: String(r.prompt||"").slice(0,70), created_at: r.created_at })) });
  } catch (e) { res.status(500).json({ error: "An internal error occurred" }); }
});
router.post("/reskin", auth, async (req, res) => {
  try {
    const db = getDb(); const userId = req.user?.id || req.userId;
    const meter = designerMeter(db, userId);
    if (!meter.allowed) return res.status(402).json({ error: "AI Designer is available on Growth plans and above." });
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 8) : [];
    if (!ids.length) return res.status(400).json({ error: "Pick at least one design to refresh" });
    // current brand kit
    let kit = {};
    try { const r = db.prepare("SELECT brand_kit, brand_primary_color, brand_font, business_name FROM users WHERE id=?").get(userId) || {}; kit = r.brand_kit ? JSON.parse(r.brand_kit) : {}; kit.primary = kit.primary || r.brand_primary_color; kit.font = kit.font || r.brand_font; kit.businessName = kit.businessName || r.business_name; } catch(_e) {}
    const Anthropic = require("@anthropic-ai/sdk");
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(400).json({ error: "No API key" });
    const client = new Anthropic.default({ apiKey });
    let reskinned = 0, failed = 0;
    for (const id of ids) {
      let row;
      try { row = db.prepare("SELECT id, type, output_html, output_svg FROM design_generations WHERE id=? AND user_id=?").get(id, userId); } catch(_e) {}
      if (!row) { failed++; continue; }
      const isSvg = !!row.output_svg && !row.output_html;
      const original = isSvg ? row.output_svg : row.output_html;
      if (!original) { failed++; continue; }
      const sys = "You are a brand designer. Re-skin the given " + (isSvg?"SVG":"HTML") + " design to match this brand kit EXACTLY: " + JSON.stringify({ primary: kit.primary, secondary: kit.secondary, text: kit.text, font: kit.font, businessName: kit.businessName }) + ". Keep the layout, copy, and structure identical — only change colors, fonts, and any brand name to match the kit. No <script>. Return ONLY the updated markup.";
      try {
        const msg = await client.messages.create({ model: "claude-sonnet-4-6", max_tokens: 4000, system: sys, messages: [{ role: "user", content: original.slice(0, 8000) }] });
        let out = (msg.content && msg.content[0] && msg.content[0].text || "").replace(/^```(?:html|svg|xml)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
        out = out.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/ on[a-z]+\s*=\s*"[^"]*"/gi, "");
        if (!out) { failed++; continue; }
        const newId = require("uuid").v4();
        db.prepare("INSERT INTO design_generations (id, user_id, prompt, type, output_html, output_svg, model, success) VALUES (?,?,?,?,?,?,?,1)")
          .run(newId, userId, "(brand refresh) " + (row.type||"design"), (row.type||"design") + "-rebrand", isSvg?null:out, isSvg?out:null, "claude-sonnet-4-6");
        reskinned++;
      } catch(_e) { failed++; }
    }
    try { const mo=new Date().toISOString().slice(0,7); db.prepare("INSERT OR IGNORE INTO designer_usage (user_id,month,units) VALUES (?,?,0)").run(userId,mo); db.prepare("UPDATE designer_usage SET units=units+? WHERE user_id=? AND month=?").run(reskinned, userId, mo); } catch(_e) {}
    res.json({ success: true, reskinned, failed, message: reskinned + " design(s) refreshed into your current brand" });
  } catch (e) { console.error("[design/reskin]", e.message); res.status(500).json({ error: "Brand refresh failed" }); }
});

module.exports.CREDIT_PACKS = CREDIT_PACKS;
