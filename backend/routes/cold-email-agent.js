/**
 * TAKEOVA AI Cold Email Agent
 * For each prospect, scrapes their website and uses Claude to write a
 * genuinely personalised first line + full email. Not a template — actual
 * research per contact. Converts 3-5x better than standard templates.
 *
 * Billing:
 *   - $69/mo add-on (all plans)
 *   - $0.12 per email sent — covers Claude + SendGrid + margin
 *   - Admin: unlimited, not billed
 *
 * Cost breakdown per email:
 *   Claude Haiku (research + write): ~$0.003
 *   SendGrid:                        ~$0.001
 *   Total cost:                      ~$0.004
 *   Charge:                           $0.12
 *   Margin:                           ~97%
 */

const express = require("express");
const router  = express.Router();
const { v4: uuid } = require("uuid");
const { getDb, getSetting } = require("../db/init");
const { submitBatch, getBatchResults, waitForBatch, registerBatch, updateBatch } = require("../utils/claude-batch");
const { auth } = require("../middleware/auth");
const rateLimit = require("express-rate-limit");
// Per-tenant agent outcome tracking (safe-loaded; no-op if enhancements unmounted)
let _enh; try { _enh = require("./ai-employees-enhancements"); } catch (_) { _enh = null; }
const recordOutcome = (_enh && _enh.recordOutcome) ? _enh.recordOutcome : function(){};
const updateOutcome = (_enh && _enh.updateOutcome) ? _enh.updateOutcome : function(){};
const multer = require("multer");
const path   = require("path");
const fs     = require("fs");

// CSV upload — store in uploads/cold-email-lists, auto-cleaned after parse
const ceUpload = multer({
  dest: path.join(__dirname, "../uploads/cold-email-lists"),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = [".csv",".txt"].includes(path.extname(file.originalname).toLowerCase());
    cb(null, ok);
  }
});

function parseCSVLine(line) {
  const result = []; let current = ""; let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === "," && !inQuotes) { result.push(current); current = ""; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

const coldEmailLimiter = rateLimit({ windowMs: 60_000, max: 5, keyGenerator: r => r.userId || r.ip });

const COLD_EMAIL_PRICE = 0.12; // $0.12 per email sent

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cold_email_campaigns (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      name         TEXT,
      subject      TEXT,
      goal         TEXT,
      your_offer   TEXT,
      status       TEXT DEFAULT 'pending',
      total_sent   INTEGER DEFAULT 0,
      total_opened INTEGER DEFAULT 0,
      total_replied INTEGER DEFAULT 0,
      error        TEXT,
      created_at   TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS cold_email_prospects (
      id           TEXT PRIMARY KEY,
      campaign_id  TEXT NOT NULL,
      user_id      TEXT NOT NULL,
      name         TEXT,
      email        TEXT NOT NULL,
      website_url  TEXT,
      company      TEXT,
      scraped_text TEXT,
      personalised_line TEXT,
      full_email   TEXT,
      status       TEXT DEFAULT 'pending',
      sent_at      TEXT,
      opened_at    TEXT,
      replied_at   TEXT,
      created_at   TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cold_campaigns_user ON cold_email_campaigns(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_cold_prospects_campaign ON cold_email_prospects(campaign_id);
  `);
}

function hasColdEmailAddon(db, userId) {
  try {
    // Newer system: ai_employee_subscriptions (Stripe-managed)
    const newSys = db.prepare(
      "SELECT id FROM ai_employee_subscriptions WHERE user_id=? AND employee_id IN ('cold_email','cold_email_agent') AND status='active'"
    ).get(userId);
    if (newSys) return true;
    // Legacy: user_addons
    const row = db.prepare("SELECT id FROM user_addons WHERE user_id = ? AND addon_id = 'cold_email_agent' AND status = 'active'").get(userId);
    return !!row;
  } catch(e) { return false; }
}

// ── POST /api/cold-email/upload ── parse a CSV and return prospects array ────────
// Accepts columns: email (required), name, first_name, company, website, url
// Returns parsed prospects so the user can preview before launching a campaign
router.post("/upload", auth, ceUpload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  // Magic-byte validation — reject binary files masquerading as CSV
  const { validateUploadedFile } = require("../lib/file-validator");
  const validation = validateUploadedFile(req.file.path, "text");
  if (!validation.valid) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(400).json({ error: "Invalid file: " + validation.reason });
  }

  let raw;
  try {
    raw = fs.readFileSync(req.file.path, "utf8");
  } finally {
    try { fs.unlinkSync(req.file.path); } catch(e) {}
  }

  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return res.status(400).json({ error: "CSV needs a header row and at least one contact" });

  const headers = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/['"]/g, ""));

  // Must have an email column
  const emailIdx = headers.findIndex(h => h === "email" || h === "email address" || h === "e-mail");
  if (emailIdx === -1) return res.status(400).json({ error: "CSV must have an 'email' column" });

  const prospects = [];
  const seen = new Set();

  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    const row  = {};
    headers.forEach((h, j) => { row[h] = vals[j]?.trim().replace(/^["']|["']$/g, "") || ""; });

    const email = row.email || row["email address"] || row["e-mail"] || "";
    if (!email || !email.includes("@") || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());

    // Normalise name fields
    const firstName = row.first_name || row.firstname || "";
    const lastName  = row.last_name  || row.lastname  || "";
    const fullName  = row.name || row.full_name || row.contact ||
                      (firstName && lastName ? firstName + " " + lastName : firstName || "");

    prospects.push({
      name:    fullName,
      email:   email.toLowerCase(),
      company: row.company || row.business || row.organisation || row.organization || row["company name"] || "",
      website: row.website || row.url || row["website url"] || row.domain || "",
    });
  }

  if (!prospects.length) return res.status(400).json({ error: "No valid email addresses found in CSV" });

  res.json({
    success: true,
    total:   prospects.length,
    prospects,
    sample:  prospects.slice(0, 3),
    columns: headers,
  });
});

// ── GET /api/cold-email/settings ──────────────────────────────────────────────
router.get("/settings", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const user = db.prepare("SELECT plan, role, name, outreach_display_name FROM users WHERE id = ?").get(req.userId);
  const isAdmin = user?.role === "admin";
  const plan = user?.plan || "starter";
  const hasAddon = hasColdEmailAddon(db, req.userId);
  const period = new Date().toISOString().slice(0, 7);
  const used = db.prepare("SELECT COUNT(*) as c FROM cold_email_prospects WHERE user_id = ? AND status = 'sent' AND strftime('%Y-%m', created_at) = ?").get(req.userId, period)?.c || 0;
  const campaigns = db.prepare("SELECT id, name, status, total_sent, total_opened, total_replied, created_at FROM cold_email_campaigns WHERE user_id = ? ORDER BY created_at DESC LIMIT 20").all(req.userId);
  // Compute the auto-generated FROM address so UI can display it
  const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
  const displayName = user?.outreach_display_name || user?.name || site?.name || "hello";
  const emailDomain = getSetting("EMAIL_FROM_DOMAIN") || process.env.EMAIL_FROM_DOMAIN || "takeova.ai";
  const bizSlug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 30) || "hello";
  const autoFromEmail = `${bizSlug}@${emailDomain}`;
  res.json({ plan, isAdmin, hasAddon, used, pricePerEmail: COLD_EMAIL_PRICE, addonPrice: 69, campaigns, autoFromEmail, displayName });
});

// ── POST /api/cold-email/campaign ── create and run a campaign ────────────────
router.post("/campaign", auth, coldEmailLimiter, async (req, res) => {
  const db = getDb();
  ensureTables(db);
  const user = db.prepare("SELECT plan, role FROM users WHERE id = ?").get(req.userId);
  const isAdmin = user?.role === "admin";

  const hasAddon = hasColdEmailAddon(db, req.userId);
  if (!isAdmin && !hasAddon) {
    return res.status(403).json({ error: "AI Cold Email Agent requires the add-on ($69/mo).", upgrade: true });
  }

  const { name, prospects, subject: rawSubject, goal: rawGoal, yourOffer: rawOffer, yourName: rawYourName, yourBusiness: rawYourBiz, replyTo: rawReplyTo } = req.body;
  if (!prospects?.length) return res.status(400).json({ error: "At least one prospect required" });

  // Strip CRLF from every header field to prevent SMTP header injection.
  // Cap field lengths to prevent prompt-injection-style abuse of the
  // per-prospect Anthropic call (the goal/offer/business fields all get
  // templated into the LLM prompt, so their size directly drives token cost).
  const stripCtl = s => String(s || "").replace(/[\r\n\0]/g, "").trim();
  const subject = stripCtl(rawSubject).slice(0, 200);
  const goal = stripCtl(rawGoal).slice(0, 500);
  const yourOffer = stripCtl(rawOffer).slice(0, 500);
  const yourName = stripCtl(rawYourName).slice(0, 120);
  const yourBusiness = stripCtl(rawYourBiz).slice(0, 120);

  if (!subject) return res.status(400).json({ error: "Email subject required" });
  if (!goal) return res.status(400).json({ error: "Campaign goal required (what do you want them to do?)" });

  // replyTo must be a valid email or dropped entirely — no header smuggling.
  let replyTo = null;
  if (rawReplyTo) {
    const cleaned = stripCtl(rawReplyTo);
    if (/^[^\s<>"]+@[^\s<>"]+\.[^\s<>"]+$/.test(cleaned) && cleaned.length <= 254) {
      replyTo = cleaned;
    }
  }

  const safeMax = isAdmin ? 1000 : 200;
  const safePros = prospects.slice(0, safeMax);

  const campaignId = uuid();
  db.prepare("INSERT INTO cold_email_campaigns (id, user_id, name, subject, goal, your_offer, status) VALUES (?,?,?,?,?,?,?)")
    .run(campaignId, req.userId, name || `Campaign ${new Date().toLocaleDateString()}`, subject, goal, yourOffer || "", "running");

  // Insert prospect rows — strip CRLF and email-validate each.
  const insertPros = db.prepare("INSERT INTO cold_email_prospects (id, campaign_id, user_id, name, email, website_url, company, status) VALUES (?,?,?,?,?,?,?,?)");
  for (const p of safePros) {
    const email = stripCtl(p.email);
    if (!email || !/^[^\s<>"]+@[^\s<>"]+\.[^\s<>"]+$/.test(email)) continue;
    insertPros.run(uuid(), campaignId, req.userId,
      stripCtl(p.name).slice(0, 120),
      email.slice(0, 254),
      stripCtl(p.website || p.url || "").slice(0, 500) || null,
      stripCtl(p.company).slice(0, 120),
      "pending");
  }

  res.json({ success: true, campaignId, total: safePros.length });

  // Run async
  runColdEmailCampaign(db, req.userId, campaignId, { subject, goal, yourOffer, yourName, yourBusiness, replyTo, isAdmin }).catch(e => {
    console.error("[ColdEmail] Campaign error:", e.message);
    db.prepare("UPDATE cold_email_campaigns SET status = 'failed', error = ? WHERE id = ?").run(e.message, campaignId);
  });
});

async function runColdEmailCampaign(db, userId, campaignId, opts) {
  const fetch = (await import("node-fetch")).default;
  const { subject, goal, yourOffer, yourName, yourBusiness, replyTo, isAdmin } = opts;

  // ─── Subscription gate ────────────────────────────────────────────────
  // Customer must have hired AI Cold Email Agent to use this. Admins bypass.
  if (!isAdmin && typeof global.mineRequireHired === "function") {
    if (!global.mineRequireHired(db, userId, "cold_email")) {
      throw new Error("AI Cold Email Agent not hired. Please hire from the AI Employees panel ($69/mo).");
    }
  }

  const claudeKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
  const sgKey     = getSetting("SENDGRID_API_KEY")   || process.env.SENDGRID_API_KEY;
  const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";

  if (!claudeKey) throw new Error("ANTHROPIC_API_KEY not configured");
  if (!sgKey)     throw new Error("SENDGRID_API_KEY not configured");

  // Get sender's business context — fetch user row first so sender details are available
  const site       = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(userId);
  const userRow    = db.prepare("SELECT name, outreach_display_name FROM users WHERE id = ?").get(userId);
  const bizName    = yourBusiness || site?.name || "My Business";

  // Display name: outreach name set in Settings → account name → business name
  const displayName = yourName || userRow?.outreach_display_name || userRow?.name || bizName;
  const senderName  = displayName;

  // Auto-generate FROM address: businessname@sending-domain
  // Admin sets EMAIL_FROM_DOMAIN in Admin → Settings (default: takeova.ai)
  // They must authenticate this domain in SendGrid for emails to send correctly
  const emailDomain   = getSetting("EMAIL_FROM_DOMAIN") || process.env.EMAIL_FROM_DOMAIN || "takeova.ai";
  const bizSlug       = displayName.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 30) || "hello";
  const fromEmail     = `${bizSlug}@${emailDomain}`;

  const prospects = db.prepare("SELECT * FROM cold_email_prospects WHERE campaign_id = ? AND status = 'pending'").all(campaignId);
  let sent = 0;

  // ── BATCH MODE: pre-generate all email bodies at once (50% cheaper) ──────
  // Submit all prospects to Anthropic Batch API before scraping/sending
  // Results are fetched after batch completes, then used per-prospect below
  let batchResults = null;
  if (prospects.length >= 5 && claudeKey) {
    try {
      // We build prompts with just prospect info (no scraped context yet — scraping happens per-prospect)
      // This is a best-effort batch using available info; scraped context improves sequential quality
      const batchReqs = prospects.map(p => ({
        customId: p.id,
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 300,
        prompt: `You are an expert cold email copywriter. Write a short, genuine, high-converting cold email.

SENDER: ${senderName} at ${bizName}. Offer: ${yourOffer || 'business services'}. Goal: ${goal}.
PROSPECT: ${p.name || 'there'} at ${p.company || 'their company'}${p.website_url ? ` (${p.website_url})` : ''}.

Write an email that: opens with a specific observation about their likely business challenges, connects to the offer, one clear CTA, 4-6 sentences, conversational, never starts with "I".
Return ONLY the email body. No greeting. No subject. Plain text.`
      }));

      const batchId = await submitBatch(batchReqs);
      registerBatch(db, batchId, 'cold_email', campaignId, userId, prospects.length);
      await waitForBatch(batchId, 90 * 60_000, 20_000);
      batchResults = await getBatchResults(batchId);
      updateBatch(db, batchId, 'complete', Object.keys(batchResults).length);
    } catch(e) {
      console.error('[ColdEmail] Batch failed, falling back to sequential:', e.message);
      batchResults = null;
    }
  }

  for (const prospect of prospects) {
    try {
      // Check campaign not cancelled
      const camp = db.prepare("SELECT status FROM cold_email_campaigns WHERE id = ?").get(campaignId);
      if (camp?.status === "cancelled") break;

      // ── Step 1: Scrape prospect's website ──────────────────────────────
      let prospectContext = "";
      if (prospect.website_url) {
        try {
          const r = await fetch(prospect.website_url, { timeout: 6000, headers: { "User-Agent": "Mozilla/5.0" } });
          const html = await r.text();
          const text = html
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 1500);
          prospectContext = text;
          db.prepare("UPDATE cold_email_prospects SET scraped_text = ? WHERE id = ?").run(text.slice(0, 300), prospect.id);
        } catch(e) { console.error("[/campaign]", e.message || e); }
      }

      // ── Step 2: Claude writes personalised email (batch or sequential) ──
      const emailPrompt = `You are an expert cold email copywriter. Write a short, genuine, high-converting cold email.

SENDER:
- Name: ${senderName}
- Business: ${bizName}
- Offer: ${yourOffer || "business services"}
- Goal: ${goal}

PROSPECT:
- Name: ${prospect.name || "there"}
- Company: ${prospect.company || "their company"}
${prospect.website_url ? `- Website: ${prospect.website_url}` : ""}
${prospectContext ? `- What their business does (from website): ${prospectContext.slice(0, 800)}` : ""}

Write a cold email that:
1. Opens with a HIGHLY SPECIFIC observation about their business (not generic — reference something real from their website/context)
2. Connects that observation to why you're reaching out
3. States the offer in one sentence — what's in it for them specifically
4. Has ONE clear call to action
5. Is short (4-6 sentences total), conversational, human-sounding
6. Does NOT start with "I" or "My name is"
7. Does NOT use hollow phrases like "I hope this finds you well" or "I wanted to reach out"

Return ONLY the email body text. No subject line. No greeting. Plain text, no HTML.`;

      let emailBody = "";
      if (batchResults && batchResults[prospect.id]) {
        // Batch result already available
        emailBody = batchResults[prospect.id]?.text?.trim() || "";
      } else {
        // Sequential fallback
        const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": claudeKey, "content-type": "application/json", "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 300, messages: [{ role: "user", content: emailPrompt }] })
        });
        const aiData = await aiRes.json();
        emailBody = aiData.content?.[0]?.text?.trim() || "";
      }

      if (!emailBody) {
        db.prepare("UPDATE cold_email_prospects SET status = 'failed' WHERE id = ?").run(prospect.id);
        continue;
      }

      const greeting = prospect.name ? `Hi ${prospect.name.split(" ")[0]},` : "Hi there,";
      const fullEmail = `${greeting}\n\n${emailBody}\n\n${senderName}\n${bizName}`;
      const trackingPixel = `${frontendUrl}/api/cold-email/open/${prospect.id}`;

      // ── Step 3: Send via SendGrid ──────────────────────────────────────
      const emailHtml = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.7;color:#1e293b;max-width:580px;">
${fullEmail.split("\n").map(l => l ? `<p style="margin:0 0 12px">${l}</p>` : "").join("")}
<img src="${trackingPixel}" width="1" height="1" style="display:none" alt=""/>
<p style="margin-top:32px;font-size:11px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:16px;">
  <a href="${frontendUrl}/unsubscribe" style="color:#94a3b8;">Unsubscribe</a>
</p></div>`;

      const sendRes = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { "Authorization": `Bearer ${sgKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: prospect.email, name: prospect.name || "" }] }],
          from: { email: fromEmail, name: senderName },
          reply_to: replyTo ? { email: replyTo } : undefined,
          subject,
          content: [
            { type: "text/plain", value: fullEmail },
            { type: "text/html",  value: emailHtml }
          ]
        })
      });

      if (sendRes.status < 300) {
        db.prepare("UPDATE cold_email_prospects SET personalised_line = ?, full_email = ?, status = 'sent', sent_at = datetime('now') WHERE id = ?")
          .run(emailBody.slice(0, 200), fullEmail, prospect.id);
        db.prepare("UPDATE cold_email_campaigns SET total_sent = total_sent + 1 WHERE id = ?").run(campaignId);
        sent++;
        try { recordOutcome(prospect.id, userId, 'cold_email', 'send_email', 'no_response', { prospect_id: prospect.id, campaign_id: campaignId }); } catch(_){}

        // Bill $0.12 per email
        if (!isAdmin) {
          const period = new Date().toISOString().slice(0, 7);
          db.prepare("INSERT INTO overage_charges (id, user_id, metric, quantity, unit_price, total, period, status) VALUES (?,?,?,?,?,?,?,?)")
            .run(uuid(), userId, "coldEmails", 1, COLD_EMAIL_PRICE, COLD_EMAIL_PRICE, period, "pending");
        }
      } else {
        db.prepare("UPDATE cold_email_prospects SET status = 'failed' WHERE id = ?").run(prospect.id);
      }

      await new Promise(r => setTimeout(r, 300)); // rate limit
    } catch(e) {
      console.error("[ColdEmail] Prospect error:", e.message);
      db.prepare("UPDATE cold_email_prospects SET status = 'failed' WHERE id = ?").run(prospect.id);
      try { recordOutcome(prospect.id, userId, 'cold_email', 'send_email', 'failed', { prospect_id: prospect.id, error: String(e.message||'').slice(0,200) }); } catch(_){}
    }
  }

  db.prepare("UPDATE cold_email_campaigns SET status = 'complete', completed_at = datetime('now') WHERE id = ?").run(campaignId);
}

// ── GET /api/cold-email/campaign/:id ── poll status ───────────────────────────
router.get("/campaign/:id", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const campaign = db.prepare("SELECT * FROM cold_email_campaigns WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  const prospects = db.prepare("SELECT id, name, email, company, website_url, personalised_line, status, sent_at, opened_at, replied_at FROM cold_email_prospects WHERE campaign_id = ? ORDER BY created_at ASC").all(req.params.id);
  res.json({ campaign, prospects });
});

// ── GET /api/cold-email/open/:prospectId ── pixel tracking (public) ───────────
router.get("/open/:prospectId", (req, res) => {
  try {
    const db = getDb();
    // Only count as open if this is the FIRST time (opened_at was NULL)
    const prospect = db.prepare("SELECT opened_at, campaign_id FROM cold_email_prospects WHERE id = ?").get(req.params.prospectId);
    if (prospect && !prospect.opened_at) {
      db.prepare("UPDATE cold_email_prospects SET opened_at = datetime('now') WHERE id = ?").run(req.params.prospectId);
      db.prepare("UPDATE cold_email_campaigns SET total_opened = total_opened + 1 WHERE id = ?").run(prospect.campaign_id);
      try { updateOutcome(req.params.prospectId, 'cold_email', 'success', { opened: true }); } catch(_){}
    }
  } catch(e) { console.error("[/open/:prospectId]", e.message || e); }
  // Return 1x1 transparent GIF
  const pixel = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Cache-Control", "no-store");
  res.send(pixel);
});

// ── Shared helper for both cron and user-triggered follow-ups ─────────────────
// userId=null + isCron=true  → scan all users (cron mode)
// userId=<id> + isCron=false → scan only that user's prospects
async function runFollowupsLogic(db, opts) {
  const { userId = null, isCron = false } = opts || {};
  const fetch = (await import("node-fetch")).default;
  const sgKey = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
  const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";
  let sent = 0;

  try { db.exec("ALTER TABLE cold_email_prospects ADD COLUMN followup1_sent_at TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE cold_email_prospects ADD COLUMN followup2_sent_at TEXT"); } catch(e) {}

  if (!sgKey) return { sent: 0, error: "SendGrid not configured" };

  const userFilter = userId ? "AND p.user_id = ?" : "";
  const userParams = userId ? [userId] : [];

  // Day 3 follow-up: sent 2-4 days ago, not opened, no follow-up yet
  const day3 = db.prepare(`
    SELECT p.*, c.subject, c.goal, c.your_offer, u.name as sender_name, u.outreach_display_name, s.name as biz_name
    FROM cold_email_prospects p
    JOIN cold_email_campaigns c ON p.campaign_id = c.id
    JOIN users u ON p.user_id = u.id
    LEFT JOIN sites s ON s.user_id = p.user_id
    WHERE p.status = 'sent' AND p.opened_at IS NULL AND p.followup1_sent_at IS NULL
    ${userFilter}
    AND p.sent_at <= datetime('now', '-2 days')
    AND p.sent_at >= datetime('now', '-5 days')
    LIMIT 200
  `).all(...userParams);

  for (const p of day3) {
    if (!p.email) continue;
    try {
      const displayName = p.outreach_display_name || p.sender_name || p.biz_name || "there";
      const fromEmail = (displayName.toLowerCase().replace(/[^a-z0-9]+/g,"").slice(0,30)||"hello") + "@" + (getSetting("EMAIL_FROM_DOMAIN")||process.env.EMAIL_FROM_DOMAIN||"takeova.ai");
      const pixel = `${frontendUrl}/api/cold-email/open/${p.id}`;
      const greeting = p.name ? `Hi ${p.name.split(" ")[0]},` : "Hi there,";
      const body = `${greeting}

Just wanted to follow up on my note from a few days ago — did it land at a bad time?

I know inboxes get busy. Happy to keep it brief: ${p.your_offer || "I think there's a real fit here"}.

Worth a 15-minute call this week?

${displayName}`;
      const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.7;color:#1e293b;max-width:580px">${body.split("\n").map(l=>l?`<p style="margin:0 0 12px">${l}</p>`:"").join("")}<img src="${pixel}" width="1" height="1" style="display:none" alt=""/><p style="margin-top:32px;font-size:11px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:16px"><a href="${frontendUrl}/unsubscribe" style="color:#94a3b8">Unsubscribe</a></p></div>`;
      const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method:"POST",headers:{"Authorization":`Bearer ${sgKey}`,"Content-Type":"application/json"},
        body:JSON.stringify({personalizations:[{to:[{email:p.email,name:p.name||""}]}],from:{email:fromEmail,name:displayName},subject:`Re: ${p.subject}`,content:[{type:"text/plain",value:body},{type:"text/html",value:html}]})
      });
      if (r.status < 300) {
        db.prepare("UPDATE cold_email_prospects SET followup1_sent_at = datetime('now') WHERE id = ?").run(p.id);
        sent++;
      }
    } catch(e) { console.error("[runFollowupsLogic/day3]", e.message || e); }
  }

  // Day 7 final follow-up
  const day7 = db.prepare(`
    SELECT p.*, c.subject, u.name as sender_name, u.outreach_display_name, s.name as biz_name
    FROM cold_email_prospects p
    JOIN cold_email_campaigns c ON p.campaign_id = c.id
    JOIN users u ON p.user_id = u.id
    LEFT JOIN sites s ON s.user_id = p.user_id
    WHERE p.status = 'sent' AND p.opened_at IS NULL
    AND p.followup1_sent_at IS NOT NULL AND p.followup2_sent_at IS NULL
    ${userFilter}
    AND p.followup1_sent_at <= datetime('now', '-3 days')
    LIMIT 200
  `).all(...userParams);

  for (const p of day7) {
    if (!p.email) continue;
    try {
      const displayName = p.outreach_display_name || p.sender_name || p.biz_name || "there";
      const fromEmail = (displayName.toLowerCase().replace(/[^a-z0-9]+/g,"").slice(0,30)||"hello") + "@" + (getSetting("EMAIL_FROM_DOMAIN")||process.env.EMAIL_FROM_DOMAIN||"takeova.ai");
      const greeting = p.name ? `Hi ${p.name.split(" ")[0]},` : "Hi there,";
      const body = `${greeting}

Last one from me — I don't want to clutter your inbox.

If the timing isn't right or this isn't relevant, completely understand. Just reply "not interested" and I'll leave you alone.

But if there's any chance it could help, I'd love 10 minutes.

${displayName}`;
      const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.7;color:#1e293b;max-width:580px">${body.split("\n").map(l=>l?`<p style="margin:0 0 12px">${l}</p>`:"").join("")}<p style="margin-top:32px;font-size:11px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:16px"><a href="${frontendUrl}/unsubscribe" style="color:#94a3b8">Unsubscribe</a></p></div>`;
      const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method:"POST",headers:{"Authorization":`Bearer ${sgKey}`,"Content-Type":"application/json"},
        body:JSON.stringify({personalizations:[{to:[{email:p.email,name:p.name||""}]}],from:{email:fromEmail,name:displayName},subject:`Re: ${p.subject}`,content:[{type:"text/plain",value:body},{type:"text/html",value:html}]})
      });
      if (r.status < 300) {
        db.prepare("UPDATE cold_email_prospects SET followup2_sent_at = datetime('now') WHERE id = ?").run(p.id);
        sent++;
      }
    } catch(e) { console.error("[runFollowupsLogic/day7]", e.message || e); }
  }

  return { sent };
}

// ── POST /api/cold-email/run-followups ── USER-triggered, user-scoped ─────────
// Same logic as /followups but only for the calling user's prospects.
// Uses standard auth so the dashboard "Send Follow-ups" button works.
router.post("/run-followups", auth, async (req, res) => {
  const db = getDb();
  ensureTables(db);
  try {
    const result = await runFollowupsLogic(db, { userId: req.userId, isCron: false });
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ success: true, sent: result.sent });
  } catch(e) {
    console.error("[/run-followups]", e.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ── POST /api/cold-email/followups ── CRON-triggered, all users ───────────────
router.post("/followups", async (req, res) => {
  const cronKey = process.env.CRON_SECRET || "";
  const supplied = req.headers["x-cron-key"] || "";
  if (!cronKey || supplied.length !== cronKey.length) return res.status(401).json({ error: "Unauthorized" });
  const crypto = require("crypto");
  if (!crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(cronKey))) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  ensureTables(db);
  try {
    const result = await runFollowupsLogic(db, { userId: null, isCron: true });
    res.json({ success: true, sent: result.sent });
  } catch(e) {
    console.error("[/followups cron]", e.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ── POST /api/cold-email/cancel/:id ── cancel a running campaign ──────────────
router.post("/cancel/:id", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const campaign = db.prepare("SELECT * FROM cold_email_campaigns WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  if (campaign.status !== "running") return res.status(400).json({ error: "Campaign not running" });
  db.prepare("UPDATE cold_email_campaigns SET status = 'cancelled', completed_at = datetime('now') WHERE id = ?").run(campaign.id);
  res.json({ success: true });
});

module.exports = router;
