/**
 * MINE Prospector Agent
 * Finds mid-ranking local businesses, generates demo sites, sends outreach
 * via email and SMS.
 *
 * Billing:
 *   - $79/mo add-on (Pro/Enterprise only)
 *   - $0.50 per demo generated — charged on every demo, no free tier included
 *   - Admin accounts: unlimited, no billing
 *
 * Channels:
 *   - Email via SendGrid
 *   - SMS via Twilio (mobile numbers only, confirmed via Twilio Lookup)

 */

const express  = require("express");
const router   = express.Router();
const { v4: uuid } = require("uuid");
const { getDb, getSetting } = require("../db/init");
const { auth }  = require("../middleware/auth");
const rateLimit = require("express-rate-limit");
const { sendSms, getSmsSender } = require("../utils/sms");
const { submitBatch, getBatchResults, waitForBatch, registerBatch, updateBatch } = require("../utils/claude-batch");

const prospectorLimiter = rateLimit({ windowMs: 60_000, max: 5, keyGenerator: r => r.userId || r.ip });

// ── Helpers ────────────────────────────────────────────────────────────────

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prospector_campaigns (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      city        TEXT NOT NULL,
      category    TEXT NOT NULL,
      status      TEXT DEFAULT 'pending',
      total_found INTEGER DEFAULT 0,
      demos_built INTEGER DEFAULT 0,
      emails_sent INTEGER DEFAULT 0,
      sms_sent    INTEGER DEFAULT 0,
      cards_sent  INTEGER DEFAULT 0,
      clicks      INTEGER DEFAULT 0,
      signups     INTEGER DEFAULT 0,
      error       TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS prospector_leads (
      id            TEXT PRIMARY KEY,
      campaign_id   TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      business_name TEXT,
      website_url   TEXT,
      phone         TEXT,
      phone_type    TEXT,
      email         TEXT,
      address       TEXT,
      city          TEXT,
      category      TEXT,
      google_rating REAL,
      google_reviews INTEGER,
      demo_slug     TEXT UNIQUE,
      demo_html     TEXT,
      outreach_channel TEXT,
      outreach_status  TEXT DEFAULT 'pending',
      outreach_sent_at TEXT,
      clicked_at    TEXT,
      signed_up     INTEGER DEFAULT 0,
      followup1_sent_at TEXT,
      followup2_sent_at TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS prospector_demos (
      slug        TEXT PRIMARY KEY,
      user_id     TEXT,
      lead_id     TEXT,
      html        TEXT NOT NULL,
      business_name TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      expires_at  TEXT,
      views       INTEGER DEFAULT 0,
      last_viewed TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_prospector_campaigns_user ON prospector_campaigns(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_prospector_leads_campaign ON prospector_leads(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_prospector_demos_slug     ON prospector_demos(slug);
  `);
  // Add follow-up columns to existing tables safely
  try { db.exec("ALTER TABLE prospector_leads ADD COLUMN followup1_sent_at TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE prospector_leads ADD COLUMN outreach_intro TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE prospector_leads ADD COLUMN interested INTEGER DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE prospector_leads ADD COLUMN interested_at TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE prospector_leads ADD COLUMN research_text TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE prospector_leads ADD COLUMN email_subject TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE prospector_leads ADD COLUMN email_body TEXT"); } catch(e) {}

  try { db.exec("ALTER TABLE prospector_leads ADD COLUMN interest_name TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE prospector_leads ADD COLUMN interest_email TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE prospector_leads ADD COLUMN interest_phone TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE prospector_leads ADD COLUMN interest_note TEXT"); } catch(e) {}

  try { db.exec("ALTER TABLE prospector_leads ADD COLUMN followup2_sent_at TEXT"); } catch(e) {}

  // Lead Finder (discovery mode): fit score against the buyer's ICP + signals
  try { db.exec("ALTER TABLE prospector_leads ADD COLUMN fit_score INTEGER"); } catch(e) {}
  try { db.exec("ALTER TABLE prospector_leads ADD COLUMN fit_reason TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE prospector_leads ADD COLUMN signals TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE prospector_campaigns ADD COLUMN mode TEXT DEFAULT 'campaign'"); } catch(e) {}
  try { db.exec("ALTER TABLE prospector_campaigns ADD COLUMN icp_prompt TEXT"); } catch(e) {}
}

function getPlanDemoLimit(plan, isAdmin) {
  if (isAdmin) return Infinity;
  return 0; // No included demos — requires Prospector add-on ($79/mo)
}

function getDemoOveragePrice(plan) {
  return 0.50; // $0.50 per demo over monthly quota
}

function hasProspectorAddon(db, userId) {
  try {
    // Newer system: ai_employee_subscriptions (Stripe-managed)
    const newSys = db.prepare(
      "SELECT id FROM ai_employee_subscriptions WHERE user_id=? AND employee_id IN ('prospector','prospector_agent') AND status='active'"
    ).get(userId);
    if (newSys) return true;
    // Legacy: user_addons
    const row = db.prepare("SELECT id FROM user_addons WHERE user_id = ? AND addon_id = 'prospector_agent' AND status = 'active'").get(userId);
    return !!row;
  } catch(e) { return false; }
}

function slugify(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim()
    .slice(0, 50) + "-" + Math.random().toString(36).slice(2, 7);
}

// ── GET /api/prospector/settings ── check plan limits + usage ─────────────
router.get("/settings", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const user = db.prepare("SELECT plan, role FROM users WHERE id = ?").get(req.userId);
  const isAdmin = user?.role === "admin";
  const plan = user?.plan || "starter";
  const hasAddon = hasProspectorAddon(db, req.userId);
  const period = new Date().toISOString().slice(0, 7);
  const used = db.prepare("SELECT COUNT(*) as c FROM prospector_leads WHERE user_id = ? AND demo_slug IS NOT NULL AND strftime('%Y-%m', created_at) = ?").get(req.userId, period)?.c || 0;

  // Both admin and users see only their OWN campaigns here
  const campaigns = db.prepare("SELECT id, city, category, status, total_found, demos_built, emails_sent, sms_sent, clicks, signups, created_at FROM prospector_campaigns WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").all(req.userId);

  const lfUsed = leadUsageThisMonth(db, req.userId);
  const lfIncluded = isAdmin ? null : getLeadQuota(plan, false);
  res.json({ plan, isAdmin, hasAddon, used, overagePrice: 0.50, addonPrice: 79, campaigns,
    leadFinder: { used: lfUsed, included: lfIncluded, overagePrice: getLeadOveragePrice(plan), unlimited: !!isAdmin } });
});

// ── POST /api/prospector/run ── start a campaign ──────────────────────────
router.post("/run", auth, prospectorLimiter, async (req, res) => {
  const db = getDb();
  ensureTables(db);
  const user = db.prepare("SELECT plan, role, email FROM users WHERE id = ?").get(req.userId);
  const isAdmin = user?.role === "admin";
  const plan = user?.plan || "starter";

  // Prospector requires the $79/mo add-on (Pro/Enterprise only)
  const hasAddon = hasProspectorAddon(db, req.userId);
  if (!isAdmin && !hasAddon) {
    return res.status(403).json({ error: "Prospector Agent requires the Prospector add-on ($79/mo). Available on Pro and Enterprise plans.", upgrade: true });
  }

  const { city, category, maxLeads = 20, channels = ["email", "sms"], preview } = req.body;
  // Resolve preview: explicit body value wins, else read from agent rules, else default true (safety)
  let previewMode = preview;
  if (previewMode === undefined) {
    try {
      const empRow = db.prepare("SELECT rules FROM ai_employees WHERE user_id = ? AND role = 'prospector'").get(req.userId);
      if (empRow) {
        const rules = JSON.parse(empRow.rules || "{}");
        previewMode = rules.preview_mode === "no" ? false : true; // default true
      } else { previewMode = true; }
    } catch(_) { previewMode = true; }
  }
  const safeChannels = channels.filter(c => c !== "postcard"); // postcard not implemented
  const safeMax = Math.min(maxLeads, isAdmin ? 10000 : plan === "enterprise" ? 1000 : 200);
  if (!city || !category) return res.status(400).json({ error: "City and category required" });

  const campaignId = uuid();
  db.prepare("INSERT INTO prospector_campaigns (id, user_id, city, category, status) VALUES (?,?,?,?,?)")
    .run(campaignId, req.userId, city, category, "running");

  res.json({ success: true, campaignId, message: `Prospector started for ${category} in ${city}` });

  // Ensure cancel column exists
  try { db.exec("ALTER TABLE prospector_campaigns ADD COLUMN cancelled INTEGER DEFAULT 0"); } catch(e) {}

  // Run async — don't block the response
  runProspectorCampaign(db, req.userId, campaignId, city, category, safeMax, safeChannels, isAdmin, plan, previewMode).catch(e => {
    console.error("[Prospector] Campaign error:", e.message);
    db.prepare("UPDATE prospector_campaigns SET status = 'failed', error = ? WHERE id = ?").run(e.message, campaignId);
  });
});


// ─── Per-business Perplexity research ───
// Returns null on any failure — calling code must handle the null case.
async function prospectResearch(bizName, city, category, fetch) {
  const perplexityKey = (typeof getSetting === "function" && getSetting("PERPLEXITY_API_KEY")) || process.env.PERPLEXITY_API_KEY;
  if (!perplexityKey) return null;
  try {
    const query = `Tell me about ${bizName}, a ${category} in ${city}. What are they known for? Any recent news, expansion, awards, notable services or unique angles? Keep response under 120 words. If you can't find specific info, say so honestly.`;
    const r = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + perplexityKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          { role: "system", content: "You are a sales research analyst. Give specific, factual findings about local businesses. Mention services, USPs, recent activity. No fluff. Under 120 words." },
          { role: "user", content: query }
        ],
        temperature: 0.2,
        return_citations: false,
        search_recency_filter: "month"
      })
    });
    if (!r.ok) return null;
    const d = await r.json();
    const text = d.choices?.[0]?.message?.content?.trim() || "";
    if (text.length < 30) return null;
    return text;
  } catch(e) {
    console.warn("[prospectResearch]", e.message);
    return null;
  }
}

// ─── Generate personalized cold email using Claude + research ───
// Returns { subject, html } or null on failure (caller uses generic template).
async function generatePersonalizedEmail(bizName, city, category, research, demoUrl, frontendUrl, fetch) {
  const claudeKey = (typeof getSetting === "function" && getSetting("ANTHROPIC_API_KEY")) || process.env.ANTHROPIC_API_KEY;
  if (!claudeKey) return null;
  try {
    const prompt = `Write a short, warm cold email to a local business about a free demo website we built for them.

Business: ${bizName}
Location: ${city}
Category: ${category}

What we know about them (use specific details to personalize):
${research}

Email requirements:
- Subject line: under 60 chars, specific, NOT salesy. Reference something real about them.
- Body: 2 short paragraphs max. First paragraph opens with a SPECIFIC observation about them from the research above (this is the hook). Second paragraph mentions the free demo with the CTA link.
- Conversational tone, not corporate. Like a thoughtful person who actually looked at them.
- No "I hope this email finds you well". No "I wanted to reach out". Just get to the point.
- End with one short sentence acknowledging they can ignore it if not interested.
- DO NOT make up facts. Only reference what's in the research above.

Return JSON only:
{"subject": "...", "body_text": "..."}
The body_text should be plain text (we'll wrap it in HTML). Use \n\n for paragraph breaks.`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": claudeKey, "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }]
      })
    });
    if (!r.ok) return null;
    const d = await r.json();
    let text = d.content?.[0]?.text?.trim() || "";
    // Strip markdown code fences if present
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(text);
    if (!parsed.subject || !parsed.body_text) return null;

    // Wrap body_text in HTML with the demo CTA
    const paragraphs = parsed.body_text.split(/\n\n+/).map(p => `<p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 14px;">${String(p).replace(/</g, "&lt;").replace(/\n/g, "<br>")}</p>`).join("");
    const html = `<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;">${paragraphs}<a href="${demoUrl}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#2563EB,#7C3AED);color:#fff;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;margin:8px 0 14px;">View Your Free Demo →</a><p style="color:#94A3B8;font-size:12px;margin:0;">Link expires in 30 days. <a href="${frontendUrl}/unsubscribe" style="color:#94A3B8;">Unsubscribe</a></p></div>`;

    return { subject: String(parsed.subject).slice(0, 200), html };
  } catch(e) {
    console.warn("[generatePersonalizedEmail]", e.message);
    return null;
  }
}




async function generateEmailOpener(bizName, city, research) {
  const anthropicKey = (typeof getSetting === "function" && getSetting("ANTHROPIC_API_KEY")) || process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey || !research?.text) return null;
  const fetchFn = (await import("node-fetch")).default;
  try {
    const r = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": anthropicKey, "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{
          role: "user",
          content: `You're writing a cold email opener to ${bizName} in ${city}. Here's research on them:\n\n${research.text}\n\nWrite a 1-2 sentence opener that references something specific about their business (use the research). Be human, warm, low-pressure. The opener will be followed by an offer to view a free demo website we built for them. Return ONLY the opener text, no quotes, no preamble.`
        }]
      })
    });
    const d = await r.json();
    const text = d.content?.[0]?.text?.trim() || "";
    return text.replace(/^["'‘“]|["'’”]$/g, "").trim() || null;
  } catch (e) {
    console.error("[Prospector opener]", e.message);
    return null;
  }
}

async function runProspectorCampaign(db, userId, campaignId, city, category, maxLeads, channels, isAdmin, plan, previewMode) {
  const fetch = (await import("node-fetch")).default;

  // Personalization setting (default yes — falls back gracefully if Perplexity unavailable)
  let personalize = true;
  try {
    const empRow = db.prepare("SELECT rules FROM ai_employees WHERE user_id = ? AND role = 'prospector'").get(userId);
    if (empRow) {
      const rules = JSON.parse(empRow.rules || "{}");
      personalize = rules.personalize_outreach !== "no";
    }
  } catch(_) {}

  // ── Step 1: Find businesses via Google Places API ─────────────────────
  const googleKey = getSetting("GOOGLE_PLACES_API_KEY") || process.env.GOOGLE_PLACES_API_KEY;
  if (!googleKey) throw new Error("GOOGLE_PLACES_API_KEY not configured in admin settings");

  // ── Fetch up to 3 pages of Google Places results (max ~60 per query) ──────
  const allPlaces = [];
  const queries = Array.isArray(city)
    ? city.map(c => `${category} in ${c}`)
    : [`${category} in ${city}`];

  for (const q of queries) {
    let pageToken = null;
    let pagesFetched = 0;
    do {
      const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(q)}&key=${googleKey}${pageToken ? `&pagetoken=${pageToken}` : ""}`;
      const pr = await fetch(url);
      const pd = await pr.json();
      const results = pd.results || [];
      allPlaces.push(...results);
      pageToken = pd.next_page_token || null;
      pagesFetched++;
      if (pageToken) await new Promise(r => setTimeout(r, 2000)); // Google requires 2s delay between pages
    } while (pageToken && pagesFetched < 3 && allPlaces.length < maxLeads + 3);
  }

  // Skip top 3 per query (they're winning already), deduplicate by place_id
  const seen = new Set();
  const places = allPlaces.filter(pl => {
    if (seen.has(pl.place_id)) return false;
    seen.add(pl.place_id);
    return true;
  }).slice(3, 3 + maxLeads);

  // ── Qualification filter ────────────────────────────────────────────────
  const qualified = places.filter(pl => {
    const rating = pl.rating || 0;
    const reviews = pl.user_ratings_total || 0;
    // Target: established but not winning — rating 3.0-4.3, at least 5 reviews
    return rating >= 3.0 && rating <= 4.3 && reviews >= 5;
  });

  db.prepare("UPDATE prospector_campaigns SET total_found = ? WHERE id = ?").run(qualified.length, campaignId);
  const places_final = qualified; // use qualified leads only

  // ── PRE-LOOP: Perplexity research per business (if personalization enabled) ──
  const researchMap = new Map();
  if (personalize && places_final.length > 0) {
    const PERPLEXITY_KEY_PRESENT = !!((typeof getSetting === "function" && getSetting("PERPLEXITY_API_KEY")) || process.env.PERPLEXITY_API_KEY);
    const ANTHROPIC_KEY_PRESENT = !!((typeof getSetting === "function" && getSetting("ANTHROPIC_API_KEY")) || process.env.ANTHROPIC_API_KEY);
    if (PERPLEXITY_KEY_PRESENT || ANTHROPIC_KEY_PRESENT) {
      const CHUNK = 3;
      for (let i = 0; i < places_final.length; i += CHUNK) {
        const chunk = places_final.slice(i, i + CHUNK);
        await Promise.all(chunk.map(async (pl) => {
          const research = await prospectResearch(pl.name, Array.isArray(city) ? city[0] : city, category, (await import("node-fetch")).default);
          if (research) researchMap.set(pl.place_id, research);
        }));
        if (i + CHUNK < places_final.length) await new Promise(r => setTimeout(r, 300));
      }
    }
  }

  const claudeKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
  const twilioSid = getSetting("TWILIO_ACCOUNT_SID") || process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = getSetting("TWILIO_AUTH_TOKEN") || process.env.TWILIO_AUTH_TOKEN;
  const twilioPhone = getSetting("TWILIO_PHONE_NUMBER") || process.env.TWILIO_PHONE_NUMBER;
  const sgKey = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
  const fromEmail = getSetting("EMAIL_FROM") || process.env.EMAIL_FROM || "hello@takeova.ai";
  const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";

  let demosBuilt = 0, emailsSent = 0, smsSent = 0;

  // ── BATCH MODE: Submit all demo site generation requests at once ──────────
  // For 5+ leads, use Anthropic Batch API (50% cheaper, survives server restarts)
  // For <5 leads, fall back to sequential (batch overhead not worth it)
  let batchResults = null;
  const USE_BATCH = claudeKey && places_final.length >= 5;

  if (USE_BATCH) {
    try {
      const batchRequests = places_final.map(place => {
        const bizName = place.name;
        return {
          customId: place.place_id,
          model: 'claude-haiku-4-5-20251001',
          maxTokens: 4000,
          prompt: `You are a world-class web designer building a FREE demo website for a local business. This will be opened on a PHONE from an SMS link so mobile-first is critical.

Business: ${bizName}
Category: ${category}
City: ${Array.isArray(city) ? city[0] : city}
${place.rating ? `Google Rating: ${place.rating}/5 (${place.user_ratings_total || 0} reviews)` : ''}${researchMap.has(place.place_id) ? `\n\nWHAT THIS BUSINESS IS KNOWN FOR (use specific details in copy):\n${researchMap.get(place.place_id).text}` : ''}

REQUIREMENTS:
- MOBILE-FIRST (390px wide — recipient opens this on their phone from an SMS)
- Complete single-file HTML with embedded CSS, no external deps except Google Fonts
- Large tap targets min 44px, min 16px body text, clickable tel: phone link
- Sticky bottom Call Now bar on mobile (display:none on desktop)
- Hero with rating badge, 4-6 services with prices, about, contact form, map placeholder
- Brand colours appropriate for ${category}, avoid generic blue/white
- TYPOGRAPHY: Display font (Syne/Montserrat/Playfair) for headings and logo ONLY. Body font (DM Sans/Inter/Lato) for ALL numbers, stats, prices, labels
- Subtle Powered by MINE in footer (10px grey)

Return ONLY the complete HTML document. No explanation. No markdown.`
        };
      });

      const batchId = await submitBatch(batchRequests);
      registerBatch(db, batchId, 'prospector', campaignId, userId, places_final.length);
      db.prepare("UPDATE prospector_campaigns SET batch_id = ? WHERE id = ?").run(batchId, campaignId);

      // Wait for batch to complete (up to 90 minutes)
      await waitForBatch(batchId, 90 * 60_000, 20_000);
      batchResults = await getBatchResults(batchId);
      updateBatch(db, batchId, 'complete', Object.keys(batchResults).length);
    } catch(e) {
      console.error('[Prospector] Batch failed, falling back to sequential:', e.message);
      batchResults = null; // fall through to sequential
    }
  }

  for (const place of places_final) {
    try {
      // ── Check if campaign was cancelled ─────────────────────────────────
      const campaignRow = db.prepare("SELECT cancelled, status FROM prospector_campaigns WHERE id = ?").get(campaignId);
      if (campaignRow?.cancelled || campaignRow?.status === "cancelled") {
        break;
      }

      // ── Step 2: Get full place details ──────────────────────────────────
      const detailRes = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=name,formatted_phone_number,website,formatted_address,rating,user_ratings_total&key=${googleKey}`);
      const detail = (await detailRes.json()).result || {};

      const bizName = detail.name || place.name;
      const phone = detail.formatted_phone_number || null;
      const website = detail.website || null;
      const address = detail.formatted_address || place.formatted_address || "";
      const rating = detail.rating || place.rating || null;
      const reviews = detail.user_ratings_total || place.user_ratings_total || 0;

      // ── Step 3: Scrape website for email + extract existing content ────
      let email = null;
      let existingContent = null;
      if (website) {
        try {
          const siteRes = await fetch(website, { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0" } });
          const siteHtml = await siteRes.text();
          // Extract email
          const emailMatch = siteHtml.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
          if (emailMatch && !emailMatch[0].includes("example") && !emailMatch[0].includes("sentry")) {
            email = emailMatch[0].toLowerCase();
          }
          // Extract meaningful text content from their existing site
          const stripped = siteHtml
            .replace(/<script[^>]*>.*?<\/script>/gis, '')
            .replace(/<style[^>]*>.*?<\/style>/gis, '')
            .replace(/<!--.*?-->/gs, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          // Extract headings and key phrases (first 800 chars of meaningful text)
          const headings = [...siteHtml.matchAll(/<h[1-3][^>]*>([^<]+)<\/h[1-3]>/gi)].map(m => m[1].trim()).slice(0, 8);
          const meaningful = stripped.replace(/[^a-zA-Z0-9 .,!?'"-]/g, ' ').replace(/\s+/g, ' ').slice(0, 800);
          if (headings.length > 0 || meaningful.length > 50) {
            existingContent = {
              headings: headings.join(' | '),
              text: meaningful
            };
          }
        } catch(e) { /* non-fatal */ }
      }

      // ── Step 4: Classify phone as mobile/landline via Twilio Lookup ──────
      let phoneType = null;
      if (phone && twilioSid && twilioToken) {
        try {
          const cleaned = phone.replace(/\s/g, "");
          const lookupRes = await fetch(`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(cleaned)}?Fields=line_type_intelligence`, {
            headers: { "Authorization": "Basic " + Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64") }
          });
          const lookupData = await lookupRes.json();
          phoneType = lookupData?.line_type_intelligence?.type || null;
        } catch(e) { console.error("[/run]", e.message || e); }
      }

      // ── Step 5: Generate demo site using Claude ──────────────────────────
      const slug = slugify(bizName);
      let demoHtml = null;

      if (claudeKey) {
        let rawHtml = "";

        if (batchResults) {
          // ── BATCH MODE: result already available from pre-submitted batch ──
          rawHtml = batchResults[place.place_id]?.text || "";
        } else {
          // ── SEQUENTIAL MODE: call Claude individually ──
          const prompt = `You are a world-class web designer building a FREE demo website for a local business to show them what their online presence COULD look like.

Business: ${bizName}
Category: ${category}
City: ${Array.isArray(city) ? city[0] : city}
${rating ? `Google Rating: ${rating}/5 (${reviews} reviews)` : ""}
Phone: ${phone || "TBC"}
Address: ${address}
${existingContent ? `\nEXISTING SITE CONTENT TO IMPROVE ON:\nHeadings: ${existingContent.headings}\nContent: ${existingContent.text}\n\nIMPORTANT: Use their real service names, taglines and content where possible — make this feel personal, not generic. Improve the design dramatically.` : "No existing website — create a compelling first impression."}${researchMap.has(place.place_id) ? `\n\nWHAT THIS BUSINESS IS KNOWN FOR (use these specific details):\n${researchMap.get(place.place_id).text}` : ""}

REQUIREMENTS — READ CAREFULLY:
- MOBILE-FIRST design (recipient will open this on their phone from an SMS)
- Complete single-file HTML with ALL CSS embedded — no external dependencies except Google Fonts
- Large tap targets (min 44px), readable font sizes (min 16px body)
- Hero must be immediately compelling on a 390px wide screen
- Include: sticky CTA bar, hero with their real rating, 4-6 services, about, contact form, map placeholder
- Phone number must be a clickable tel: link
- IMPORTANT: Use brand colours that fit ${category} — avoid generic blue/white
- Bottom sticky "Call Now" button on mobile
- Subtle "Powered by MINE" in footer (10px, grey)
- TYPOGRAPHY RULES (critical): Use two fonts only — a display font (e.g. Syne, Playfair Display, or Montserrat) for headings/logo ONLY. Use a clean body font (e.g. DM Sans, Inter, or Lato) for ALL body text, numbers, stats, prices, labels and data. NEVER use the display font for standalone numbers like ratings, stats or prices — it looks jarring. Numbers must always use the body font with font-weight:700 max.

Return ONLY the complete HTML document. No explanation. No markdown fences.`;

          const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "x-api-key": claudeKey, "content-type": "application/json", "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 4000, messages: [{ role: "user", content: prompt }] })
          });
          const aiData = await aiRes.json();
          rawHtml = aiData.content?.[0]?.text || "";
        }

        if (rawHtml) {

        // Inject claim banner at top
        // NOTE: Also inject AI features unlock section before </body>
        // This dramatically increases "Claim Your Site" click rate
        const unlockSection = `<div style="background:linear-gradient(135deg,#0D1B2A,#1B3A52);padding:44px 16px;color:#fff">
<div style="text-align:center;margin-bottom:28px">
<div style="display:inline-block;background:rgba(99,91,255,.2);border:1px solid rgba(99,91,255,.35);color:#A5B4FC;padding:5px 14px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:14px">When you claim this site</div>
<div style="font-size:22px;font-weight:800;color:#fff;margin-bottom:8px;line-height:1.2">Your site goes live + a full AI-powered business platform</div>
<div style="font-size:13px;color:rgba(255,255,255,.5);max-width:360px;margin:0 auto;line-height:1.65">Everything below is included. No tech skills needed.</div>
</div>
<div style="display:grid;gap:10px;max-width:520px;margin:0 auto 28px">
<div style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:14px;display:flex;gap:12px;align-items:flex-start">
<div style="width:38px;height:38px;background:rgba(99,91,255,.25);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">&#128222;</div>
<div><div style="font-weight:700;font-size:14px;margin-bottom:2px">AI Receptionist answers calls 24/7</div><div style="font-size:12px;color:rgba(255,255,255,.5);line-height:1.6">Never miss a job again. Books appointments even at 2am on a Sunday.</div></div></div>
<div style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:14px;display:flex;gap:12px;align-items:flex-start">
<div style="width:38px;height:38px;background:rgba(34,197,94,.15);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">&#11088;</div>
<div><div style="font-weight:700;font-size:14px;margin-bottom:2px">Automated review requests after every job</div><div style="font-size:12px;color:rgba(255,255,255,.5);line-height:1.6">Most users go from 3.8 to 4.6 stars within 3 months.</div></div></div>
<div style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:14px;display:flex;gap:12px;align-items:flex-start">
<div style="width:38px;height:38px;background:rgba(245,158,11,.15);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">&#128197;</div>
<div><div style="font-weight:700;font-size:14px;margin-bottom:2px">Online booking built into your site</div><div style="font-size:12px;color:rgba(255,255,255,.5);line-height:1.6">Customers book and pay a deposit directly. Connects to your calendar.</div></div></div>
<div style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:14px;display:flex;gap:12px;align-items:flex-start">
<div style="width:38px;height:38px;background:rgba(6,182,212,.15);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">&#128172;</div>
<div><div style="font-weight:700;font-size:14px;margin-bottom:2px">Instant quotes via WhatsApp and SMS</div><div style="font-size:12px;color:rgba(255,255,255,.5);line-height:1.6">Win the job before a competitor even calls back.</div></div></div>
<div style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:14px;display:flex;gap:12px;align-items:flex-start">
<div style="width:38px;height:38px;background:rgba(168,85,247,.15);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">&#129302;</div>
<div><div style="font-weight:700;font-size:14px;margin-bottom:2px">AI follows up on every quote automatically</div><div style="font-size:12px;color:rgba(255,255,255,.5);line-height:1.6">Day 2, day 5, day 10 — win jobs you would normally lose.</div></div></div>
</div>
<div style="text-align:center">
<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap"><a href="${frontendUrl}?ref=demo&biz=${encodeURIComponent(bizName)}" style="display:inline-block;background:linear-gradient(135deg,#2563EB,#7C3AED);color:#fff;padding:15px 36px;border-radius:12px;font-weight:700;font-size:16px;text-decoration:none">Claim Your Free Site &#8594;</a><a href="/api/prospector/interest/${slug}" style="display:inline-block;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);color:#fff;padding:15px 28px;border-radius:12px;font-weight:700;font-size:15px;text-decoration:none">Book a Call</a></div>
<div style="font-size:11px;color:rgba(255,255,255,.3);margin-top:10px">5 minutes to go live &middot; No credit card to start</div>
<div id="mine-interest-block" style="max-width:480px;margin:36px auto 0;padding:22px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:14px;text-align:left">
<div style="font-weight:700;font-size:15px;margin-bottom:10px;text-align:center">Or get in touch — we&rsquo;ll reach out</div>
<form id="mine-interest-form" onsubmit="event.preventDefault();(async function(f){var b={};new FormData(f).forEach(function(v,k){b[k]=v;});var btn=f.querySelector('button');btn.disabled=true;btn.textContent='Sending...';try{var r=await fetch('${frontendUrl}/api/prospector/interest/${slug}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});var d=await r.json();if(r.ok){document.getElementById('mine-interest-block').innerHTML='<div style=\'text-align:center;padding:14px\'>&#10003; Thanks! We\'ll be in touch with '+(b.name||'you')+' soon.</div>';}else{btn.disabled=false;btn.textContent='Send';alert(d.error||'Submit failed');}}catch(e){btn.disabled=false;btn.textContent='Send';alert('Network error');}})(this);return false;">
<input name="name" placeholder="Your name" style="width:100%;padding:11px 13px;margin-bottom:8px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);border-radius:8px;color:#fff;font-size:14px;box-sizing:border-box" />
<input name="email" type="email" placeholder="Email" style="width:100%;padding:11px 13px;margin-bottom:8px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);border-radius:8px;color:#fff;font-size:14px;box-sizing:border-box" />
<input name="phone" type="tel" placeholder="Phone (if you'd like a call)" style="width:100%;padding:11px 13px;margin-bottom:8px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);border-radius:8px;color:#fff;font-size:14px;box-sizing:border-box" />
<textarea name="message" rows="2" placeholder="Anything else? (optional)" style="width:100%;padding:11px 13px;margin-bottom:10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);border-radius:8px;color:#fff;font-size:14px;box-sizing:border-box;resize:vertical;font-family:inherit"></textarea>
<button type="submit" style="width:100%;padding:12px;background:linear-gradient(135deg,#2563EB,#7C3AED);border:none;border-radius:9px;color:#fff;font-weight:700;font-size:14px;cursor:pointer">Send</button>
</form></div>
</div></div>`;
        const banner = `<div style="position:fixed;top:0;left:0;right:0;z-index:9999;background:linear-gradient(135deg,#2563EB,#7C3AED);color:#fff;padding:10px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;font-family:system-ui,sans-serif;font-size:13px;box-shadow:0 2px 12px rgba(99,91,255,.4);">
<span>🎉 <strong>Free demo</strong> built for ${bizName} — no strings attached</span>
<a href="${frontendUrl}?ref=demo&biz=${encodeURIComponent(bizName)}" style="background:#fff;color:#2563EB;padding:6px 16px;border-radius:20px;font-weight:700;font-size:12px;text-decoration:none;white-space:nowrap;flex-shrink:0;">Claim Your Site →</a>
</div><div style="height:44px;"></div>`;

        demoHtml = rawHtml.replace("<body>", "<body>" + banner).replace("<body ", "<body>" + banner + "<body_TEMP ").replace("<body_TEMP ", "<body ");
        if (!demoHtml.includes(banner)) demoHtml = banner + rawHtml;
        // Inject AI features unlock section before </body>
        if (demoHtml.includes('</body>')) {
          demoHtml = demoHtml.replace('</body>', unlockSection + '</body>');
        } else {
          demoHtml = demoHtml + unlockSection;
        }

        // Store demo
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        db.prepare("INSERT OR IGNORE INTO prospector_demos (slug, user_id, lead_id, html, business_name, expires_at) VALUES (?,?,?,?,?,?)")
          .run(slug, userId, "", demoHtml, bizName, expiresAt);
        demosBuilt++;
        } // end if (rawHtml)
      } // end if (claudeKey)

      // ── Step 6: Determine outreach channel ──────────────────────────────
      const isMobile = phoneType === "mobile" || phoneType === "nonFixedVoip";
      let channel = "none";
      if (email && channels.includes("email")) channel = "email";
      if (isMobile && phone && channels.includes("sms")) channel = channel === "email" ? "email+sms" : "sms";
      // postcard not implemented — stripped at route level via safeChannels

      // ── Step 6.5: Per-business research + personalized email (Perplexity + Claude) ──
      let researchText = null;
      let personalizedEmail = null;
      try {
        const empRow = db.prepare("SELECT rules FROM ai_employees WHERE user_id = ? AND role = 'prospector'").get(userId);
        let personalize = true;
        if (empRow) {
          try {
            const rules = JSON.parse(empRow.rules || "{}");
            personalize = rules.personalize_outreach !== "no";
          } catch(_) {}
        }
        if (personalize) {
          // First check researchMap (pre-loop fetched these). Fall back to fresh fetch.
          const cached = researchMap.get(place.place_id);
          researchText = cached?.text || cached || await prospectResearch(bizName, Array.isArray(city) ? city[0] : city, category, fetch);
        }
      } catch(e) { console.warn("[prospector research]", e.message); }

      // ── Step 7: Send outreach ────────────────────────────────────────────
      const demoUrl = `${frontendUrl}/demo/${slug}`;
      const outreachStatus = "sent";

      // Generate personalized email content if we have research findings
      if (researchText && email && channels.includes("email")) {
        try {
          personalizedEmail = await generatePersonalizedEmail(bizName, Array.isArray(city) ? city[0] : city, category, researchText, demoUrl, frontendUrl, fetch);
        } catch(e) { console.warn("[prospector personalize]", e.message); }
      }

      if (!previewMode && (channel === "email" || channel === "email+sms") && email && sgKey) {
        try {
          // Use personalized email if research generated one, else fall back to generic template
          const emailSubject = personalizedEmail?.subject || `We built a free website for ${bizName}`;
          const emailHtml = personalizedEmail?.html || `<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;"><h2 style="font-size:22px;font-weight:800;color:#0F172A;margin-bottom:8px;">We built something for ${bizName} 👋</h2><p style="color:#475569;font-size:15px;line-height:1.7;margin-bottom:20px;">We noticed ${bizName} in ${city} and thought you deserved a better web presence. So we built you a free demo — no strings attached, no sign-up required to view it.</p><a href="${demoUrl}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#2563EB,#7C3AED);color:#fff;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;margin-bottom:20px;">View Your Free Demo →</a><p style="color:#94A3B8;font-size:12px;">Link expires in 30 days. <a href="${frontendUrl}/unsubscribe" style="color:#94A3B8;">Unsubscribe</a></p></div>`;

          const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
            method: "POST",
            headers: { "Authorization": `Bearer ${sgKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              personalizations: [{ to: [{ email }] }],
              from: { email: fromEmail, name: "MINE" },
              subject: emailSubject,
              content: [{ type: "text/html", value: emailHtml }]
            })
          });
          if (!_sgResp.ok) {
            let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
            console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
          }
          emailsSent++;
        } catch(e) { /* non-fatal */ }
      }

      if (!previewMode && (channel.includes("sms")) && isMobile && phone && twilioSid) {
        try {
          // Get user's sender name for alphanumeric ID where supported
          const userRow = db.prepare("SELECT sms_sender_name FROM users WHERE id = ?").get(userId);
          const sent = await sendSms({
            to: phone,
            body: `Hi! We built a free demo website for ${bizName} — take a look: ${demoUrl}\n\nReply STOP to opt out.`,
            userSenderName: userRow?.sms_sender_name || null,
            fetch
          });
          if (sent) smsSent++;
        } catch(e) { /* non-fatal */ }
      }

      // Save lead (demo_html column exists in schema but we store HTML in prospector_demos instead to avoid duplication)
      const leadId = uuid();
      db.prepare(`INSERT OR IGNORE INTO prospector_leads
        (id, campaign_id, user_id, business_name, website_url, phone, phone_type, email, address, city, category, google_rating, google_reviews, demo_slug, outreach_channel, outreach_status, outreach_sent_at, research_text, email_subject, email_body)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?,?,?)`)
        .run(leadId, campaignId, userId, bizName, website, phone, phoneType, email, address, city, category, rating, reviews, demoHtml ? slug : null, channel, channel === "none" ? "no_contact" : (previewMode ? "pending_approval" : "sent"), researchText || null, personalizedEmail?.subject || null, personalizedEmail?.html || null);

      // Update demo with lead_id
      if (demoHtml) db.prepare("UPDATE prospector_demos SET lead_id = ? WHERE slug = ?").run(leadId, slug);

      // Bill overage if over plan limit
      try {
        const period = new Date().toISOString().slice(0, 7);
        const used = db.prepare("SELECT COUNT(*) as c FROM prospector_leads WHERE user_id = ? AND demo_slug IS NOT NULL AND strftime('%Y-%m', created_at) = ?").get(userId, period)?.c || 0;
        const planLimit = getPlanDemoLimit(db.prepare("SELECT plan FROM users WHERE id = ?").get(userId)?.plan, false);
        // planLimit is 0 for all plans — every demo is billed at $0.50 overage (no free tier, $79 is access fee only)
        if (used > planLimit && !(typeof global.mineIsAdmin === "function" && global.mineIsAdmin(db, userId))) {
          const overagePrice = getDemoOveragePrice(db.prepare("SELECT plan FROM users WHERE id = ?").get(userId)?.plan);
          db.prepare("INSERT INTO overage_charges (id, user_id, metric, quantity, unit_price, total, period, status) VALUES (?,?,?,?,?,?,?,?)")
            .run(uuid(), userId, "prospectorDemos", 1, overagePrice, overagePrice, period, "pending");
        }
      } catch(e) {}

      await new Promise(r => setTimeout(r, 500)); // rate limit Google API
      // Save progress every lead so frontend polling shows real-time updates
      db.prepare("UPDATE prospector_campaigns SET demos_built=?,emails_sent=?,sms_sent=? WHERE id=?").run(demosBuilt, emailsSent, smsSent, campaignId);
    } catch(e) {
      console.error("[Prospector] Lead error:", e.message);
    }
  }

  db.prepare("UPDATE prospector_campaigns SET status = 'complete', demos_built = ?, emails_sent = ?, sms_sent = ?, completed_at = datetime('now') WHERE id = ?")
    .run(demosBuilt, emailsSent, smsSent, campaignId);
}

// ── GET /api/prospector/campaign/:id ── poll campaign status ─────────────
router.get("/campaign/:id", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const user = db.prepare("SELECT role FROM users WHERE id = ?").get(req.userId);
  const isAdmin = user?.role === "admin";
  // Admin can load any campaign (e.g. from Platform Overview); users only see their own
  const campaign = isAdmin
    ? db.prepare("SELECT * FROM prospector_campaigns WHERE id = ?").get(req.params.id)
    : db.prepare("SELECT * FROM prospector_campaigns WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  const leads = db.prepare("SELECT id, business_name, website_url, phone, phone_type, email, demo_slug, outreach_channel, outreach_status, clicked_at, signed_up, google_rating, google_reviews FROM prospector_leads WHERE campaign_id = ? ORDER BY created_at DESC").all(req.params.id);
  res.json({ campaign, leads });
});

// ── GET /api/prospector/demo/:slug ── serve a demo page (public) ─────────
router.get("/demo/:slug", (req, res) => {
  const db = getDb();
  ensureTables(db);
  const demo = db.prepare("SELECT * FROM prospector_demos WHERE slug = ?").get(req.params.slug);
  if (!demo) return res.status(404).send("<h1>Demo not found or expired</h1>");
  if (demo.expires_at && new Date(demo.expires_at) < new Date()) {
    return res.status(410).send(`<div style="font-family:system-ui;text-align:center;padding:80px 20px"><h1>This demo has expired</h1><p>Want a free demo for your business? <a href="${process.env.FRONTEND_URL || 'https://takeova.ai'}">Build one in 5 minutes →</a></p></div>`);
  }
  // Track click on the lead
  try {
    db.prepare("UPDATE prospector_leads SET clicked_at = COALESCE(clicked_at, datetime('now')) WHERE demo_slug = ?").run(req.params.slug);
    db.prepare("UPDATE prospector_campaigns SET clicks = clicks + 1 WHERE id = (SELECT campaign_id FROM prospector_leads WHERE demo_slug = ?)").run(req.params.slug);
    db.prepare("UPDATE prospector_demos SET views = views + 1, last_viewed = datetime('now') WHERE slug = ?").run(req.params.slug);
  } catch(e) { console.error("[/demo/:slug]", e.message || e); }
  res.setHeader("Content-Type", "text/html");
  res.send(demo.html);
});


// ── GET /api/prospector/leads ── get leads with heat scoring (hot leads first) ─
// Optional ?hot=true filter to return only hot leads (signed up or recently clicked)
router.get("/leads", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const user = db.prepare("SELECT role FROM users WHERE id = ?").get(req.userId);
  const isAdmin = user?.role === "admin";
  const hotOnly = req.query.hot === "true";

  // Both admin and users see only their own leads
  const rawLeads = db.prepare("SELECT l.*, c.city, c.category FROM prospector_leads l JOIN prospector_campaigns c ON l.campaign_id = c.id WHERE l.user_id = ? ORDER BY l.created_at DESC LIMIT 500").all(req.userId);

  // ── Heat scoring ────────────────────────────────────────────────────────
  // Calculates a 0-100 score per lead based on engagement signals.
  // Higher score = more likely to convert. Used for sorting and visual cues.
  const now = Date.now();
  const HOUR = 3600 * 1000;

  function ageText(iso) {
    if (!iso) return "";
    const ms = now - new Date(iso + (iso.includes("Z") ? "" : "Z")).getTime();
    const h = Math.floor(ms / HOUR);
    if (h < 1) return "just now";
    if (h < 24) return h + "h ago";
    const d = Math.floor(h / 24);
    if (d < 7) return d + "d ago";
    const w = Math.floor(d / 7);
    if (w < 5) return w + "w ago";
    return Math.floor(d / 30) + "mo ago";
  }

  const leads = rawLeads.map(l => {
    let heat_score = 0;
    let heat_label = "cold";

    if (l.signed_up) {
      // Already converted — top of list
      heat_score = 100;
      heat_label = "converted";
    } else if (l.clicked_at) {
      // Engaged — score based on click recency + business quality
      const clickAge = now - new Date(l.clicked_at + (l.clicked_at.includes("Z") ? "" : "Z")).getTime();
      const clickHours = clickAge / HOUR;

      // Base 50 for any click
      heat_score = 50;
      // Recency boost: +30 if clicked in last 24h, +15 if last 72h, +5 if last week
      if (clickHours < 24) heat_score += 30;
      else if (clickHours < 72) heat_score += 15;
      else if (clickHours < 168) heat_score += 5;

      // Quality boost: rating × 2 (max +10 at 5 stars)
      if (l.google_rating) heat_score += Math.min(10, Math.round(l.google_rating * 2));
      // Reviews boost: +1 per 10 reviews, capped at +10
      if (l.google_reviews) heat_score += Math.min(10, Math.floor(l.google_reviews / 10));

      heat_label = heat_score >= 80 ? "hot" : "warm";
    } else if (l.outreach_status === "sent" || l.outreach_status === "followup1_sent" || l.outreach_status === "followup2_sent") {
      // Sent but no engagement yet — small score for quality (sortable)
      heat_score = 0;
      if (l.google_rating) heat_score += l.google_rating * 2; // 0-10
      if (l.google_reviews) heat_score += Math.min(5, l.google_reviews / 20); // 0-5
      heat_score = Math.round(heat_score);
      heat_label = "cold";
    }

    return {
      ...l,
      heat_score,
      heat_label,
      is_hot: heat_label === "hot" || heat_label === "converted",
      clicked_recently: l.clicked_at && (now - new Date(l.clicked_at + (l.clicked_at.includes("Z") ? "" : "Z")).getTime()) < 24 * HOUR,
      click_age: l.clicked_at ? ageText(l.clicked_at) : null,
      sent_age: l.outreach_sent_at ? ageText(l.outreach_sent_at) : null
    };
  });

  // Sort: heat_score DESC, then created_at DESC (newest first within same heat)
  leads.sort((a, b) => {
    if (b.heat_score !== a.heat_score) return b.heat_score - a.heat_score;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  // Optional filter to hot only
  const filtered = hotOnly ? leads.filter(l => l.is_hot) : leads;

  // Cap at 200 after sort/filter for response size
  const final = filtered.slice(0, 200);

  // Counts for filter chips
  const counts = {
    total: leads.length,
    hot: leads.filter(l => l.heat_label === "hot").length,
    warm: leads.filter(l => l.heat_label === "warm").length,
    converted: leads.filter(l => l.heat_label === "converted").length,
    cold: leads.filter(l => l.heat_label === "cold").length
  };

  res.json({ leads: final, counts, isAdmin });
});

// ── POST /api/prospector/cancel/:id ── cancel a running campaign ──────────
router.post("/cancel/:id", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const user = db.prepare("SELECT role FROM users WHERE id = ?").get(req.userId);
  const isAdmin = user?.role === "admin";
  const campaign = isAdmin
    ? db.prepare("SELECT * FROM prospector_campaigns WHERE id = ?").get(req.params.id)
    : db.prepare("SELECT * FROM prospector_campaigns WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  if (!["running", "processing"].includes(campaign.status)) return res.status(400).json({ error: "Campaign is not running" });
  // Set both cancelled flag (checked per-lead in loop) and status (shown immediately in UI)
  db.prepare("UPDATE prospector_campaigns SET status = 'cancelled', cancelled = 1, completed_at = datetime('now') WHERE id = ?").run(campaign.id);
  res.json({ success: true, message: "Campaign cancelled — will stop after current lead" });
});


// ── POST /api/prospector/signup-attribution ── called after signup if ?ref=demo ─
router.post("/signup-attribution", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const { bizName, slug } = req.body;
  try {
    if (slug) {
      db.prepare("UPDATE prospector_leads SET signed_up = 1 WHERE demo_slug = ?").run(slug);
      db.prepare("UPDATE prospector_campaigns SET signups = signups + 1 WHERE id = (SELECT campaign_id FROM prospector_leads WHERE demo_slug = ?)").run(slug);
    } else if (bizName) {
      db.prepare("UPDATE prospector_leads SET signed_up = 1 WHERE business_name LIKE ?").run(`%${bizName}%`);
    }
  } catch(e) { console.error("[/signup-attribution]", e.message || e); }
  res.json({ success: true });
});


// ── POST /api/prospector/send-followups ── cron calls this daily ─────────
// Sends Day 4 follow-up to leads that received outreach but haven't clicked
// Sends Day 8 final follow-up to leads that received Day 4 but still haven't clicked
// Dual-mode endpoint: accepts cron-secret header (system-wide) OR user JWT (user-scoped).
// Frontend "Send Follow-ups" button uses user auth; nightly cron uses CRON_SECRET.
router.post("/send-followups", async (req, res) => {
  const db = getDb();
  let userId = null;
  let isCron = false;
  const cronKey = process.env.CRON_SECRET || "";
  const supplied = req.headers["x-cron-key"] || "";
  if (cronKey && supplied && supplied.length === cronKey.length) {
    try {
      const crypto = require("crypto");
      if (crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(cronKey))) isCron = true;
    } catch(_) {}
  }
  if (!isCron) {
    // Fall back to user JWT auth
    try {
      const authHeader = req.headers.authorization || "";
      if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
      const jwt = require("jsonwebtoken");
      const payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET || "");
      userId = payload.userId || payload.id || payload.sub;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });
    } catch(e) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  const userFilter = userId ? " AND l.user_id = '" + String(userId).replace(/'/g,'') + "'" : "";
  ensureTables(db);
  const sgKey = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
  const twilioSid = getSetting("TWILIO_ACCOUNT_SID") || process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = getSetting("TWILIO_AUTH_TOKEN") || process.env.TWILIO_AUTH_TOKEN;
  const twilioPhone = getSetting("TWILIO_PHONE_NUMBER") || process.env.TWILIO_PHONE_NUMBER;
  const fromEmail = getSetting("EMAIL_FROM") || process.env.EMAIL_FROM || "hello@takeova.ai";
  const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";
  const fetch = (await import("node-fetch")).default;

  let sent = 0;

  // Honor each user's auto_followups setting — skip users who turned it off.
  // We can't filter in SQL across users with different settings, so we read
  // the disabled set into a Set and skip matching leads after fetching.
  const disabledUsers = new Set();
  try {
    const offRows = db.prepare("SELECT user_id FROM ai_employees WHERE role = 'prospector' AND json_extract(rules, '$.auto_followups') = 'no'").all();
    for (const r of offRows) disabledUsers.add(r.user_id);
  } catch(_) {}

  // Day 4 follow-up: sent outreach 3-5 days ago, not clicked, no follow-up sent yet
  const day4Leads = db.prepare(`
    SELECT l.*, c.city, c.category FROM prospector_leads l
    JOIN prospector_campaigns c ON l.campaign_id = c.id
    WHERE l.outreach_status = 'sent'
    AND l.clicked_at IS NULL
    AND l.demo_slug IS NOT NULL
    AND l.followup1_sent_at IS NULL
    ${userFilter}
    AND l.outreach_sent_at <= datetime('now', '-3 days')
    AND l.outreach_sent_at >= datetime('now', '-6 days')
  `).all();

  for (const lead of day4Leads) {
    if (disabledUsers.has(lead.user_id)) continue;
    if (disabledUsers.has(lead.user_id)) continue;
    try {
      const demoUrl = `${frontendUrl}/demo/${lead.demo_slug}`;
      if (lead.email && (lead.outreach_channel === 'email' || lead.outreach_channel === 'email+sms') && sgKey) {
        const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { "Authorization": `Bearer ${sgKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: lead.email }] }],
            from: { email: fromEmail, name: "MINE" },
            subject: `Still there? Your ${lead.business_name} demo is waiting`,
            content: [{ type: "text/html", value: `
              <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;">
                <h2 style="font-size:20px;font-weight:800;color:#0F172A;margin-bottom:8px;">Just checking in 👋</h2>
                <p style="color:#475569;font-size:15px;line-height:1.7;margin-bottom:16px;">
                  We sent you a free demo website for ${lead.business_name} a few days ago — did you get a chance to look?
                </p>
                <a href="${demoUrl}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#2563EB,#7C3AED);color:#fff;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;margin-bottom:16px;">View Your Demo →</a>
                <p style="color:#94A3B8;font-size:12px;">Demo expires in a few weeks. Reply to this email if you have questions.</p>
                <p style="color:#94A3B8;font-size:11px;margin-top:24px;"><a href="${frontendUrl}/unsubscribe" style="color:#94A3B8;">Unsubscribe</a></p>
              </div>` }]
          })
        });
        if (!_sgResp.ok) {
          let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
          console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
        }
        db.prepare("UPDATE prospector_leads SET followup1_sent_at = datetime('now'), outreach_status = 'followup1_sent' WHERE id = ?").run(lead.id);
        sent++;
      }
    } catch(e) { console.error("[/send-followups]", e.message || e); }
  }

  // Day 8 final follow-up: got Day 4 email 3-5 days ago, still not clicked
  const day8Leads = db.prepare(`
    SELECT l.*, c.city, c.category FROM prospector_leads l
    JOIN prospector_campaigns c ON l.campaign_id = c.id
    WHERE l.outreach_status = 'followup1_sent'
    AND l.clicked_at IS NULL
    AND l.followup2_sent_at IS NULL
    AND l.demo_slug IS NOT NULL
    AND l.followup1_sent_at <= datetime('now', '-3 days')
    AND l.followup1_sent_at >= datetime('now', '-6 days')
  `).all();

  for (const lead of day8Leads) {
    try {
      const demoUrl = `${frontendUrl}/demo/${lead.demo_slug}`;
      const isMobile = lead.phone_type === "mobile" || lead.phone_type === "nonFixedVoip";

      // Day 8: SMS is most effective for final nudge
      if (isMobile && lead.phone && twilioSid) {
        // Get user's sender name for alphanumeric ID where supported
        const userRow = db.prepare("SELECT sms_sender_name FROM users WHERE id = ?").get(lead.user_id);
        await sendSms({
          to: lead.phone,
          body: `Last chance — your free ${lead.business_name} demo expires soon: ${demoUrl}\n\nReply STOP to opt out.`,
          userSenderName: userRow?.sms_sender_name || null,
          fetch
        });
      } else if (lead.email && sgKey) {
        const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { "Authorization": `Bearer ${sgKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: lead.email }] }],
            from: { email: fromEmail, name: "MINE" },
            subject: `Taking down your ${lead.business_name} demo soon`,
            content: [{ type: "text/html", value: `
              <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;">
                <h2 style="font-size:20px;font-weight:800;color:#0F172A;margin-bottom:8px;">Last one from us 🙏</h2>
                <p style="color:#475569;font-size:15px;line-height:1.7;margin-bottom:16px;">
                  We'll be taking down the free demo for ${lead.business_name} in the next few days. If you'd like to claim it and go live, now is the time.
                </p>
                <a href="${demoUrl}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#2563EB,#7C3AED);color:#fff;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;margin-bottom:16px;">Claim Your Site →</a>
                <p style="color:#94A3B8;font-size:11px;margin-top:24px;">Won't bother you again after this. <a href="${frontendUrl}/unsubscribe" style="color:#94A3B8;">Unsubscribe</a></p>
              </div>` }]
          })
        });
        if (!_sgResp.ok) {
          let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
          console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
        }
      }

      db.prepare("UPDATE prospector_leads SET followup2_sent_at = datetime('now'), outreach_status = 'followup2_sent' WHERE id = ?").run(lead.id);
      sent++;
    } catch(e) { console.error("[/send-followups]", e.message || e); }
  }
  res.json({ success: true, sent });
});


// ── GET /api/prospector/platform-overview ── admin-only platform stats ────
router.get("/platform-overview", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const user = db.prepare("SELECT role FROM users WHERE id = ?").get(req.userId);
  if (user?.role !== "admin") return res.status(403).json({ error: "Admin only" });

  const totals = db.prepare(`
    SELECT
      COUNT(DISTINCT l.campaign_id) as total_campaigns,
      COUNT(*) as total_leads,
      COUNT(l.demo_slug) as total_demos,
      SUM(CASE WHEN l.outreach_channel LIKE '%email%' THEN 1 ELSE 0 END) as total_emails,
      SUM(CASE WHEN l.outreach_channel LIKE '%sms%' THEN 1 ELSE 0 END) as total_sms,
      COUNT(l.clicked_at) as total_clicks,
      SUM(l.signed_up) as total_signups,
      COUNT(DISTINCT l.user_id) as total_users
    FROM prospector_leads l
  `).get();

  const recentCampaigns = db.prepare(`
    SELECT c.id, c.city, c.category, c.status, c.total_found, c.demos_built,
           c.emails_sent, c.sms_sent, c.clicks, c.signups, c.created_at
    FROM prospector_campaigns c
    ORDER BY c.created_at DESC LIMIT 20
  `).all();

  res.json({ totals, recentCampaigns });
});


// ── Campaigns list (plural alias) ─────────────────────────────────────────────
router.get("/campaigns", auth, (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;
    const campaigns = db.prepare("SELECT * FROM prospector_campaigns WHERE user_id = ? ORDER BY created_at DESC").all(uid);
    res.json({ campaigns });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── Prospector stats ──────────────────────────────────────────────────────────
router.get("/stats", auth, (req, res) => {
  try {
    const db = getDb();
    const uid = req.userId;
    const campaigns = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) as active FROM prospector_campaigns WHERE user_id = ?").get(uid);
    const leads = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status='replied' THEN 1 ELSE 0 END) as replied, SUM(CASE WHEN status='converted' THEN 1 ELSE 0 END) as converted FROM prospector_leads WHERE user_id = ?").get(uid);
    res.json({
      campaigns: campaigns || { total: 0, active: 0 },
      leads: leads || { total: 0, replied: 0, converted: 0 },
      reply_rate: leads?.total > 0 ? Math.round((leads.replied / leads.total) * 100) : 0,
      conversion_rate: leads?.total > 0 ? Math.round((leads.converted / leads.total) * 100) : 0
    });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── POST /api/prospector/export-to-cold-email ── hand off leads to Cold Email Agent
router.post("/export-to-cold-email", auth, async (req, res) => {
  const db = getDb();
  ensureTables(db);
  const { campaignId, subject, goal, yourOffer, yourName, yourBusiness, replyTo } = req.body;
  if (!campaignId) return res.status(400).json({ error: "campaignId required" });

  const campaign = db.prepare("SELECT * FROM prospector_campaigns WHERE id = ? AND user_id = ?").get(campaignId, req.userId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  // Get leads that have emails and haven't already been handed off
  const leads = db.prepare(`
    SELECT business_name, email, website_url, city, category
    FROM prospector_leads
    WHERE campaign_id = ? AND email IS NOT NULL AND email != ''
    AND cold_email_sent IS NULL
  `).all(campaignId);

  if (!leads.length) return res.status(400).json({ error: "No leads with email addresses found in this campaign. Try running the campaign with email outreach enabled first." });

  // Mark leads as handed off
  try { db.exec("ALTER TABLE prospector_leads ADD COLUMN cold_email_sent INTEGER DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE prospector_leads ADD COLUMN cold_email_campaign_id TEXT"); } catch(e) {}

  // Format prospects for Cold Email Agent
  const prospects = leads.map(l => ({
    name: l.business_name,
    email: l.email,
    website: l.website_url,
    company: l.business_name,
  }));

  // Call Cold Email Agent internally
  const fetch = (await import("node-fetch")).default;
  const PORT = process.env.PORT || 4000;

  // Get the user's auth token to pass to cold email endpoint
  const userToken = req.headers.authorization;

  try {
    const r = await fetch(`http://localhost:${PORT}/api/cold-email/campaign`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": userToken },
      body: JSON.stringify({
        name: `Prospector → ${campaign.category} in ${campaign.city}`,
        prospects,
        subject: subject || `Quick question about ${campaign.category} in ${campaign.city}`,
        goal: goal || "Book a discovery call",
        yourOffer: yourOffer || "",
        yourName, yourBusiness, replyTo
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);

    // Mark leads as handed off
    const stmt = db.prepare("UPDATE prospector_leads SET cold_email_sent = 1, cold_email_campaign_id = ? WHERE campaign_id = ? AND email IS NOT NULL");
    stmt.run(data.campaignId, campaignId);

    res.json({ success: true, coldEmailCampaignId: data.campaignId, total: prospects.length, message: `Handed off ${prospects.length} leads to Cold Email Agent` });
  } catch(e) {
    res.status(500).json({ error: "Failed to start cold email campaign: " + e.message });
  }
});


// ─── PUBLIC: POST /api/prospector/interest/:slug — demo page form submit ─────
// No auth — anonymous business owners viewing the demo submit this.
router.post("/interest/:slug", async (req, res) => {
  const db = getDb();
  ensureTables(db);
  const slug = req.params.slug;
  const { name, email, phone, message } = req.body || {};
  if (!email && !phone) return res.status(400).json({ error: "Email or phone required" });

  try {
    const lead = db.prepare("SELECT id, user_id, business_name, city FROM prospector_leads WHERE demo_slug = ?").get(slug);
    if (!lead) return res.status(404).json({ error: "Demo not found" });

    db.prepare(`UPDATE prospector_leads SET
        interested = 1,
        interested_at = COALESCE(interested_at, datetime('now')),
        interest_name = ?,
        interest_email = ?,
        interest_phone = ?,
        interest_note = ?
      WHERE id = ?`).run(name || null, email || null, phone || null, message || null, lead.id);

    // Surface in the dashboard via user_notifications
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS user_notifications (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT, severity TEXT,
        title TEXT, body TEXT, action_url TEXT, action_label TEXT,
        read INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
      )`);
      const wantsCall = !!(phone && (message || "").toLowerCase().match(/call|phone|ring/));
      const title = wantsCall
        ? `📞 ${lead.business_name || "Prospect"} wants a call`
        : `🎯 ${lead.business_name || "Prospect"} is interested`;
      const bodyText = [name && `Name: ${name}`, email && `Email: ${email}`, phone && `Phone: ${phone}`, message && `Note: ${message.slice(0, 200)}`]
        .filter(Boolean).join(" · ");
      db.prepare(`INSERT INTO user_notifications (id, user_id, type, severity, title, body, action_url, action_label) VALUES (?,?,?,?,?,?,?,?)`)
        .run(require("uuid").v4(), lead.user_id, "prospector_interest", wantsCall ? "high" : "medium", title, bodyText, "/prospector?lead=" + lead.id, "View lead");
    } catch(e) { console.warn("[interest/notify]", e.message); }

    // Optional: email the platform user too if SendGrid is configured
    try {
      const sgKey = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
      const fromEmail = getSetting("EMAIL_FROM") || process.env.EMAIL_FROM || "hello@takeova.ai";
      const userRow = db.prepare("SELECT email, name FROM users WHERE id = ?").get(lead.user_id);
      if (sgKey && userRow?.email) {
        const fetch = (await import("node-fetch")).default;
        await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { "Authorization": `Bearer ${sgKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: userRow.email }] }],
            from: { email: fromEmail, name: "MINE" },
            subject: `🎯 ${lead.business_name || "A prospect"} is interested`,
            content: [{ type: "text/html", value: `
              <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px">
                <h2 style="font-size:20px;margin-bottom:8px">${lead.business_name || "A prospect"} responded to your demo</h2>
                <p style="color:#475569;line-height:1.65">Someone from <b>${lead.business_name || "this prospect"}</b> (${lead.city || ""}) submitted the interest form on their demo page.</p>
                <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;margin:14px 0">
                  ${name ? `<div><b>Name:</b> ${name}</div>` : ""}
                  ${email ? `<div><b>Email:</b> <a href="mailto:${email}">${email}</a></div>` : ""}
                  ${phone ? `<div><b>Phone:</b> <a href="tel:${phone}">${phone}</a></div>` : ""}
                  ${message ? `<div style="margin-top:8px"><b>Message:</b><br>${message.replace(/</g, "&lt;")}</div>` : ""}
                </div>
                <p style="color:#94a3b8;font-size:13px">Reply directly to them or open the lead in MINE.</p>
              </div>` }]
          })
        }).catch(() => {});
      }
    } catch(_) {}

    res.json({ success: true, message: "Thanks! We'll be in touch." });
  } catch (e) {
    console.error("[/interest]", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── GET /api/prospector/pending-outreach — leads built but not yet sent ─────
router.get("/pending-outreach", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const rows = db.prepare(`
    SELECT l.id, l.business_name, l.email, l.phone, l.city, l.category, l.demo_slug,
           l.outreach_channel, l.outreach_status, l.created_at, l.google_rating, l.google_reviews
    FROM prospector_leads l
    WHERE l.user_id = ? AND l.outreach_status = 'pending_approval'
    ORDER BY l.created_at DESC LIMIT 100`).all(req.userId);
  res.json({ leads: rows, count: rows.length });
});

// ─── POST /api/prospector/leads/:id/approve-outreach — send outreach now ─────
router.post("/leads/:id/approve-outreach", auth, async (req, res) => {
  const db = getDb();
  ensureTables(db);
  try {
    const lead = db.prepare("SELECT * FROM prospector_leads WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    if (lead.outreach_status === "sent") return res.json({ success: true, alreadySent: true });

    const sgKey = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
    const fromEmail = getSetting("EMAIL_FROM") || process.env.EMAIL_FROM || "hello@takeova.ai";
    const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";
    const demoUrl = `${frontendUrl}/demo/${lead.demo_slug}`;
    const fetch = (await import("node-fetch")).default;

    let sent = false;
    const channel = lead.outreach_channel || "";
    if ((channel === "email" || channel === "email+sms") && lead.email && sgKey) {
      const sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { "Authorization": `Bearer ${sgKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: lead.email }] }],
          from: { email: fromEmail, name: "MINE" },
          subject: lead.email_subject || `We built a free website for ${lead.business_name}`,
          content: [{ type: "text/html", value: lead.email_body || `
            <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;">
              <h2 style="font-size:22px;font-weight:800;color:#0F172A;margin-bottom:8px;">We built something for ${lead.business_name} 👋</h2>
              <p style="color:#475569;font-size:15px;line-height:1.7;margin-bottom:20px;">
                We noticed ${lead.business_name} in ${lead.city} and thought you deserved a better web presence. So we built you a free demo — no strings attached, no sign-up required to view it.
              </p>
              <a href="${demoUrl}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#2563EB,#7C3AED);color:#fff;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;margin-bottom:20px;">View Your Free Demo →</a>
              <p style="color:#94A3B8;font-size:12px;">If you'd like to claim it and go live, it takes 5 minutes. If not, no worries — the link expires in 30 days.</p>
            </div>` }]
        })
      });
      sent = sgResp.ok;
    }
    // SMS path: same as the bulk runner uses sendSms helper, which we can't
    // safely require here without circular import risk. For now, approve-outreach
    // sends email only; SMS-only leads should be approved through the bulk
    // /run path with channels=['sms'] from the start.

    db.prepare(`UPDATE prospector_leads SET outreach_status = ?, outreach_sent_at = datetime('now') WHERE id = ?`)
      .run(sent ? "sent" : "send_failed", req.params.id);

    res.json({ success: sent, leadId: req.params.id, status: sent ? "sent" : "send_failed" });
  } catch (e) {
    console.error("[approve-outreach]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/prospector/leads/:id/skip — mark lead as skipped ─────────────
router.post("/leads/:id/skip", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const r = db.prepare("UPDATE prospector_leads SET outreach_status = 'skipped' WHERE id = ? AND user_id = ?")
    .run(req.params.id, req.userId);
  if (r.changes === 0) return res.status(404).json({ error: "Lead not found" });
  res.json({ success: true });
});



// ── POST /api/prospector/leads/:leadId/send-outreach ──
// User taps "Send Outreach" on a preview-pending lead → fires the actual send.
router.post("/leads/:leadId/send-outreach", auth, async (req, res) => {
  const db = getDb();
  ensureTables(db);
  const lead = db.prepare("SELECT l.*, c.city, c.category FROM prospector_leads l JOIN prospector_campaigns c ON l.campaign_id = c.id WHERE l.id = ? AND l.user_id = ?").get(req.params.leadId, req.userId);
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  if (lead.outreach_status !== "pending_approval" && lead.outreach_status !== "preview_pending") {
    return res.status(400).json({ error: "Lead is not in preview state", current_status: lead.outreach_status });
  }
  if (!lead.demo_slug) {
    return res.status(400).json({ error: "No demo built for this lead — cannot send outreach" });
  }

  const sgKey = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
  const twilioSid = getSetting("TWILIO_ACCOUNT_SID") || process.env.TWILIO_ACCOUNT_SID;
  const fromEmail = getSetting("EMAIL_FROM") || process.env.EMAIL_FROM || "hello@takeova.ai";
  const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";
  const fetch = (await import("node-fetch")).default;
  const demoUrl = `${frontendUrl}/demo/${lead.demo_slug}`;

  let sentEmail = false, sentSms = false, errors = [];

  if ((lead.outreach_channel === "email" || lead.outreach_channel === "email+sms") && lead.email && sgKey) {
    try {
      const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { "Authorization": `Bearer ${sgKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: lead.email }] }],
          from: { email: fromEmail, name: "MINE" },
          subject: lead.email_subject || `We built a free website for ${lead.business_name}`,
          content: [{ type: "text/html", value: lead.email_body || `<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;"><h2 style="font-size:22px;font-weight:800;color:#0F172A;margin-bottom:8px;">We built something for ${lead.business_name} 👋</h2><p style="color:#475569;font-size:15px;line-height:1.7;margin-bottom:20px;">${lead.outreach_intro || `We noticed ${lead.business_name} in ${lead.city} and thought you deserved a better web presence. So we built you a free demo — no strings attached, no sign-up required to view it.`}</p><a href="${demoUrl}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#2563EB,#7C3AED);color:#fff;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;margin-bottom:20px;">View Your Free Demo →</a><p style="color:#94A3B8;font-size:12px;">If you'd like to claim it and go live, it takes 5 minutes. If not, no worries — the link expires in 30 days.</p></div>` }]
        })
      });
      sentEmail = r.ok;
      if (!r.ok) errors.push("SendGrid: " + r.status);
    } catch (e) { errors.push("Email: " + e.message); }
  }

  if (lead.outreach_channel?.includes("sms") && lead.phone && twilioSid) {
    try {
      // Use the existing sendSms helper
      const userRow = db.prepare("SELECT sms_sender_name FROM users WHERE id = ?").get(req.userId);
      const sent = await sendSms({
        to: lead.phone,
        body: `Hi! We built a free demo website for ${lead.business_name} — take a look: ${demoUrl}\n\nReply STOP to opt out.`,
        userSenderName: userRow?.sms_sender_name || null,
        fetch
      });
      sentSms = !!sent;
    } catch (e) { errors.push("SMS: " + e.message); }
  }

  if (sentEmail || sentSms) {
    db.prepare("UPDATE prospector_leads SET outreach_status = 'sent', outreach_sent_at = datetime('now') WHERE id = ?").run(lead.id);
    return res.json({ posted: true, sentEmail, sentSms, note: "Outreach sent" });
  }
  return res.json({ posted: false, connected: !!sgKey || !!twilioSid, errors, note: errors.join(", ") || "No channel could send (check SendGrid/Twilio settings)" });
});

// ── GET /api/prospector/interest/:slug ── public landing for "Book a Call" CTA ──
// Records the prospect's interest signal and shows a simple contact-capture page.
router.get("/interest/:slug", (req, res) => {
  const db = getDb();
  ensureTables(db);
  const demo = db.prepare("SELECT slug, business_name FROM prospector_demos WHERE slug = ?").get(req.params.slug);
  if (!demo) return res.status(404).send("<h1>Page not found</h1>");

  try {
    db.prepare("UPDATE prospector_leads SET interested_at = COALESCE(interested_at, datetime('now')) WHERE demo_slug = ?").run(req.params.slug);
  } catch(_) {}

  const safe = (s) => String(s||"").replace(/[<>"]/g, "");
  const bizName = safe(demo.business_name);
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Get in touch — ${bizName}</title></head><body style="margin:0;background:#0a0a0f;color:#fff;font-family:system-ui,-apple-system,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px"><div style="max-width:480px;width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:36px 28px"><div style="font-size:42px;margin-bottom:18px">🎉</div><h1 style="font-size:24px;font-weight:800;margin:0 0 12px">Got it — we'll be in touch about ${bizName}</h1><p style="color:rgba(255,255,255,.7);font-size:14px;line-height:1.6;margin:0 0 24px">Drop your best contact below and we'll reach out within 24 hours to chat through how MINE can work for your business.</p><form method="POST" action="/api/prospector/interest/${req.params.slug}" style="display:flex;flex-direction:column;gap:12px"><input type="text" name="contact" required placeholder="Phone or email" style="background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:14px 16px;color:#fff;font-size:15px;outline:none"><button type="submit" style="background:linear-gradient(135deg,#2563EB,#7C3AED);color:#fff;border:none;border-radius:10px;padding:14px;font-weight:700;font-size:15px;cursor:pointer">Notify them →</button></form><p style="color:rgba(255,255,255,.4);font-size:11px;margin:18px 0 0;text-align:center">No spam. We'll only use this to reach out about your demo.</p></div></body></html>`);
});

// ── POST /api/prospector/interest/:slug ── store contact + notify user ──
router.post("/interest/:slug", express.urlencoded({ extended: false }), async (req, res) => {
  const db = getDb();
  ensureTables(db);
  const contact = (req.body?.contact || "").toString().slice(0, 200);

  // Update lead with the interest signal + contact info
  try {
    db.prepare("UPDATE prospector_leads SET interested_at = COALESCE(interested_at, datetime('now')), interest_contact = ? WHERE demo_slug = ?").run(contact, req.params.slug);
  } catch(_) {}

  // Look up the user + lead so we can notify
  let lead = null, user = null;
  try {
    lead = db.prepare("SELECT l.id, l.user_id, l.business_name, l.email as biz_email, l.phone as biz_phone FROM prospector_leads l WHERE l.demo_slug = ?").get(req.params.slug);
    if (lead) user = db.prepare("SELECT id, email, name FROM users WHERE id = ?").get(lead.user_id);
  } catch(_) {}

  // ─── 1. In-app notification ───
  if (lead && user) {
    try {
      const uuid = require("uuid").v4;
      const text = "🔥 " + (lead.business_name || "A prospect") + " wants a call — contact: " + (contact || "no details");
      db.prepare("INSERT INTO notifications (id, user_id, type, icon, text, data, time) VALUES (?,?,?,?,?,?,?)")
        .run(uuid(), user.id, "prospector_interest", "🔥", text, JSON.stringify({ leadId: lead.id, slug: req.params.slug, contact }), "Just now");
    } catch(e) { console.error("[interest notify in-app]", e.message); }
  }

  // ─── 2. SMS notification (Twilio) ───
  if (lead && user) {
    try {
      // Read notify_phone from the prospector employee rules
      const empRow = db.prepare("SELECT rules FROM ai_employees WHERE user_id = ? AND role = 'prospector'").get(user.id);
      let notifyPhone = "";
      if (empRow) {
        try { notifyPhone = JSON.parse(empRow.rules || "{}").notify_phone || ""; } catch(_) {}
      }
      if (notifyPhone) {
        const fetch = (await import("node-fetch")).default;
        const safe = (s) => String(s || "");
        const bizName = safe(lead.business_name || "A prospect");
        const safeContact = safe(contact || "no details");
        const userRow = db.prepare("SELECT sms_sender_name FROM users WHERE id = ?").get(user.id);
        await sendSms({
          to: notifyPhone,
          body: "🔥 " + bizName + " wants a call. Contact: " + safeContact,
          userSenderName: userRow?.sms_sender_name || null,
          fetch
        });
      }
    } catch(e) { console.error("[interest notify SMS]", e.message); }
  }

  // ─── 3. Email notification ───
  if (lead && user && user.email) {
    try {
      const sgKey = (typeof getSetting === "function" && getSetting("SENDGRID_API_KEY")) || process.env.SENDGRID_API_KEY;
      const fromEmail = (typeof getSetting === "function" && getSetting("EMAIL_FROM")) || process.env.EMAIL_FROM || "hello@takeova.ai";
      const frontendUrl = process.env.FRONTEND_URL || "https://takeova.ai";
      if (sgKey) {
        const fetch = (await import("node-fetch")).default;
        const safe = (s) => String(s || "").replace(/[<>]/g, "");
        const bizName = safe(lead.business_name || "A prospect");
        const safeContact = safe(contact || "no details provided");
        const html = '<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px">'
          + '<div style="background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;padding:18px 22px;border-radius:14px;margin-bottom:22px">'
          + '<div style="font-size:14px;opacity:.9;margin-bottom:4px">🔥 Hot lead</div>'
          + '<div style="font-size:22px;font-weight:800">' + bizName + ' wants a call</div></div>'
          + '<p style="color:#475569;font-size:15px;line-height:1.7;margin-bottom:10px"><b>How to reach them:</b></p>'
          + '<div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:10px;padding:14px 18px;margin-bottom:22px;font:600 16px monospace;color:#0f172a">' + safeContact + '</div>'
          + '<p style="color:#64748b;font-size:13px;line-height:1.6">They clicked through your demo and tapped "Book a Call". A timely response within a few hours has the highest conversion rate — they\'re hot right now.</p>'
          + '<a href="' + frontendUrl + '" style="display:inline-block;padding:12px 24px;background:linear-gradient(135deg,#2563EB,#7C3AED);color:#fff;border-radius:10px;font-weight:700;font-size:14px;text-decoration:none;margin-top:16px">Open MINE Dashboard →</a>'
          + '<p style="color:#94a3b8;font-size:11px;margin-top:32px">Prospector Agent · MINE</p>'
          + '</div>';
        await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: user.email, name: user.name || "" }] }],
            from: { email: fromEmail, name: "MINE Prospector" },
            subject: "🔥 " + bizName + " wants a call",
            content: [{ type: "text/html", value: html }]
          })
        });
      }
    } catch(e) { console.error("[interest notify email]", e.message); }
  }

  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Thanks!</title></head><body style="margin:0;background:#0a0a0f;color:#fff;font-family:system-ui,-apple-system,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center"><div style="max-width:420px"><div style="font-size:48px;margin-bottom:18px">✅</div><h1 style="font-size:24px;font-weight:800;margin:0 0 12px">Thanks — we'll be in touch within 24 hours</h1><p style="color:rgba(255,255,255,.6);font-size:14px;line-height:1.6">If anything's urgent, feel free to reply directly to the email we sent. Talk soon!</p></div></body></html>`);
});

// ════════════════════════════════════════════════════════════════════════
// LEAD FINDER (Origami-style) — plain-English ICP -> qualified, fit-scored,
// exportable lead list. Discovery-first: reuses the SAME Google Places +
// Perplexity + Claude engine as /run, but builds NO demo sites and sends NO
// outreach. Outreach stays opt-in via the existing /run + approve flow.
// Verified to parse / node --check only — not run against live Google/Perplexity/Claude.
// ════════════════════════════════════════════════════════════════════════

const LF_MODEL = "claude-haiku-4-5-20251001";
function _lfAnthropicKey() {
  return (typeof getSetting === "function" && getSetting("ANTHROPIC_API_KEY")) || process.env.ANTHROPIC_API_KEY;
}

// Included Lead Finder leads per MONTH by plan (Growth -> Agency). Admin = unlimited.
// Over the included quota: billed per lead via the same overage_charges table as demos.
const LEAD_QUOTA = { starter: 50, growth: 50, pro: 100, enterprise: 150, agency: 200 };
const LEAD_OVERAGE_PRICE = 0.10; // USD per discovered lead over the monthly quota // USD per discovered lead over the monthly quota — change here to adjust
function getLeadQuota(plan, isAdmin) { return isAdmin ? Infinity : (LEAD_QUOTA[plan] != null ? LEAD_QUOTA[plan] : 50); }
function getLeadOveragePrice(plan) { return LEAD_OVERAGE_PRICE; }
function leadUsageThisMonth(db, userId) {
  const period = new Date().toISOString().slice(0, 7);
  try { return db.prepare("SELECT COUNT(*) c FROM prospector_leads WHERE user_id = ? AND outreach_status = 'discovery' AND strftime('%Y-%m', created_at) = ?").get(userId, period).c || 0; } catch (_) { return 0; }
}

// Plain-English ICP -> structured search params (Claude). null on failure -> caller uses raw prompt.
async function parseICP(prompt, fetch) {
  const key = _lfAnthropicKey();
  if (!key) return null;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: LF_MODEL,
        max_tokens: 400,
        messages: [{ role: "user", content:
"Convert this plain-English ideal-customer description into structured search parameters for finding local businesses on Google Maps.\n\n" +
"Description: \"" + prompt + "\"\n\n" +
"Return JSON ONLY (no prose, no code fences):\n" +
"{\"category\":\"the business type as a short search noun e.g. plumber, dentist, gym\",\n" +
" \"locations\":[\"one or more cities/areas, each as 'City, Region' if implied\"],\n" +
" \"min_rating\":3.0,\"max_rating\":4.3,\"min_reviews\":5,\n" +
" \"keywords\":[\"optional extra qualifying words a buyer would use\"]}\n\n" +
"Rules:\n- If no location is given, return an empty locations array.\n" +
"- Only change min_rating/max_rating/min_reviews from the defaults (3.0 / 4.3 / 5) if the description clearly asks for higher/lower quality or size.\n" +
"- category must be a single concise search term." }]
      })
    });
    if (!r.ok) return null;
    const d = await r.json();
    let t = (d.content && d.content[0] && d.content[0].text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const p = JSON.parse(t);
    if (!p.category) return null;
    return {
      category: String(p.category).slice(0, 80),
      locations: Array.isArray(p.locations) ? p.locations.filter(Boolean).map(s => String(s).slice(0, 80)).slice(0, 5) : [],
      minRating: Number(p.min_rating) || 3.0,
      maxRating: Number(p.max_rating) || 4.3,
      minReviews: Number.isFinite(+p.min_reviews) ? +p.min_reviews : 5,
      keywords: Array.isArray(p.keywords) ? p.keywords.filter(Boolean).map(s => String(s).slice(0, 40)).slice(0, 6) : [],
    };
  } catch (e) { console.warn("[parseICP]", e.message); return null; }
}

// Google Places text search -> deduped places (skips top 3 already-winning results).
async function lfPlacesSearch(queries, key, fetch, cap) {
  const all = [];
  for (const q of queries) {
    let pageToken = null, pages = 0;
    do {
      const url = "https://maps.googleapis.com/maps/api/place/textsearch/json?query=" + encodeURIComponent(q) + "&key=" + key + (pageToken ? "&pagetoken=" + pageToken : "");
      const pr = await fetch(url);
      const pd = await pr.json();
      all.push(...(pd.results || []));
      pageToken = pd.next_page_token || null;
      pages++;
      if (pageToken) await new Promise(r => setTimeout(r, 2000));
    } while (pageToken && pages < 3 && all.length < cap + 3);
  }
  const seen = new Set();
  return all.filter(pl => { if (seen.has(pl.place_id)) return false; seen.add(pl.place_id); return true; }).slice(3, 3 + cap);
}

// Google Place Details -> contact/enrichment fields.
async function lfPlaceDetails(placeId, key, fetch) {
  try {
    const r = await fetch("https://maps.googleapis.com/maps/api/place/details/json?place_id=" + placeId + "&fields=name,formatted_phone_number,website,formatted_address,rating,user_ratings_total&key=" + key);
    const d = (await r.json()).result || {};
    return { name: d.name || null, phone: d.formatted_phone_number || null, website: d.website || null, address: d.formatted_address || null, rating: d.rating || null, reviews: d.user_ratings_total || 0 };
  } catch (e) { return {}; }
}

// Best-effort homepage email scrape.
async function lfScrapeEmail(website, fetch) {
  if (!website) return null;
  try {
    const res = await fetch(website, { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0" } });
    const html = await res.text();
    const m = html.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    if (m && !m[0].includes("example") && !m[0].includes("sentry") && !m[0].includes("wixpress")) return m[0].toLowerCase();
  } catch (e) {}
  return null;
}

// Score ICP fit using live research (Claude) -> { fit_score 0-100, fit_reason, signals(JSON) }.
async function scoreFit(icpPrompt, biz, research, fetch) {
  const key = _lfAnthropicKey();
  if (!key) return { fit_score: null, fit_reason: null, signals: null };
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: LF_MODEL,
        max_tokens: 300,
        messages: [{ role: "user", content:
"Score how well this business matches the buyer's ideal customer profile (ICP).\n\n" +
"ICP (who the buyer wants): \"" + icpPrompt + "\"\n\n" +
"Business:\n- Name: " + biz.business_name + "\n- Category: " + (biz.category || "?") + "\n- Location: " + (biz.city || biz.address || "?") +
"\n- Google rating: " + (biz.google_rating == null ? "?" : biz.google_rating) + " (" + (biz.google_reviews || 0) + " reviews)\n- Website: " + (biz.website_url || "none") +
"\nLive research:\n" + (research || "No research available.") + "\n\n" +
"Return JSON ONLY (no prose, no code fences):\n" +
"{\"fit_score\": <integer 0-100, how well they match the ICP>,\n" +
" \"fit_reason\": \"<one sentence, why they qualify or don't>\",\n" +
" \"signals\": [\"<0-3 short buying signals from the research e.g. 'hiring', 'recently expanded', 'no website', 'low rating'>\"]}\n\n" +
"Base the score on ICP match + research. Do not invent facts not present above." }]
      })
    });
    if (!r.ok) return { fit_score: null, fit_reason: null, signals: null };
    const d = await r.json();
    let t = (d.content && d.content[0] && d.content[0].text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const p = JSON.parse(t);
    let score = Math.round(Number(p.fit_score));
    score = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : null;
    return {
      fit_score: score,
      fit_reason: p.fit_reason ? String(p.fit_reason).slice(0, 300) : null,
      signals: Array.isArray(p.signals) ? JSON.stringify(p.signals.filter(Boolean).map(s => String(s).slice(0, 60)).slice(0, 3)) : null,
    };
  } catch (e) { console.warn("[scoreFit]", e.message); return { fit_score: null, fit_reason: null, signals: null }; }
}

// Orchestrator: discover -> enrich -> research -> score -> store. No demos, no outreach.
async function discoverLeads(db, userId, campaignId, icp) {
  const fetch = (await import("node-fetch")).default;
  try {
    const googleKey = getSetting("GOOGLE_PLACES_API_KEY") || process.env.GOOGLE_PLACES_API_KEY;
    if (!googleKey) throw new Error("GOOGLE_PLACES_API_KEY not configured in admin settings");

    const cap = icp.maxLeads;
    const locs = (icp.locations && icp.locations.length) ? icp.locations : [""];
    const queries = locs.map(loc => [icp.category, ...(icp.keywords || [])].join(" ").trim() + (loc ? " in " + loc : ""));
    const places = await lfPlacesSearch(queries, googleKey, fetch, cap);

    const qualified = places.filter(pl => {
      const rating = pl.rating || 0, reviews = pl.user_ratings_total || 0;
      return rating >= icp.minRating && rating <= icp.maxRating && reviews >= icp.minReviews;
    });
    db.prepare("UPDATE prospector_campaigns SET total_found = ? WHERE id = ?").run(qualified.length, campaignId);

    const cityLabel = locs[0] || "";
    // ── Lead Finder quota / overage (mirrors the demo overage mechanism) ──
    const urow = db.prepare("SELECT plan, role FROM users WHERE id = ?").get(userId) || {};
    const lfIsAdmin = urow.role === "admin";
    const lfQuota = getLeadQuota(urow.plan || "starter", lfIsAdmin);
    const lfPrice = getLeadOveragePrice(urow.plan || "starter");
    const lfPeriod = new Date().toISOString().slice(0, 7);
    const lfPrior = leadUsageThisMonth(db, userId);
    let lfRun = 0;
    const ins = db.prepare("INSERT INTO prospector_leads " +
      "(id, campaign_id, user_id, business_name, website_url, phone, email, address, city, category, " +
      "google_rating, google_reviews, research_text, fit_score, fit_reason, signals, outreach_status) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'discovery')");

    const CHUNK = 3;
    for (let i = 0; i < qualified.length; i += CHUNK) {
      // honour cancellation
      const cRow = db.prepare("SELECT status, cancelled FROM prospector_campaigns WHERE id = ?").get(campaignId);
      if (cRow && (cRow.cancelled || cRow.status === "cancelled")) break;
      const chunk = qualified.slice(i, i + CHUNK);
      await Promise.all(chunk.map(async (pl) => {
        const det = await lfPlaceDetails(pl.place_id, googleKey, fetch);
        const bizName = det.name || pl.name;
        const website = det.website || null;
        const email = await lfScrapeEmail(website, fetch);
        const research = await prospectResearch(bizName, cityLabel || det.address || "", icp.category, fetch);
        const biz = {
          business_name: bizName, category: icp.category, city: cityLabel,
          address: det.address || pl.formatted_address || "",
          google_rating: det.rating != null ? det.rating : (pl.rating != null ? pl.rating : null),
          google_reviews: det.reviews != null ? det.reviews : (pl.user_ratings_total || 0),
          website_url: website,
        };
        const fit = await scoreFit(icp.prompt || icp.category, biz, research, fetch);
        try {
          ins.run(uuid(), campaignId, userId, bizName, website, det.phone || null, email,
            biz.address, cityLabel, icp.category, biz.google_rating, biz.google_reviews,
            research || null, fit.fit_score, fit.fit_reason, fit.signals);
          lfRun++;
          if (lfQuota !== Infinity && (lfPrior + lfRun) > lfQuota) {
            try {
              db.prepare("INSERT INTO overage_charges (id, user_id, metric, quantity, unit_price, total, period, status) VALUES (?,?,?,?,?,?,?,?)")
                .run(uuid(), userId, "prospectorLeads", 1, lfPrice, lfPrice, lfPeriod, "pending");
            } catch (e) { console.warn("[lead overage]", e.message); }
          }
        } catch (e) { console.warn("[discoverLeads insert]", e.message); }
      }));
      if (i + CHUNK < qualified.length) await new Promise(r => setTimeout(r, 300));
    }

    db.prepare("UPDATE prospector_campaigns SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(campaignId);
  } catch (e) {
    console.error("[Lead Finder]", e.message);
    try { db.prepare("UPDATE prospector_campaigns SET status = 'failed', error = ? WHERE id = ?").run(e.message, campaignId); } catch (_) {}
  }
}

// ── POST /api/prospector/find-leads ── plain-English ICP -> scored lead list ──
router.post("/find-leads", auth, prospectorLimiter, async (req, res) => {
  const db = getDb();
  ensureTables(db);
  const user = db.prepare("SELECT plan, role FROM users WHERE id = ?").get(req.userId);
  const isAdmin = user && user.role === "admin";
  const plan = (user && user.plan) || "starter";
  if (!isAdmin && !hasProspectorAddon(db, req.userId)) {
    return res.status(403).json({ error: "Lead Finder requires the Prospector add-on ($79/mo).", upgrade: true });
  }
  const prompt = String((req.body && req.body.prompt) || "").trim();
  if (!prompt) return res.status(400).json({ error: "Describe the leads you want, e.g. 'plumbers in Brisbane rated under 4.3 stars'." });
  const maxLeads = Math.min(Number(req.body && req.body.maxLeads) || 25, isAdmin ? 1000 : plan === "enterprise" ? 500 : 200);

  const fetch = (await import("node-fetch")).default;
  const parsed = await parseICP(prompt, fetch);
  const icp = {
    prompt,
    category: (parsed && parsed.category) || prompt,
    locations: (parsed && parsed.locations) || [],
    keywords: (parsed && parsed.keywords) || [],
    minRating: parsed ? parsed.minRating : 3.0,
    maxRating: parsed ? parsed.maxRating : 4.3,
    minReviews: parsed ? parsed.minReviews : 5,
    maxLeads,
  };

  const campaignId = uuid();
  try { db.exec("ALTER TABLE prospector_campaigns ADD COLUMN cancelled INTEGER DEFAULT 0"); } catch (e) {}
  db.prepare("INSERT INTO prospector_campaigns (id, user_id, city, category, status, mode, icp_prompt) VALUES (?,?,?,?,?,?,?)")
    .run(campaignId, req.userId, (icp.locations[0] || "-"), icp.category, "running", "discovery", prompt);

  res.json({ success: true, campaignId, icp: { category: icp.category, locations: icp.locations, minRating: icp.minRating, maxRating: icp.maxRating, minReviews: icp.minReviews },
    quota: { included: isAdmin ? null : getLeadQuota(plan, false), usedThisMonth: leadUsageThisMonth(db, req.userId), overagePrice: getLeadOveragePrice(plan), unlimited: !!isAdmin },
    message: "Finding leads..." });

  discoverLeads(db, req.userId, campaignId, icp).catch(e => {
    try { db.prepare("UPDATE prospector_campaigns SET status = 'failed', error = ? WHERE id = ?").run(e.message, campaignId); } catch (_) {}
  });
});

// ── GET /api/prospector/find-leads/:id ── status + scored leads (fit desc) ──
router.get("/find-leads/:id", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const c = db.prepare("SELECT * FROM prospector_campaigns WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!c) return res.status(404).json({ error: "Not found" });
  const leads = db.prepare("SELECT id, business_name, website_url, phone, email, address, city, category, " +
      "google_rating, google_reviews, fit_score, fit_reason, signals, research_text " +
      "FROM prospector_leads WHERE campaign_id = ? AND user_id = ? " +
      "ORDER BY (fit_score IS NULL), fit_score DESC, google_reviews DESC").all(req.params.id, req.userId)
    .map(l => { try { l.signals = l.signals ? JSON.parse(l.signals) : []; } catch (_) { l.signals = []; } return l; });
  res.json({
    campaign: { id: c.id, status: c.status, total_found: c.total_found, icp_prompt: c.icp_prompt, category: c.category, created_at: c.created_at, completed_at: c.completed_at, error: c.error },
    leads,
    done: c.status === "completed" || c.status === "failed",
  });
});

// ── GET /api/prospector/find-leads/:id/export ── CSV download ──
router.get("/find-leads/:id/export", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const c = db.prepare("SELECT id FROM prospector_campaigns WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!c) return res.status(404).json({ error: "Not found" });
  const rows = db.prepare("SELECT business_name, website_url, phone, email, address, city, category, " +
      "google_rating, google_reviews, fit_score, fit_reason, signals " +
      "FROM prospector_leads WHERE campaign_id = ? AND user_id = ? " +
      "ORDER BY (fit_score IS NULL), fit_score DESC").all(req.params.id, req.userId);
  const cols = ["business_name","website_url","phone","email","address","city","category","google_rating","google_reviews","fit_score","fit_reason","signals"];
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    let s = String(v);
    if (typeof v === "string" && v.charAt(0) === "[") { try { s = JSON.parse(v).join("; "); } catch (_) {} }
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = [cols.join(",")].concat(rows.map(r => cols.map(k => esc(r[k])).join(","))).join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="mine-leads-' + req.params.id + '.csv"');
  res.send(csv);
});

module.exports = router;
// Also expose internal functions so other route modules (ai-employees.js)
// can call the campaign runner directly for autonomous daily scans.
module.exports.runProspectorCampaign = runProspectorCampaign;
module.exports.hasProspectorAddon = hasProspectorAddon;
