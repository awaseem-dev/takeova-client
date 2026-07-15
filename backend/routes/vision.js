/**
 * MINE Vision API
 * Uses Claude's image understanding to extract structured data from photos.
 *
 * Features:
 *   POST /api/vision/receipt     — photo of receipt → expense entry
 *   POST /api/vision/business-card → photo of card → CRM contact
 *   POST /api/vision/competitor  — screenshot/photo → competitive analysis
 *   POST /api/vision/product     — product photo → description + SEO copy
 *
 * All endpoints accept base64 image data. Auth required. No extra charge
 * beyond normal AI usage — uses existing ANTHROPIC_API_KEY.
 */

const express = require("express");
const router  = express.Router();
const { getDb, getSetting } = require("../db/init");
const { auth } = require("../middleware/auth");
const rateLimit = require("express-rate-limit");

const visionLimiter = rateLimit({ windowMs: 60_000, max: 20, keyGenerator: r => r.userId || r.ip });

// ── Helper: call Claude with an image ────────────────────────────────────────
async function analyseImage(imageBase64, mediaType, systemPrompt, userPrompt, maxTokens = 1000) {
  const fetch = (await import("node-fetch")).default;
  const apiKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6", // Vision requires Sonnet or Opus
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType || "image/jpeg",
              data: imageBase64
            }
          },
          { type: "text", text: userPrompt }
        ]
      }]
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude Vision API error: ${res.status} ${err}`);
  }

  const data = await res.json();
  return data.content?.[0]?.text || "";
}

// ── POST /api/vision/receipt ──────────────────────────────────────────────────
router.post("/receipt", auth, visionLimiter, async (req, res) => {
  try {
    const { imageBase64, mediaType } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "imageBase64 required" });

    const result = await analyseImage(
      imageBase64,
      mediaType || "image/jpeg",
      "You extract structured expense data from receipt photos. Always respond with valid JSON only.",
      `Extract all expense information from this receipt photo.

Return ONLY this JSON structure, no other text:
{
  "vendor": "business name",
  "date": "YYYY-MM-DD or null if unclear",
  "total": 12.50,
  "currency": "GBP",
  "category": "one of: food, travel, office, equipment, software, utilities, marketing, other",
  "items": [{"description": "item name", "amount": 5.00}],
  "tax": 2.10,
  "payment_method": "card/cash/unknown",
  "receipt_number": "ref if visible or null",
  "notes": "any relevant details"
}`
    );

    // Parse JSON from Claude's response
    const clean = result.replace(/```json|```/g, "").trim();
    const data = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(clean);
    res.json({ success: true, data });
  } catch(e) {
    if (!res.headersSent) console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' });
  }
});

// ── POST /api/vision/business-card ───────────────────────────────────────────
router.post("/business-card", auth, visionLimiter, async (req, res) => {
  try {
    const { imageBase64, mediaType } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "imageBase64 required" });

    const result = await analyseImage(
      imageBase64,
      mediaType || "image/jpeg",
      "You extract contact information from business card photos. Always respond with valid JSON only.",
      `Extract all contact information from this business card.

Return ONLY this JSON structure, no other text:
{
  "name": "full name",
  "first_name": "first",
  "last_name": "last",
  "title": "job title or null",
  "company": "company name or null",
  "email": "email@example.com or null",
  "phone": "+44... or null",
  "mobile": "+44... or null",
  "website": "https://... or null",
  "address": "full address or null",
  "linkedin": "linkedin url or null",
  "notes": "any other relevant details"
}`
    );

    const clean = result.replace(/```json|```/g, "").trim();
    const data = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(clean);
    res.json({ success: true, data });
  } catch(e) {
    if (!res.headersSent) console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' });
  }
});

// ── POST /api/vision/competitor ──────────────────────────────────────────────
router.post("/competitor", auth, visionLimiter, async (req, res) => {
  try {
    const { imageBase64, mediaType, context } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "imageBase64 required" });

    const result = await analyseImage(
      imageBase64,
      mediaType || "image/jpeg",
      "You are a sharp business analyst who identifies competitive insights from images of competitor websites, menus, price lists, or marketing materials.",
      `Analyse this image of a competitor's business material${context ? ` (context: ${context})` : ""}.

Extract and provide:
1. What they're selling and at what price points (if visible)
2. Their key messaging and value proposition
3. Their apparent target customer
4. 3 specific weaknesses or gaps you can see
5. 3 things they're doing well
6. How to position against them

Be specific and actionable. Format as clear sections.`,
      800
    );

    res.json({ success: true, analysis: result });
  } catch(e) {
    if (!res.headersSent) console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' });
  }
});

// ── POST /api/vision/product ─────────────────────────────────────────────────
router.post("/product", auth, visionLimiter, async (req, res) => {
  try {
    const { imageBase64, mediaType, productName, category } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "imageBase64 required" });

    const result = await analyseImage(
      imageBase64,
      mediaType || "image/jpeg",
      "You write compelling, SEO-optimised product copy from product photos. Always respond with valid JSON only.",
      `Write product copy for this item${productName ? ` (product: ${productName})` : ""}${category ? ` in the ${category} category` : ""}.

Return ONLY this JSON structure:
{
  "title": "compelling product title (50 chars max)",
  "short_description": "1-2 sentence hook (100 chars max)",
  "full_description": "Full product description with benefits, 150-200 words",
  "bullet_points": ["key feature 1", "key feature 2", "key feature 3", "key feature 4"],
  "seo_title": "SEO optimised title tag",
  "seo_description": "Meta description (155 chars max)",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "suggested_price_range": "e.g. $29-49 based on perceived quality and category"
}`
    );

    const clean = result.replace(/```json|```/g, "").trim();
    const data = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(clean);
    res.json({ success: true, data });
  } catch(e) {
    if (!res.headersSent) console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// VISION SITE EDITOR — clone style from any image
//
// The reverse of the other vision endpoints: instead of extracting data FROM
// an image to populate MINE, this extracts a DESIGN SYSTEM from an image and
// applies it to the user's MINE site.
//
// Killer use case: user finds an Apple/Stripe/competitor page they love.
// They upload a screenshot. Claude reads the visual language and generates
// a matching MINE site — same palette, similar typography, equivalent
// layout DNA. No need to describe the design in words.
//
//   POST /api/vision/site-analyze   — image → design system JSON (preview)
//   POST /api/vision/site-clone     — image + business → full site JSON
//   POST /api/vision/site-restyle   — image + existing site → restyle in place
// ═══════════════════════════════════════════════════════════════════════════

const DESIGN_SYSTEM_PROMPT = `You are TAKEOVA's design analyst. The user has uploaded a screenshot of a website, landing page, or visual reference they want their own site to resemble in style.

Extract a complete design system that TAKEOVA's site builder can apply. Be precise — these values feed into actual CSS/HTML generation.

Output STRICT JSON only, no prose, no markdown fences. Schema:

{
  "palette": {
    "primary":   "#hex",   // dominant brand color, used for CTAs/links
    "accent":    "#hex",   // secondary highlight color
    "background":"#hex",   // page background
    "surface":   "#hex",   // card/section background (often near-white or off-bg)
    "text":      "#hex",   // primary text color
    "muted":     "#hex"    // secondary/muted text color
  },
  "typography": {
    "heading_family": "Inter | Playfair Display | Space Grotesk | Manrope | ...",
    "body_family":    "Inter | system-ui | ...",
    "heading_weight": 400 | 500 | 600 | 700 | 800,
    "tracking":       "tight" | "normal" | "wide",
    "scale":          "compact" | "normal" | "generous"
  },
  "layout": {
    "spacing":          "tight" | "comfortable" | "spacious",
    "radius":           "sharp" | "soft" | "rounded" | "pill",
    "container_width":  "narrow" | "default" | "wide" | "full",
    "section_rhythm":   "uniform" | "alternating-bg" | "card-stack",
    "hero_style":       "centered-text" | "split-image-text" | "full-bleed" | "minimal-typographic",
    "navigation":       "centered" | "left-logo-right-links" | "sticky-translucent" | "hamburger"
  },
  "mood": ["luxury","editorial","playful","brutalist","minimalist","corporate","tech","wellness","retro"],
  "copy_tone": "formal" | "warm" | "punchy" | "luxurious" | "technical" | "playful",
  "notable_elements": [
    "specific visual quirks worth replicating, e.g. 'oversized serif headings with -2% letter-spacing'",
    "'subtle grain texture on hero background'",
    "'pill-shaped CTAs with shadow'"
  ],
  "confidence": 0.0-1.0
}

Pick exactly ONE value for each enum field. Pick 2-4 mood tags from the list. Notable elements: 2-5 items. If image quality is poor or unclear, lower confidence accordingly but still return the best inference.`;

// ─── POST /api/vision/site-analyze ───────────────────────────────────────────
// Returns the design system JSON only — useful for preview before commit.
router.post("/site-analyze", auth, visionLimiter, async (req, res) => {
  try {
    const { imageBase64, mediaType } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "imageBase64 required" });

    const raw = await analyseImage(
      imageBase64,
      mediaType || "image/jpeg",
      DESIGN_SYSTEM_PROMPT,
      "Analyze this design and return the JSON design system. Strict JSON only.",
      1200
    );

    const clean = String(raw).replace(/```json|```/g, "").trim();
    let data;
    try { data = JSON.parse(clean); }
    catch (_) {
      return res.status(502).json({ error: "Could not parse design system from model response. Try a clearer screenshot.", raw: clean.slice(0, 500) });
    }

    res.json({ success: true, design_system: data });
  } catch (e) {
    console.error("[vision/site-analyze]", e.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── POST /api/vision/site-clone ─────────────────────────────────────────────
// One-shot: image + business info → full site sections JSON, ready for
// the site builder to render. Combines design-system extraction with
// section/copy generation in two calls.
router.post("/site-clone", auth, visionLimiter, async (req, res) => {
  try {
    const { imageBase64, mediaType, business_name, business_type, business_description } = req.body;
    if (!imageBase64)    return res.status(400).json({ error: "imageBase64 required" });
    if (!business_name)  return res.status(400).json({ error: "business_name required" });

    // Step 1 — extract design system from the image
    const rawDs = await analyseImage(
      imageBase64,
      mediaType || "image/jpeg",
      DESIGN_SYSTEM_PROMPT,
      "Analyze this design and return the JSON design system. Strict JSON only.",
      1200
    );
    let designSystem;
    try { designSystem = JSON.parse(String(rawDs).replace(/```json|```/g, "").trim()); }
    catch (_) {
      return res.status(502).json({ error: "Design analysis failed — please try a clearer image" });
    }

    // Step 2 — generate matching site content using the design system as
    // constraint. This is a text-only call (no image) for speed and to
    // keep the model focused on writing copy in the right voice.
    const fetch = (await import("node-fetch")).default;
    const apiKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

    const sitePrompt = `Generate a complete MINE website for the following business, styled to MATCH this design system:

BUSINESS
  Name:        ${business_name}
  Type:        ${business_type || "general"}
  Description: ${business_description || "(none provided)"}

DESIGN SYSTEM (already chosen — copy must match this voice)
${JSON.stringify(designSystem, null, 2)}

Generate sections to populate a TAKEOVA site. Output STRICT JSON only:

{
  "site_title": "...",
  "tagline": "one-line value prop matching the design system's copy_tone",
  "sections": [
    { "type": "hero",        "headline": "...", "subhead": "...", "cta_label": "...", "cta_action": "/contact" },
    { "type": "value_props", "items": [{ "title": "...", "body": "..." }, ...] },
    { "type": "about",       "headline": "...", "body": "..." },
    { "type": "testimonials","items": [{ "quote": "...", "author": "...", "role": "..." }, ...] },
    { "type": "cta",         "headline": "...", "subhead": "...", "cta_label": "..." },
    { "type": "footer",      "tagline": "...", "links": ["About","Contact","Privacy","Terms"] }
  ],
  "seo": { "title": "...", "description": "...", "keywords": ["...", "..."] }
}

Match the copy_tone EXACTLY. Match heading length to the typography scale (compact = short headlines, generous = longer). Match the mood — a "luxury" site needs aspirational copy, a "playful" site needs energy. Never invent fake testimonials with real-looking names — use placeholders like "Sarah K." or "[Customer Name]". STRICT JSON ONLY, no prose.`;

    const siteRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 3000,
        messages: [{ role: "user", content: sitePrompt }],
      }),
    });
    if (!siteRes.ok) {
      const t = await siteRes.text();
      return res.status(502).json({ error: "Site generation failed: " + t.slice(0, 200) });
    }
    const siteData = await siteRes.json();
    const siteRaw = siteData.content?.[0]?.text || "";
    let site;
    try { site = JSON.parse(String(siteRaw).replace(/```json|```/g, "").trim()); }
    catch (_) {
      return res.status(502).json({ error: "Could not parse generated site. Please try again." });
    }

    res.json({ success: true, design_system: designSystem, site });
  } catch (e) {
    console.error("[vision/site-clone]", e.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── POST /api/vision/site-restyle ───────────────────────────────────────────
// Keep the user's existing content; just apply the new design system.
// Useful when they like their copy but want to refresh the look.
router.post("/site-restyle", auth, visionLimiter, async (req, res) => {
  try {
    const { imageBase64, mediaType, site_id } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "imageBase64 required" });
    if (!site_id)     return res.status(400).json({ error: "site_id required" });

    // 1. Extract design system from image
    const raw = await analyseImage(
      imageBase64, mediaType || "image/jpeg",
      DESIGN_SYSTEM_PROMPT,
      "Return the JSON design system for this design. Strict JSON only.",
      1200
    );
    let ds;
    try { ds = JSON.parse(String(raw).replace(/```json|```/g, "").trim()); }
    catch (_) { return res.status(502).json({ error: "Design analysis failed" }); }

    // 2. Apply to the existing site row (palette, typography, layout)
    // Site builder reads these fields when rendering, so updating here
    // re-styles without touching copy.
    const db = getDb();
    const site = db.prepare("SELECT id, user_id FROM sites WHERE id = ? AND user_id = ?").get(site_id, req.userId);
    if (!site) return res.status(404).json({ error: "Site not found" });

    db.prepare(`
      UPDATE sites
      SET   brand_primary   = ?,
            brand_accent    = ?,
            brand_bg        = ?,
            brand_text      = ?,
            heading_font    = ?,
            body_font       = ?,
            border_radius   = ?,
            spacing         = ?,
            updated_at      = datetime('now')
      WHERE id = ?
    `).run(
      ds.palette?.primary    || null,
      ds.palette?.accent     || null,
      ds.palette?.background || null,
      ds.palette?.text       || null,
      ds.typography?.heading_family || null,
      ds.typography?.body_family    || null,
      ds.layout?.radius      || "soft",
      ds.layout?.spacing     || "comfortable",
      site_id
    );

    res.json({ success: true, design_system: ds });
  } catch (e) {
    console.error("[vision/site-restyle]", e.message);
    res.status(500).json({ error: "Internal error" });
  }
});

module.exports = router;
