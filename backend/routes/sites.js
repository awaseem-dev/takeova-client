const express = require("express");
const rateLimit = require('express-rate-limit');
const { v4: uuid } = require("uuid");
const { getDb } = require("../db/init");
const { auth } = require("../middleware/auth");

const router = express.Router();
const siteCreateLimiter = rateLimit({ windowMs: 60000, max: 10, message: { error: "Too many site creation requests." } });

// ─── LIST USER'S SITES ───
function planCap(plan, key, fallback) {
  try { const C = require("./features").PLAN_CAPS || {}; const p = C[plan] || null; if (p && p[key] != null) return p[key]; } catch (_) {}
  return fallback;
}

router.get("/", auth, (req, res) => {
  const db = getDb();
  const sites = db.prepare("SELECT * FROM sites WHERE user_id = ? ORDER BY created_at DESC").all(req.userId);
  // Attach products, orders, invoices, courses, etc. for each site
  const full = sites.map(s => hydrateSite(db, s));
  res.json({ sites: full });
});

// ─── QR ORDER LOOKUP (used by mobile scanner) ───
// Must be registered BEFORE /:id to avoid being caught by the catch-all
router.get("/orders/qr/:data", auth, (req, res) => {
  const db = getDb();
  const data = decodeURIComponent(req.params.data);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT, order_number TEXT, customer_name TEXT, customer_email TEXT, items TEXT, total REAL, shipping_address TEXT, status TEXT, fulfillment_status TEXT, tracking_number TEXT, tracking_url TEXT, notes TEXT, created_at TEXT)");
    const order = db.prepare("SELECT * FROM orders WHERE user_id = ? AND (id = ? OR order_number = ?) LIMIT 1").get(req.userId, data, data);
    if (!order) return res.json({ error: "Order not found" });
    res.json({ ...order, items: JSON.parse(order.items || "[]") });
  } catch (e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// ─── GET SINGLE SITE ───
router.get("/:id", auth, (req, res) => {
  const db = getDb();
  const site = db.prepare("SELECT * FROM sites WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!site) return res.status(404).json({ error: "Site not found" });
  res.json({ site: hydrateSite(db, site) });
});

// ─── CREATE SITE ───
router.post("/", auth, (req, res) => {
  const db = getDb();
  const user = db.prepare("SELECT plan FROM users WHERE id = ?").get(req.userId);
  const siteCount = db.prepare("SELECT COUNT(*) as c FROM sites WHERE user_id = ?").get(req.userId).c;

  // Free users: 1 site. Check plan limits.
  // Change 16: PLAN_CAPS is the single source of truth (free/no-plan users: 1)
  const max = (user && user.plan) ? planCap(user.plan, "sites", 1) : 1;
  if (siteCount >= max) {
      if (String(user && user.plan).toLowerCase() === "agency") {
        // AGENCY ONLY: past-cap sites allowed, billed $3/site/mo on the agency invoice (agency.js cron). Ceiling 80 — TUNABLE.
        if (siteCount >= 80) return res.status(403).json({ error: "Site safety ceiling reached — contact support to raise it.", code: "SITE_CEILING" });
      } else return res.status(403).json({ error: "Site limit reached. Upgrade your plan.", requiresUpgrade: true });
    }

  const { name, template, catId, html, domain, logo, primaryColor, secondaryColor, colors } = req.body;
  const colorsJson = colors ? JSON.stringify(colors) : JSON.stringify({ primary: primaryColor || "#2563EB", secondary: secondaryColor || "#7C3AED" });
  const id = uuid();
  const slug = (name || "mysite").toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");

  // Inherit agency_id if this user is an agency client — ensures new sites appear in agency portfolio
  const siteOwner = db.prepare("SELECT agency_id FROM users WHERE id = ?").get(req.userId);
  const agencyId  = siteOwner?.agency_id || null;

  db.prepare(`
    INSERT INTO sites (id, user_id, agency_id, name, template, category, html, domain, logo, colors_json, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
  `).run(id, req.userId, agencyId, name, template, catId || null, html, domain || (slug + "." + (process.env.MAIN_HOST || "takeova.ai")), logo || null, colorsJson);

  try { if (global.mineTrackUsage) global.mineTrackUsage(db, req.userId, "sites"); } catch(e) {}
  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(id);
  res.json({ site: hydrateSite(db, site) });
});

// ─── IMPORT SITE FROM URL ───
// Scrapes a URL (HTML, meta, headings, images, products) and rebuilds it as a
// MINE-hosted site by feeding the scraped content to Claude. Called by the
// dashboard intent-bootstrap when a user pasted a URL on the landing page.
//
// Flow:
//   1. Validate URL is publicly fetchable (no localhost, no internal IPs)
//   2. Fetch the HTML (10s timeout, 1MB cap)
//   3. Use jsdom to parse: title, meta description, headings, paragraphs,
//      images, links, brand colors from inline CSS
//   4. Send a structured summary to Claude with instructions to produce a
//      MINE-compatible HTML site mirroring the structure
//   5. Save as a new site with status=draft, return site object
//
// Quotas: same as ai_edits_used (counts as 5 edits since it's a full build)
router.post("/import-from-url", auth, async (req, res) => {
  let JSDOM;
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url required' });

    // SSRF guard — block private IPs and non-http(s) schemes
    let parsed;
    try { parsed = new URL(url); } catch(e) { return res.status(400).json({ error: 'Invalid URL format' }); }
    if (!/^https?:$/.test(parsed.protocol)) return res.status(400).json({ error: 'Only http(s) URLs supported' });
    const host = parsed.hostname.toLowerCase();
    const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
    if (blockedHosts.includes(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) {
      return res.status(400).json({ error: 'Cannot import from internal/private addresses' });
    }

    // Quota check — costs 5 ai_edits_used because it's a full build
    const db = getDb();
    const user = db.prepare(`SELECT plan, ai_edits_used FROM users WHERE id = ?`).get(req.userId);
    // Change 16: caps from PLAN_CAPS
    const cap = planCap((user && user.plan), "edits", 30);
    if ((user?.ai_edits_used || 0) + 5 > cap) {
      return res.status(402).json({ error: 'AI edit quota would be exceeded — upgrade plan or wait for reset' });
    }

    // Anthropic key required to translate scraped content → MINE site
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return res.status(500).json({ error: 'AI not configured on this server' });

    // Fetch the page with a timeout and size limit
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let pageHtml;
    try {
      const r = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'MINE-SiteImporter/1.0 (+https://takeova.ai)' }
      });
      clearTimeout(timeout);
      if (!r.ok) return res.status(400).json({ error: `Could not fetch URL — got ${r.status}` });
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('html')) return res.status(400).json({ error: 'URL did not return HTML' });
      // 1MB cap to prevent memory abuse
      const text = await r.text();
      if (text.length > 1_000_000) {
        pageHtml = text.slice(0, 1_000_000);
      } else {
        pageHtml = text;
      }
    } catch(e) {
      clearTimeout(timeout);
      const msg = e?.name === 'AbortError' ? 'Page took too long to load (10s timeout)' : 'Could not fetch URL — check it\'s publicly accessible';
      return res.status(400).json({ error: msg });
    }

    // Parse with jsdom — extract structured content for Claude to work with
    try { JSDOM = require('jsdom').JSDOM; } catch(e) { return res.status(500).json({ error: 'Server missing jsdom — install dependencies' }); }
    let scraped;
    try {
      const dom = new JSDOM(pageHtml);
      const doc = dom.window.document;
      const title = doc.querySelector('title')?.textContent?.trim() || '';
      const metaDesc = doc.querySelector('meta[name="description"]')?.getAttribute('content') || '';
      const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
      const ogImage = doc.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
      const headings = Array.from(doc.querySelectorAll('h1, h2, h3')).slice(0, 30).map(h => ({
        level: h.tagName.toLowerCase(), text: (h.textContent || '').trim().slice(0, 200)
      })).filter(h => h.text);
      const paragraphs = Array.from(doc.querySelectorAll('p')).slice(0, 50).map(p => (p.textContent || '').trim().slice(0, 400)).filter(t => t.length > 20);
      const images = Array.from(doc.querySelectorAll('img')).slice(0, 20).map(i => ({
        src: i.getAttribute('src') || '', alt: i.getAttribute('alt') || ''
      })).filter(i => i.src && !i.src.startsWith('data:'));
      const links = Array.from(doc.querySelectorAll('nav a, header a')).slice(0, 15).map(a => (a.textContent || '').trim()).filter(t => t && t.length < 30);
      // Try to grab brand color from inline styles or theme-color meta
      const themeColor = doc.querySelector('meta[name="theme-color"]')?.getAttribute('content') || '';
      scraped = { url, title, metaDesc, ogTitle, ogImage, themeColor, headings, paragraphs: paragraphs.slice(0, 20), images, links };
    } catch(e) {
      console.error('[/import-from-url] parse error:', e?.message || e);
      return res.status(500).json({ error: 'Could not parse the page HTML' });
    }

    // Build the prompt for Claude — include scraped content, ask for a TAKEOVA-style site
    const systemPrompt = 'You are an expert web developer building a single-page business website. ' +
      'Output ONLY a complete HTML document — no markdown, no explanation, no code fences. ' +
      'Include <html>, <head> (with title, viewport, theme-color), and <body>. ' +
      'Use modern CSS in a <style> block in the head — clean, professional, mobile-responsive. ' +
      'For a shop or products section, output an empty <div data-mine-products></div> container (MINE fills it live from the catalogue) instead of hard-coded product cards; use data-mine-booking and data-mine-course attributes on booking and course elements where appropriate. ' +
      'Sections to consider: hero, about, services/products, gallery, testimonials, contact, footer. ' +
      'Mirror the source site\'s tone, structure and content but produce a clean, fast, modern MINE version.';

    const userPrompt = 'I want to import this site as a starting point for my MINE site:\n\n' +
      'Source URL: ' + url + '\n' +
      'Page title: ' + (scraped.title || scraped.ogTitle || 'Untitled') + '\n' +
      'Meta description: ' + (scraped.metaDesc || '(none)') + '\n' +
      'Theme color: ' + (scraped.themeColor || '(none)') + '\n\n' +
      'Headings:\n' + scraped.headings.map(h => '  ' + h.level.toUpperCase() + ': ' + h.text).join('\n') + '\n\n' +
      'Body content (first ' + scraped.paragraphs.length + ' paragraphs):\n' + scraped.paragraphs.map((p, i) => '  ' + (i+1) + '. ' + p).join('\n') + '\n\n' +
      'Navigation links: ' + scraped.links.join(' | ') + '\n\n' +
      'Images mentioned (' + scraped.images.length + ' total — use placeholders or first few real ones):\n' +
      scraped.images.slice(0, 5).map(i => '  - ' + i.src + (i.alt ? ' (alt: "' + i.alt + '")' : '')).join('\n') + '\n\n' +
      'Build a single-page MINE-hosted version of this site. Mirror the structure and content but produce a clean, modern, mobile-responsive page. Use the original brand colors if visible. Keep it under 200KB of HTML.';

    let aiHtml;
    try {
      const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': anthropicKey, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6', max_tokens: 8000,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }]
        })
      });
      const aiData = await aiResp.json();
      if (!aiResp.ok || !aiData.content) {
        console.error('[/import-from-url] AI error:', aiData?.error?.message || aiResp.status);
        return res.status(502).json({ error: 'AI generation failed — try again' });
      }
      aiHtml = (aiData.content[0]?.text || '').replace(/^```html?\s*\n?|```\s*$/g, '').trim();
      if (!aiHtml || aiHtml.length < 200) {
        return res.status(502).json({ error: 'AI returned empty/invalid HTML' });
      }
    } catch(e) {
      console.error('[/import-from-url] fetch error:', e?.message || e);
      return res.status(502).json({ error: 'Could not reach AI service' });
    }

    // Create the site
    const siteCount = db.prepare('SELECT COUNT(*) as c FROM sites WHERE user_id = ?').get(req.userId).c;
    // Change 16: PLAN_CAPS is the single source of truth (free/no-plan users: 1)
    const max = (user && user.plan) ? planCap(user.plan, "sites", 1) : 1;
    if (siteCount >= max) {
      if (String(user && user.plan).toLowerCase() === "agency") {
        // AGENCY ONLY: past-cap sites allowed, billed $3/site/mo on the agency invoice (agency.js cron). Ceiling 80 — TUNABLE.
        if (siteCount >= 80) return res.status(403).json({ error: "Site safety ceiling reached — contact support to raise it.", code: "SITE_CEILING" });
      } else return res.status(403).json({ error: 'Site limit reached for your plan', requiresUpgrade: true });
    }

    const siteId = uuid();
    const siteName = scraped.title || scraped.ogTitle || ('Site from ' + parsed.hostname);
    const slug = siteName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 40) || 'imported-site';
    const colorsJson = JSON.stringify({ primary: scraped.themeColor || '#2563EB', secondary: '#7C3AED' });
    const siteOwner = db.prepare('SELECT agency_id FROM users WHERE id = ?').get(req.userId);
    const agencyId = siteOwner?.agency_id || null;

    db.prepare(`
      INSERT INTO sites (id, user_id, agency_id, name, template, html, domain, colors_json, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')
    `).run(siteId, req.userId, agencyId, siteName, 'imported', aiHtml, slug + '.' + (process.env.MAIN_HOST || 'takeova.ai'), colorsJson);

    // Bump usage counter (5 edits worth)
    try { db.prepare('UPDATE users SET ai_edits_used = COALESCE(ai_edits_used, 0) + 5 WHERE id = ?').run(req.userId); } catch(e) {}

    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
    try { if (global.mineTrackUsage) global.mineTrackUsage(db, req.userId, "sites"); } catch(e) {}
    res.json({ site, importedFrom: url, sourceTitle: scraped.title });
  } catch(e) {
    console.error('[/import-from-url]', e?.message || e);
    if (!res.headersSent) res.status(500).json({ error: 'Import failed — please try again' });
  }
});

// ─── GENERATE SITE FROM PROMPT ───
// Creates a site from scratch based on a text description. Called by the
// dashboard intent-bootstrap when a user typed a description on the landing
// page hero (e.g. "I sell streetwear hoodies, bold urban brand").
//
// Costs 5 ai_edits_used. Returns the same shape as /import-from-url so the
// frontend can handle them uniformly.
router.post("/generate-from-prompt", auth, async (req, res) => {
  try {
    const { prompt, referenceImage } = req.body || {};
    if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt required' });
    if (prompt.length > 2000) return res.status(400).json({ error: 'Description too long — keep it under 2000 characters' });
    if (referenceImage) {
      if (!referenceImage.data || !/^image\/(png|jpeg|webp)$/.test(referenceImage.media_type || '')) return res.status(400).json({ error: 'Reference must be PNG, JPEG or WebP' });
      if (String(referenceImage.data).length > 5200000) return res.status(400).json({ error: 'Reference image too large (max ~3.5MB)' });
    }

    const db = getDb();
    const user = db.prepare(`SELECT plan, ai_edits_used FROM users WHERE id = ?`).get(req.userId);
    // Change 16: caps from PLAN_CAPS
    const cap = planCap((user && user.plan), "edits", 30);
    if ((user?.ai_edits_used || 0) + 5 > cap) {
      return res.status(402).json({ error: 'AI edit quota would be exceeded — upgrade plan or wait for reset' });
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return res.status(500).json({ error: 'AI not configured on this server' });

    const systemPrompt = 'You are a senior product designer + developer at a top design agency, building a polished single-page business website. ' +
      'Output ONLY a complete HTML document — no markdown, no explanation, no code fences, no comments outside <!-- HTML comments -->. ' +
      'STRUCTURE: <!DOCTYPE html>, <html lang="en">, <head> with <title>, <meta viewport>, <meta theme-color>, <meta description>, and Google Fonts <link> for ONE pair of fonts that fits the brand (e.g. Inter+Playfair, DM Sans+Fraunces, Manrope+Cormorant). ' +
      'CSS: All inline in one <style> block. Use CSS custom properties (--primary, --accent, --bg, --text, --muted) defined at :root. Use CSS grid + flexbox. Use clamp() for fluid type and spacing. Use modern features: aspect-ratio, gap, custom scrollbars where appropriate. NO outdated patterns (no floats, no !important except for utility overrides). ' +
      'DESIGN QUALITY: Strong visual hierarchy. Generous whitespace (padding clamp(48px, 8vw, 120px) on sections). Bold typography (heading sizes via clamp). One distinctive design choice that makes it memorable (e.g. asymmetric hero, oversized type, color-blocked sections, gradient mesh background, sticker-style badges, hand-drawn underlines via SVG). Avoid generic "bootstrap-y" looks. ' +
      'COLOR: Pick a palette that matches the business vibe — not always purple/blue. Spa/wellness = earthy greens/creams. Tech/SaaS = bold contrasts. Restaurant = warm reds/creams. Define 3-5 colors and use them consistently. ' +
      'SECTIONS — INCLUDE ALL: hero (with headline, subhead, primary CTA, hero visual placeholder via SVG/gradient), 3-icon trust bar / proof points, about/story (2 columns), services or features (3-card grid), social proof (testimonials with names + roles + star rating), pricing (2-3 tier cards with feature lists), FAQ (3-5 items via <details>), final CTA, footer (with nav + social links + business info). ' +
      'CONTENT: Write specific, believable copy — not "Lorem ipsum" and not generic "We offer the best service" platitudes. Use the business description to invent realistic product names, testimonial quotes, pricing tiers, and team bios. Testimonials should sound like real reviews (specific outcomes, conversational tone). Pricing should be plausible for the industry. ' +
      'INTERACTIVITY: For the shop or products section, do NOT hard-code product cards: output a single empty container <div data-mine-products></div> which MINE fills live from the product catalogue. Use data-mine-booking (on appointment CTAs), data-mine-course (on course/class items), data-mine-contact (on contact forms). For bookable services use data-mine-booking. MINE will hook into these. Include ONE smooth scroll-to-anchor behavior for nav links. ' +
      'ACCESSIBILITY: Semantic HTML (header/main/section/article/footer/nav). alt text on all images (use https://images.unsplash.com/photo-{random valid id} placeholder URLs for hero/section visuals). aria-labels on icon buttons. Sufficient color contrast (4.5:1 for body text). ' +
      'RESPONSIVE: Mobile-first. Test breakpoints in your head — does it look great at 375px? At 1440px? Grid columns collapse to 1 on mobile. ' +
      'Keep the entire output under 200KB. Aim for ~600 lines of HTML+CSS — substantial enough to feel complete, not bloated.';

    const userPrompt = 'Build a website for this business:\n\n' + prompt + '\n\n' +
      'Pick appropriate sections, copy and design based on what the business is. ' +
      'Use a color palette that fits the vibe described.';

    let aiHtml;
    try {
      const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': anthropicKey, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6', max_tokens: 8000,
          system: systemPrompt,
          messages: [{ role: 'user', content: (referenceImage ? [ { type: 'image', source: { type: 'base64', media_type: referenceImage.media_type, data: referenceImage.data } }, { type: 'text', text: 'Match the attached reference image\'s style exactly: its colour palette, typography mood, spacing and overall vibe. ' + (userPrompt) } ] : (userPrompt)) }]
        })
      });
      const aiData = await aiResp.json();
      if (!aiResp.ok || !aiData.content) {
        console.error('[/generate-from-prompt] AI error:', aiData?.error?.message || aiResp.status);
        return res.status(502).json({ error: 'AI generation failed — try again' });
      }
      aiHtml = (aiData.content[0]?.text || '').replace(/^```html?\s*\n?|```\s*$/g, '').trim();
      if (!aiHtml || aiHtml.length < 200) {
        return res.status(502).json({ error: 'AI returned empty/invalid HTML' });
      }
    } catch(e) {
      console.error('[/generate-from-prompt] fetch error:', e?.message || e);
      return res.status(502).json({ error: 'Could not reach AI service' });
    }

    const siteCount = db.prepare('SELECT COUNT(*) as c FROM sites WHERE user_id = ?').get(req.userId).c;
    // Change 16: PLAN_CAPS is the single source of truth (free/no-plan users: 1)
    const max = (user && user.plan) ? planCap(user.plan, "sites", 1) : 1;
    if (siteCount >= max) {
      if (String(user && user.plan).toLowerCase() === "agency") {
        // AGENCY ONLY: past-cap sites allowed, billed $3/site/mo on the agency invoice (agency.js cron). Ceiling 80 — TUNABLE.
        if (siteCount >= 80) return res.status(403).json({ error: "Site safety ceiling reached — contact support to raise it.", code: "SITE_CEILING" });
      } else return res.status(403).json({ error: 'Site limit reached for your plan', requiresUpgrade: true });
    }

    // Try to extract a sensible name from the prompt — first 6 words or so
    const words = prompt.trim().split(/\s+/).slice(0, 6).join(' ');
    const siteName = words.length > 30 ? words.slice(0, 30) : (words || 'My Site');
    const slug = siteName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 40) || 'my-site';
    const siteId = uuid();
    const siteOwner = db.prepare('SELECT agency_id FROM users WHERE id = ?').get(req.userId);
    const agencyId = siteOwner?.agency_id || null;

    db.prepare(`
      INSERT INTO sites (id, user_id, agency_id, name, template, html, domain, colors_json, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')
    `).run(siteId, req.userId, agencyId, siteName, 'ai-generated', aiHtml, slug + '.' + (process.env.MAIN_HOST || 'takeova.ai'),
           JSON.stringify({ primary: '#2563EB', secondary: '#7C3AED' }));

    try { db.prepare('UPDATE users SET ai_edits_used = COALESCE(ai_edits_used, 0) + 5 WHERE id = ?').run(req.userId); } catch(e) {}

    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
    try { if (global.mineTrackUsage) global.mineTrackUsage(db, req.userId, "sites"); } catch(e) {}
    res.json({ site, generatedFromPrompt: prompt.slice(0, 200) });
  } catch(e) {
    console.error('[/generate-from-prompt]', e?.message || e);
    if (!res.headersSent) res.status(500).json({ error: 'Generation failed — please try again' });
  }
});

// ─── UPDATE SITE ───
router.put("/:id", auth, (req, res) => {
  const db = getDb();
  const site = db.prepare("SELECT * FROM sites WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!site) return res.status(404).json({ error: "Site not found" });

  // Map incoming fields to correct DB column names
  const SITE_FIELD_MAP = {
    name:"name", html:"html", css:"css", status:"status",
    custom_domain:"custom_domain", customDomain:"custom_domain",
    logo:"logo", logo_url:"logo", favicon:"favicon", font:"font",
    colors_json:"colors_json", seo_json:"seo_json",
    seo_keywords:"seo_keywords", seo_title:"seo_title", seo_description:"seo_description",
    sections_json:"sections_json", settings_json:"settings_json",
    show_mine_badge:"show_mine_badge",
  };
  // Ensure sections_json column exists
  try { db.exec("ALTER TABLE sites ADD COLUMN sections_json TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE sites ADD COLUMN settings_json TEXT"); } catch(e) {}
  const fields = [];
  const vals = [];
  // Handle colors object -> colors_json
  if (req.body.colors && typeof req.body.colors === "object") {
    fields.push("colors_json = ?");
    vals.push(JSON.stringify(req.body.colors));
  }
  // Handle seo object -> seo_json
  if (req.body.seo && typeof req.body.seo === "object") {
    fields.push("seo_json = ?");
    vals.push(JSON.stringify(req.body.seo));
  }
  // Handle font object -> font column as JSON
  if (req.body.font && typeof req.body.font === "object") {
    fields.push("font = ?");
    vals.push(JSON.stringify(req.body.font));
  }
  for (const [k, v] of Object.entries(req.body)) {
    const col = SITE_FIELD_MAP[k];
    if (col && v !== undefined && typeof v !== "object") {
      fields.push(`${col} = ?`); vals.push(v);
    }
  }
  if (fields.length) {
    fields.push("updated_at = datetime('now')");
    vals.push(req.params.id);
    db.prepare(`UPDATE sites SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
  }

  // Persist sub-resource arrays sent as part of site update
  const SUB_MAP = {
    products: { table: "products", fields: ["name","description","price","stock","image_url","active","variants_json","stripe_price_id","stripe_product_id"] },
    courses: { table: "courses", fields: ["title","description","price","published","enrolled","modules_json","thumbnail","status"] },
    events: { table: "events", fields: ["title","date","time","location","description","ticket_types_json","cover_image","status","price"] },
    blog: { table: "blog_posts", fields: ["title","content","excerpt","tags_json","cover_image","status","published_at"] },
    forms: { table: "forms", fields: ["form_id","title","fields_json","settings_json","status","submit_text","success_msg"] },
    reviews: { table: "reviews", fields: ["reviewer_name","rating","text","source","verified"] },
    memberships: { table: "memberships", fields: ["name","price","interval","perks_json","active","stripe_price_id"] },
    invoices: { table: "invoices", fields: ["invoice_number","client_name","client_email","items_json","subtotal","tax","total","status","due_date","notes"] },
  };
  // Field alias map: frontend field name -> DB column name
  const FIELD_ALIASES = {
    desc: "description", image: "image_url", stock: "inventory",
    thumbnail: "image_url", modules: "modules_json", fields: "fields_json",
    settings: "settings_json", tags: "tags_json", perks: "perks_json",
    ticket_types: "ticket_types_json", time_slots: "time_slots_json",
    items: "items_json", variants: "variants_json", cover: "cover_image",
    number: "invoice_number", client: "client_name", email: "client_email",
    due: "due_date", author: "reviewer_name",
  };
  for (const [key, cfg] of Object.entries(SUB_MAP)) {
    if (!Array.isArray(req.body[key])) continue;
    db.prepare(`DELETE FROM ${cfg.table} WHERE site_id = ?`).run(req.params.id);
    for (const item of req.body[key]) {
      if (!item.id) continue;
      // SECURITY: if a row with this id already exists under a different site,
      // block the write. Otherwise INSERT OR REPLACE would let an attacker
      // pass a victim's product/course/event ID and have it silently moved
      // into the attacker's site (cross-tenant takeover / destruction).
      try {
        const existing = db.prepare(`SELECT site_id FROM ${cfg.table} WHERE id = ?`).get(item.id);
        if (existing && existing.site_id && existing.site_id !== req.params.id) continue;
      } catch(e) { /* table may not have site_id column in some versions — fall through */ }

      const resolvedFields = [];
      const resolvedVals = [];
      for (const f of cfg.fields) {
        // Check field name directly, then aliases
        const sourceKey = item[f] !== undefined ? f : Object.keys(FIELD_ALIASES).find(a => FIELD_ALIASES[a] === f && item[a] !== undefined);
        if (sourceKey === undefined) continue;
        const v = item[sourceKey];
        if (v === undefined || v === null) continue;
        resolvedFields.push(f);
        resolvedVals.push(typeof v === "object" ? JSON.stringify(v) : v);
      }
      if (!resolvedFields.length) continue;
      const cols = ["id","site_id","user_id",...resolvedFields];
      const vals = [item.id, req.params.id, req.userId, ...resolvedVals];
      try { db.prepare(`INSERT OR REPLACE INTO ${cfg.table} (${cols.join(",")}) VALUES (${cols.map(()=>"?").join(",")})`).run(...vals); } catch(e) { console.error("[/:id]", e.message || e); }
    }
  }

  // Persist misc site sub-resources as JSON in site_meta
  const META_KEYS = ["coupons","giftCards","shippingRates","pagePassword","popup","waitlist","display","theme","customPages","popupForm","loyalty","deployMethod","deployUrl","design","customerChatEnabled","bookingSettings","chatSettings","currency"];
  const metaUpdates = {};
  for (const k of META_KEYS) {
    if (req.body[k] !== undefined) metaUpdates[k] = req.body[k];
  }
  // Multi-currency — Pro and Enterprise only
  if (metaUpdates.currency && metaUpdates.currency !== "usd") {
    const userPlan = req.user?.plan || "starter";
    if (!["pro", "enterprise", "agency"].includes(userPlan)) {
      delete metaUpdates.currency;
      return res.status(403).json({ error: "Multi-currency requires Pro or Enterprise plan" });
    }
  }
  if (Object.keys(metaUpdates).length) {
    try {
      const existing = JSON.parse(db.prepare("SELECT site_meta FROM sites WHERE id = ?").get(req.params.id)?.site_meta || "{}");
      const merged = JSON.stringify({ ...existing, ...metaUpdates });
      db.prepare("UPDATE sites SET site_meta = ? WHERE id = ?").run(merged, req.params.id);
    } catch(e) { console.error("[/:id]", e.message || e); }
  }

  const updated = db.prepare("SELECT * FROM sites WHERE id = ?").get(req.params.id);
  res.json({ site: hydrateSite(db, updated) });
});

// ─── DELETE SITE ───
router.delete("/:id", auth, (req, res) => {
  const db = getDb();
  const site = db.prepare("SELECT * FROM sites WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!site) return res.status(404).json({ error: "Site not found" });
  // Cascade delete all sub-resources
  const tables = ["products","invoices","courses","events","bookings","blog_posts","forms","reviews","memberships","orders","form_submissions","abandoned_carts"];
  for (const t of tables) {
    try { db.prepare(`DELETE FROM ${t} WHERE site_id = ?`).run(req.params.id); } catch(e) { console.error("[/:id]", e.message || e); }
  }
  db.prepare("DELETE FROM sites WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// ─── DEPLOY (set status to live) ───
// Import the landing-page live preview as the user's first draft site (audit 2026-06-10)
router.post("/import-preview", auth, (req, res) => {
  try {
    const html = String((req.body && req.body.html) || "").slice(0, 80000);
    if (html.length < 200 || html.toLowerCase().indexOf("<html") < 0) return res.json({ success: false, error: "No preview to import" });
    const db = getDb();
    const { v4: _uuid } = require("uuid");
    const id = _uuid();
    const t = (html.match(/<title[^>]*>([^<]{1,60})/i) || [])[1] || "My first site";
    db.prepare("INSERT INTO sites (id, user_id, agency_id, name, template, category, html, domain, colors_json, status) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, null, t.trim(), "live-preview", "general", html, null, "{}", "draft");
    res.json({ site: { id, name: t.trim(), status: "draft" } });
  } catch (e) { console.error("[sites/import-preview]", e.message); res.status(500).json({ error: "An internal error occurred" }); }
});

// Duplicate a site as a new draft (audit 2026-06-10 UX pass)
router.post("/:id/duplicate", auth, (req, res) => {
  try {
    const db = getDb();
    const src = db.prepare("SELECT * FROM sites WHERE id=? AND user_id=?").get(req.params.id, req.userId);
    if (!src) return res.json({ success: false, error: "Site not found" });
    const { v4: _uuid } = require("uuid");
    const id = _uuid();
    db.prepare("INSERT INTO sites (id, user_id, agency_id, name, template, category, html, domain, colors_json, status) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, src.agency_id || null, (src.name || "Site") + " (copy)", src.template || null, src.category || null, src.html || "", null, src.colors_json || "{}", "draft");
    res.json({ site: { id, name: (src.name || "Site") + " (copy)", status: "draft" } });
  } catch (e) { console.error("[sites/duplicate]", e.message); res.status(500).json({ error: "An internal error occurred" }); }
});

router.post("/:id/deploy", auth, async (req, res) => {
  const db = getDb();
  const user = db.prepare("SELECT plan, two_fa_enabled FROM users WHERE id = ?").get(req.userId);
  if (!user.plan) return res.status(403).json({ error: "Subscribe to deploy", requiresUpgrade: true });
  if (!user.two_fa_enabled) return res.status(403).json({ error: "Enable 2FA before deploying", requires2FA: true });

  const site = db.prepare("SELECT * FROM sites WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!site) return res.status(404).json({ error: "Site not found" });

  // ── Compile Tailwind CSS before going live ──
  // Published sites should be fully static — no CDN dependency, no console
  // warning, faster first paint. Editor preview continues to use the CDN
  // for instant iteration; the compile only happens at publish time.
  // If compile fails, we fall back to the uncompiled HTML so a user's site
  // never gets stuck in "cannot publish" state due to a compiler issue.
  let publishHtml = site.html || "";
  let compileInfo = { compiled: false };
  try {
    const { compileTailwind, usesTailwindCdn } = require("../utils/tailwind-compile");
    if (usesTailwindCdn(publishHtml)) {
      const result = await compileTailwind(publishHtml, { timeoutMs: 15000 });
      if (result && result.html && !result.skipped) {
        publishHtml = result.html;
        compileInfo = {
          compiled: true,
          compiledSize: result.compiledSize,
          cached: result.cached,
        };
      } else if (result && result.skipped) {
        compileInfo = { compiled: false, reason: result.reason || "skipped" };
      }
    }
  } catch (compileErr) {
    console.error("[Deploy] Tailwind compile failed for site " + req.params.id + ":", compileErr.message);
    compileInfo = { compiled: false, error: compileErr.message };
    // Fall through — publish with the uncompiled HTML rather than blocking
  }

  db.prepare("UPDATE sites SET html = ?, status = 'live', updated_at = datetime('now') WHERE id = ?")
    .run(publishHtml, req.params.id);

  // ── Data Flywheel: log site_published event ──
  try {
    const { logEvent } = require("./intelligence");
    logEvent(db, req.userId, "site_published", {
      site_id: req.params.id,
      template: site.template || "",
      tw_compiled: compileInfo.compiled,
    });
  } catch(e) { /* non-critical */ }

  res.json({
    success: true,
    domain: site.custom_domain || site.domain,
    tailwind_compiled: compileInfo.compiled,
  });
});

// ─── GENERIC SUB-RESOURCE CRUD (products, invoices, courses, etc.) ───
const SUB_TABLES = {
  products: { table: "products", fields: ["name", "price", "description", "stock", "image_url", "active", "variants_json", "stripe_price_id", "stripe_product_id"] },
  invoices: { table: "invoices", fields: ["invoice_number", "client_name", "client_email", "items_json", "subtotal", "tax", "total", "status", "due_date", "notes"] },
  courses: { table: "courses", fields: ["title", "description", "price", "published", "enrolled", "modules_json", "thumbnail", "status"] },
  events: { table: "events", fields: ["title", "date", "time", "location", "description", "ticket_types_json", "cover_image", "status", "price"] },
  bookings: { table: "bookings", fields: ["service_id", "customer_name", "customer_email", "date", "time", "duration", "status", "notes"] },
  blog: { table: "blog_posts", fields: ["title", "content", "excerpt", "tags_json", "cover_image", "status", "published_at"] },
  forms: { table: "forms", fields: ["form_id","title","fields_json","settings_json","status","submit_text","success_msg"] },
  reviews: { table: "reviews", fields: ["reviewer_name", "rating", "text", "source", "verified"] },
  memberships: { table: "memberships", fields: ["name", "price", "interval", "perks_json", "active", "stripe_price_id"] },
};

for (const [resource, config] of Object.entries(SUB_TABLES)) {
  // LIST
  router.get(`/:siteId/${resource}`, auth, (req, res) => {
    const db = getDb();
    // Verify the requesting user owns this site
    const site = db.prepare("SELECT id FROM sites WHERE id = ? AND user_id = ?").get(req.params.siteId, req.userId);
    if (!site) return res.status(404).json({ error: "Site not found" });
    const items = db.prepare(`SELECT * FROM ${config.table} WHERE site_id = ? ORDER BY created_at DESC`).all(req.params.siteId);
    res.json({ [resource]: items });
  });

  // CREATE
  router.post(`/:siteId/${resource}`, auth, (req, res) => {
    const db = getDb();
    // Verify the requesting user owns this site
    const site = db.prepare("SELECT id FROM sites WHERE id = ? AND user_id = ?").get(req.params.siteId, req.userId);
    if (!site) return res.status(404).json({ error: "Site not found" });
    const id = uuid();
    const cols = ["id", "site_id", "user_id", ...config.fields.filter(f => req.body[f] !== undefined)];
    const vals = [id, req.params.siteId, req.userId, ...config.fields.filter(f => req.body[f] !== undefined).map(f => req.body[f])];
    const placeholders = cols.map(() => "?").join(", ");
    db.prepare(`INSERT INTO ${config.table} (${cols.join(", ")}) VALUES (${placeholders})`).run(...vals);
    const item = db.prepare(`SELECT * FROM ${config.table} WHERE id = ?`).get(id);
    // ── Intelligence: log resource creation events ──────────────────
    try {
      const { logEvent } = require("./intelligence");
      const eventMap = {
        products: "product_created",
        courses:  "course_created",
        bookings: "booking_created",
        reviews:  "review_received",
        contacts: "contact_added",
      };
      if (eventMap[resource]) {
        logEvent(db, req.userId, eventMap[resource], { id });
      }
    } catch(e) {}
    res.json({ [resource.replace(/s$/, "")]: item });
  });

  // UPDATE
  router.patch(`/:siteId/${resource}/:itemId`, auth, (req, res) => {
    const db = getDb();
    // Verify ownership through site
    const site = db.prepare("SELECT id FROM sites WHERE id = ? AND user_id = ?").get(req.params.siteId, req.userId);
    if (!site) return res.status(404).json({ error: "Site not found" });
    const fields = [];
    const vals = [];
    for (const f of config.fields) {
      if (req.body[f] !== undefined) { fields.push(`${f} = ?`); vals.push(req.body[f]); }
    }
    if (!fields.length) return res.status(400).json({ error: "Nothing to update" });
    vals.push(req.params.itemId, req.params.siteId);
    db.prepare(`UPDATE ${config.table} SET ${fields.join(", ")} WHERE id = ? AND site_id = ?`).run(...vals);
    const item = db.prepare(`SELECT * FROM ${config.table} WHERE id = ?`).get(req.params.itemId);
    res.json({ [resource.replace(/s$/, "")]: item });
  });

  // DELETE
  router.delete(`/:siteId/${resource}/:itemId`, auth, (req, res) => {
    const db = getDb();
    // Verify ownership through site before deleting
    const site = db.prepare("SELECT id FROM sites WHERE id = ? AND user_id = ?").get(req.params.siteId, req.userId);
    if (!site) return res.status(404).json({ error: "Site not found" });
    db.prepare(`DELETE FROM ${config.table} WHERE id = ? AND site_id = ?`).run(req.params.itemId, req.params.siteId);
    res.json({ success: true });
  });
}

function hydrateSite(db, site) {
  if (!site) return null;
  // Parse site_meta for misc sub-resources (coupons, giftCards, shippingRates, etc.)
  let meta = {};
  try { meta = JSON.parse(site.site_meta || "{}"); } catch(e) {}
  // Parse colors_json
  let colors = { primary: "#2563EB", secondary: "#7C3AED" };
  try { colors = JSON.parse(site.colors_json || "{}") || colors; } catch(e) {}
  // Parse seo_json
  let seo = {};
  try { seo = JSON.parse(site.seo_json || "{}"); } catch(e) {}
  // Parse font (can be string name or JSON object)
  let font = {};
  try { font = site.font ? (site.font.startsWith("{") ? JSON.parse(site.font) : {heading: site.font, body: site.font}) : {}; } catch(e) {}
  return {
    ...site,
    colors,
    seo,
    font,
    seo_title: site.seo_title || "",
    seo_description: site.seo_description || "",
    seo_keywords: site.seo_keywords || "",
    ...meta,
    products: db.prepare("SELECT * FROM products WHERE site_id = ? ORDER BY created_at DESC LIMIT 500").all(site.id),
    orders: db.prepare("SELECT * FROM orders WHERE site_id = ? ORDER BY created_at DESC LIMIT 500").all(site.id),
    invoices: db.prepare("SELECT * FROM invoices WHERE site_id = ? ORDER BY created_at DESC LIMIT 500").all(site.id),
    courses: db.prepare("SELECT * FROM courses WHERE site_id = ? LIMIT 200").all(site.id),
    events: (function() { try { const evts = db.prepare("SELECT * FROM events WHERE site_id = ? ORDER BY COALESCE(start_date, date) ASC LIMIT 200").all(site.id); return evts.map(e => { const tickets = (() => { try { return db.prepare("SELECT * FROM event_tickets WHERE event_id = ?").all(e.id); } catch(ex) { return []; } })(); return {...e, ticketTypes: tickets, tickets}; }); } catch(ex2) { return []; } })(),
    bookings: db.prepare("SELECT * FROM bookings WHERE site_id = ? ORDER BY created_at DESC LIMIT 500").all(site.id),
    blog: db.prepare("SELECT * FROM blog_posts WHERE site_id = ? ORDER BY created_at DESC LIMIT 200").all(site.id),
    forms: db.prepare("SELECT * FROM forms WHERE site_id = ? LIMIT 100").all(site.id),
    reviews: db.prepare("SELECT * FROM reviews WHERE site_id = ? ORDER BY created_at DESC LIMIT 200").all(site.id),
    memberships: (function() { try { return db.prepare("SELECT * FROM membership_tiers WHERE site_id = ? ORDER BY created_at DESC").all(site.id).map(t => ({...t, perks: (() => { try { return JSON.parse(t.perks||"[]"); } catch(e) { return []; } })()} )); } catch(e) { return db.prepare("SELECT * FROM memberships WHERE site_id = ?").all(site.id); } })(),
  };
}

// Verify custom domain CNAME is pointing correctly
router.get("/:id/verify-domain", auth, async (req, res) => {
  const db = getDb();
  const site = db.prepare("SELECT * FROM sites WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!site) return res.status(404).json({ error: "Site not found" });
  if (!site.custom_domain) return res.json({ verified: false, message: "No custom domain configured" });

  try {
    const dns = require("dns").promises;
    const domain = site.custom_domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const expectedTarget = process.env.MINE_DOMAIN || "takeova.ai";

    const records = await dns.resolveCname(domain).catch(() => []);
    const verified = records.some(r => r.includes(expectedTarget) || r.includes("mine"));

    if (verified) {
      db.prepare("UPDATE sites SET settings_json = json_set(COALESCE(settings_json,'{}'), '$.domain_verified', 1) WHERE id = ?").run(site.id);
    }

    res.json({
      verified,
      domain,
      cnameFound: records[0] || null,
      message: verified
        ? "✓ Domain verified — your custom domain is active"
        : records.length > 0
          ? `CNAME points to ${records[0]} — expected a takeova.ai address. Check your DNS settings.`
          : "No CNAME record found. Add a CNAME record pointing to your takeova.ai domain.",
      instructions: {
        type: "CNAME",
        name: domain,
        value: site.domain || (site.id + ".takeova.ai"),
        ttl: "3600"
      }
    });
  } catch(e) {
    res.json({ verified: false, message: "Could not check DNS: " + e.message });
  }
});


module.exports = router;

// ─── PUBLIC BLOG ROUTES — no auth required, served to site visitors ───────────

const esc = (s) => String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

function blogShell(siteName, title, bodyHtml, canonical = "") {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ${esc(siteName)}</title>
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ""}
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;color:#1a1a1a;background:#fff;line-height:1.6}
  .top-bar{background:#fff;border-bottom:1px solid #eee;padding:0 24px;display:flex;align-items:center;justify-content:space-between;height:56px;position:sticky;top:0;z-index:100}
  .top-bar a{text-decoration:none;color:#2563EB;font-weight:700;font-size:18px}
  .top-bar nav a{color:#444;font-size:14px;margin-left:16px;text-decoration:none}
  .top-bar nav a:hover{color:#2563EB}
  .container{max-width:720px;margin:0 auto;padding:40px 24px 80px}
  h1{font-size:2rem;font-weight:800;line-height:1.25;margin-bottom:16px}
  h2{font-size:1.3rem;font-weight:700;margin:32px 0 12px}
  p{margin-bottom:16px;color:#333}
  .meta{color:#888;font-size:13px;margin-bottom:32px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  .tag{background:#F0EDFF;color:#2563EB;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600}
  .card{border:1px solid #eee;border-radius:12px;padding:24px;margin-bottom:20px;text-decoration:none;display:block;color:inherit;transition:box-shadow .15s}
  .card:hover{box-shadow:0 4px 20px rgba(0,0,0,.08)}
  .card h2{margin:0 0 8px;font-size:1.1rem}
  .card p{color:#666;font-size:14px;margin:0 0 12px}
  .card .meta{margin:0}
  .cover{width:100%;max-height:360px;object-fit:cover;border-radius:12px;margin-bottom:32px}
  .back{display:inline-block;color:#2563EB;text-decoration:none;font-size:14px;margin-bottom:28px}
  .back:hover{text-decoration:underline}
  .content h2{margin-top:28px}
  .content p{margin-bottom:18px}
  .empty{text-align:center;padding:64px 24px;color:#888}
  .empty h2{color:#1a1a1a;margin-bottom:8px}
</style>
</head><body>
<div class="top-bar">
  <a href="/">${esc(siteName)}</a>
  <nav><a href="/">Home</a><a href="/blog">Blog</a></nav>
</div>
${bodyHtml}
</body></html>`;
}

// Blog index — list all published posts for a site by domain
const blogRouter = require("express").Router();

blogRouter.get("/blog", (req, res) => {
  const db = getDb();
  const domain = req.hostname;
  const site = db.prepare("SELECT * FROM sites WHERE (domain = ? OR custom_domain = ?) AND status = 'live'").get(domain, domain);
  if (!site) return res.status(404).send("<h1>Blog not found</h1>");

  const posts = db.prepare("SELECT * FROM blog_posts WHERE site_id = ? AND status = 'published' ORDER BY created_at DESC").all(site.id);

  const cards = posts.length === 0
    ? `<div class="empty"><h2>No posts yet</h2><p>Check back soon!</p></div>`
    : posts.map(p => {
        const tags = (() => { try { return JSON.parse(p.tags_json || "[]"); } catch(e) { return []; } })();
        const slug = p.slug || p.id;
        const date = p.created_at ? new Date(p.created_at).toLocaleDateString("en-US", { year:"numeric", month:"long", day:"numeric" }) : "";
        return `<a class="card" href="/blog/${esc(slug)}">
          ${p.cover_image ? `<img src="${esc(p.cover_image)}" style="width:100%;max-height:200px;object-fit:cover;border-radius:8px;margin-bottom:12px" alt="">` : ""}
          <h2>${esc(p.title)}</h2>
          <p>${esc(p.excerpt || (p.content || "").slice(0, 160))}...</p>
          <div class="meta">
            ${date ? `<span>${esc(date)}</span>` : ""}
            ${tags.slice(0, 3).map(t => `<span class="tag">${esc(t)}</span>`).join("")}
          </div>
        </a>`;
      }).join("");

  res.send(blogShell(site.name, "Blog", `<div class="container"><h1>Blog</h1>${cards}</div>`));
});

// Single post — by slug or id
blogRouter.get("/blog/:slug", (req, res) => {
  const db = getDb();
  const domain = req.hostname;
  const site = db.prepare("SELECT * FROM sites WHERE (domain = ? OR custom_domain = ?) AND status = 'live'").get(domain, domain);
  if (!site) return res.status(404).send("<h1>Not found</h1>");

  const slug = req.params.slug;
  const post = db.prepare("SELECT * FROM blog_posts WHERE site_id = ? AND (slug = ? OR id = ?) AND status = 'published'").get(site.id, slug, slug);
  if (!post) return res.status(404).send(blogShell(site.name, "Post not found", `<div class="container"><a class="back" href="/blog">← Back to blog</a><div class="empty"><h2>Post not found</h2></div></div>`));

  const tags = (() => { try { return JSON.parse(post.tags_json || "[]"); } catch(e) { return []; } })();
  const date = post.created_at ? new Date(post.created_at).toLocaleDateString("en-US", { year:"numeric", month:"long", day:"numeric" }) : "";

  // Convert markdown-style content to basic HTML paragraphs + h2s
  const contentHtml = (post.content || "")
    .split("\n\n")
    .map(block => {
      if (block.startsWith("## ")) return `<h2>${esc(block.slice(3))}</h2>`;
      if (block.startsWith("# ")) return `<h2>${esc(block.slice(2))}</h2>`;
      return `<p>${esc(block)}</p>`;
    })
    .join("\n");

  const body = `<div class="container">
    <a class="back" href="/blog">← Back to blog</a>
    ${post.cover_image ? `<img class="cover" src="${esc(post.cover_image)}" alt="${esc(post.title)}">` : ""}
    <h1>${esc(post.title)}</h1>
    <div class="meta">
      ${date ? `<span>${esc(date)}</span>` : ""}
      ${tags.map(t => `<span class="tag">${esc(t)}</span>`).join("")}
    </div>
    <div class="content">${contentHtml}</div>
  </div>`;

  // Increment view count
  try { db.prepare("UPDATE blog_posts SET views = COALESCE(views,0) + 1 WHERE id = ?").run(post.id); } catch(e) { console.error("[/:id/verify-domain]", e.message || e); }

  res.send(blogShell(site.name, post.title, body, `https://${domain}/blog/${esc(slug)}`));
});

module.exports.blogRouter = blogRouter;

// ─────────────────────────────────────────────────────────────────
// SITE VERSION HISTORY
// POST /api/sites/:id/versions  — save a snapshot
// GET  /api/sites/:id/versions  — list versions (last 50)
// POST /api/sites/:id/versions/:vid/restore — restore a version
// ─────────────────────────────────────────────────────────────────
const { v4: vidUuid } = require("uuid");

function ensureVersionsTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS site_versions (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    html TEXT NOT NULL,
    label TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
}

router.post("/:id/versions", auth, (req, res) => {
  const db = getDb();
  const site = db.prepare("SELECT id, user_id FROM sites WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!site) return res.status(404).json({ error: "Site not found" });
  const { html, label } = req.body;
  if (!html) return res.status(400).json({ error: "html required" });
  ensureVersionsTable(db);
  const vid = vidUuid();
  db.prepare("INSERT INTO site_versions (id, site_id, user_id, html, label) VALUES (?,?,?,?,?)")
    .run(vid, site.id, req.userId, html, label || new Date().toISOString().slice(0,16).replace("T"," "));
  // Keep only last 50 versions
  const old = db.prepare("SELECT id FROM site_versions WHERE site_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET 50").all(site.id);
  if (old.length) db.prepare("DELETE FROM site_versions WHERE id IN (" + old.map(()=>"?").join(",") + ")").run(...old.map(o=>o.id));
  res.json({ id: vid, label });
});

router.get("/:id/versions", auth, (req, res) => {
  const db = getDb();
  const site = db.prepare("SELECT id FROM sites WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!site) return res.status(404).json({ error: "Site not found" });
  ensureVersionsTable(db);
  const versions = db.prepare("SELECT id, label, created_at FROM site_versions WHERE site_id = ? ORDER BY created_at DESC LIMIT 50").all(site.id);
  res.json({ versions });
});

router.post("/:id/versions/:vid/restore", auth, async (req, res) => {
  const db = getDb();
  const site = db.prepare("SELECT * FROM sites WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!site) return res.status(404).json({ error: "Site not found" });
  ensureVersionsTable(db);
  const version = db.prepare("SELECT * FROM site_versions WHERE id = ? AND site_id = ?").get(req.params.vid, site.id);
  if (!version) return res.status(404).json({ error: "Version not found" });
  // Save current as a version before restoring
  db.prepare("INSERT INTO site_versions (id, site_id, user_id, html, label) VALUES (?,?,?,?,?)")
    .run(vidUuid(), site.id, req.userId, site.html || "", "Auto-save before restore");
  // Restore
  db.prepare("UPDATE sites SET html = ?, updated_at = datetime('now') WHERE id = ?").run(version.html, site.id);
  res.json({ success: true, html: version.html });
});

// ═══════════════════════════════════════════════════════════════════
// USER RESCUE ENDPOINTS
// ═══════════════════════════════════════════════════════════════════
// Three features that close the "user is stuck, what now?" gap:
//   1. Undo — one-tap restore of previous version (wired above + auto-save
//      on every AI edit in ai-agent.js /build endpoint)
//   2. Report a problem — user submits an issue, we bundle their context
//      and email it to support so we can actually help them
//   3. Health check — scans the site for common issues before publish
//      (broken links, missing images, bad form targets, etc.)
// ═══════════════════════════════════════════════════════════════════

// ─── UNDO LAST AI EDIT — convenience wrapper over /versions/:vid/restore ───
// Restores the most recent auto-saved version (the state BEFORE the last
// AI edit). Single-click undo for the user.
router.post("/:id/undo", auth, (req, res) => {
  const db = getDb();
  const site = db.prepare("SELECT * FROM sites WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!site) return res.status(404).json({ error: "Site not found" });
  ensureVersionsTable(db);
  // Most recent version is the one saved immediately BEFORE the current state
  const latest = db.prepare(
    "SELECT * FROM site_versions WHERE site_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(site.id);
  if (!latest) return res.status(404).json({ error: "No previous version to undo to. Make an edit first." });
  // Save current as a "redo" candidate before reverting
  db.prepare("INSERT INTO site_versions (id, site_id, user_id, html, label) VALUES (?,?,?,?,?)")
    .run(vidUuid(), site.id, req.userId, site.html || "", "Redo: after undo");
  db.prepare("UPDATE sites SET html = ?, updated_at = datetime('now') WHERE id = ?").run(latest.html, site.id);
  res.json({ success: true, restoredFrom: latest.label, html: latest.html });
});

// ─── REPORT A PROBLEM ─────────────────────────────────────────────
// User taps "Something broken?" in editor → describes issue → we bundle
// their site state + recent AI prompts + browser info + their recent
// server errors, save to DB, and email support.
function ensureIssueReportsTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS issue_reports (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    site_id TEXT,
    description TEXT NOT NULL,
    recent_prompts TEXT,
    browser_info TEXT,
    html_snapshot TEXT,
    status TEXT DEFAULT 'new',
    resolved_at TEXT,
    admin_notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_issue_reports_user ON issue_reports(user_id, created_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_issue_reports_status ON issue_reports(status, created_at DESC)");
}

router.post("/:id/report-issue", auth, async (req, res) => {
  const db = getDb();
  ensureIssueReportsTable(db);
  const site = db.prepare("SELECT id, name, html FROM sites WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!site) return res.status(404).json({ error: "Site not found" });

  const { description, recentPrompts, browserInfo } = req.body || {};
  if (!description || String(description).trim().length < 5) {
    return res.status(400).json({ error: "Please describe what's wrong (at least a few words)." });
  }

  const reportId = vidUuid();
  try {
    db.prepare(`INSERT INTO issue_reports
      (id, user_id, site_id, description, recent_prompts, browser_info, html_snapshot)
      VALUES (?,?,?,?,?,?,?)`).run(
      reportId,
      req.userId,
      site.id,
      String(description).slice(0, 2000),
      JSON.stringify((recentPrompts || []).slice(0, 10)).slice(0, 4000),
      JSON.stringify(browserInfo || {}).slice(0, 1000),
      (site.html || "").slice(0, 500000) // cap at 500KB
    );
  } catch (e) {
    console.error("[/report-issue] save failed:", e.message);
    return res.status(500).json({ error: "Could not save your report. Please try again." });
  }

  // Email support (non-blocking — if it fails, report is still saved in DB)
  try {
    const sgKey = db.prepare("SELECT value FROM platform_settings WHERE key = 'SENDGRID_API_KEY'").get()?.value
      || process.env.SENDGRID_API_KEY;
    const supportEmail = process.env.ADMIN_EMAIL || process.env.SUPPORT_EMAIL;
    const fromEmail = process.env.EMAIL_FROM || "hello@takeova.ai";

    if (sgKey && supportEmail) {
      const user = db.prepare("SELECT email, name, plan FROM users WHERE id = ?").get(req.userId);
      const fetch = (await import("node-fetch")).default;
      const esc = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const body = `
        <div style="font-family:system-ui;max-width:640px;margin:0 auto;padding:24px">
          <h2 style="color:#DC2626">🚨 User issue report</h2>
          <p><strong>User:</strong> ${esc(user?.name)} (${esc(user?.email)}) · Plan: ${esc(user?.plan || 'unknown')}</p>
          <p><strong>Site:</strong> ${esc(site.name || site.id)}</p>
          <p><strong>Report ID:</strong> <code>${reportId}</code></p>
          <hr>
          <p><strong>Description:</strong></p>
          <div style="background:#f8fafc;padding:12px;border-radius:8px;white-space:pre-wrap">${esc(description)}</div>
          ${Array.isArray(recentPrompts) && recentPrompts.length ? `
            <p><strong>Recent AI prompts:</strong></p>
            <ul style="background:#f8fafc;padding:12px 12px 12px 32px;border-radius:8px;margin:0">
              ${recentPrompts.slice(0, 5).map(p => `<li style="margin-bottom:6px">${esc(p)}</li>`).join('')}
            </ul>
          ` : ''}
          <p style="margin-top:20px;color:#64748b;font-size:13px">
            Full site HTML saved in the <code>issue_reports</code> table.
            Reply directly to this user at <a href="mailto:${esc(user?.email)}">${esc(user?.email)}</a>.
          </p>
        </div>`;
      const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { Authorization: "Bearer " + sgKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: supportEmail }] }],
          from: { email: fromEmail, name: "MINE Support" },
          reply_to: user?.email ? { email: user.email } : undefined,
          subject: `[MINE issue] ${user?.email || 'user'} — ${String(description).slice(0, 60)}`,
          content: [{ type: "text/html", value: body }]
        })
      });
      if (!_sgResp.ok) {
        let errBody = ""; try { errBody = (await _sgResp.text()).slice(0, 300); } catch(_) {}
        console.error(`[/report-issue] SendGrid ${_sgResp.status}: ${errBody}`);
      }
    }
  } catch (emailErr) {
    console.error("[/report-issue] email send error:", emailErr.message);
  }

  res.json({
    success: true,
    reportId,
    message: "Thanks — we've got it and a human will be in touch within 1 business day."
  });
});

// ─── HEALTH CHECK — scans site for common issues before publish ─────
// Returns a list of { severity, area, message, fix } objects so the editor
// UI can show a pre-publish checklist. Severities: 'error' (blocks publish),
// 'warning' (publish with caution), 'info' (suggestions).
router.get("/:id/health-check", auth, (req, res) => {
  const db = getDb();
  const site = db.prepare("SELECT * FROM sites WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!site) return res.status(404).json({ error: "Site not found" });
  const html = site.html || "";
  const issues = [];
  const add = (severity, area, message, fix) => issues.push({ severity, area, message, fix });

  // 1. No HTML at all
  if (!html || html.length < 500) {
    add("error", "content", "Site has no content yet", "Go to the editor and build your site first.");
    return res.json({ issues, canPublish: false });
  }

  // 2. Missing core sections
  if (!/<nav[\s>]/i.test(html)) add("warning", "structure", "No navigation found", "Ask AI to add a sticky nav with your main links.");
  if (!/<footer[\s>]/i.test(html)) add("warning", "structure", "No footer found", "Ask AI to add a footer with contact info.");
  if (!/<h1[\s>]/i.test(html)) add("error", "seo", "Missing H1 heading", "SEO needs exactly one H1. Ask AI to add a main headline.");

  // 3. Placeholder text still present
  const placeholders = ["lorem ipsum", "your business name", "your-email@", "example.com", "placeholder", "coming soon", "TODO", "xxx", "business name here"];
  for (const p of placeholders) {
    if (html.toLowerCase().includes(p.toLowerCase())) {
      add("error", "content", `Placeholder text still visible: "${p}"`, `Search the editor for "${p}" and replace with your real info.`);
      break; // one is enough
    }
  }

  // 4. Broken/missing image sources
  const imgMatches = html.match(/<img[^>]*>/gi) || [];
  let brokenImgs = 0, noAlt = 0;
  for (const img of imgMatches) {
    const src = (img.match(/src=["']([^"']+)["']/) || [])[1];
    if (!src || src === "" || src.startsWith("#") || src.includes("placeholder")) brokenImgs++;
    if (!/\balt=/i.test(img)) noAlt++;
  }
  if (brokenImgs > 0) add("error", "images", `${brokenImgs} image(s) have no source`, "Upload real images or ask AI to replace them with Unsplash alternatives.");
  if (noAlt > 0) add("info", "accessibility", `${noAlt} image(s) missing alt text`, "Alt text helps screen readers and SEO.");

  // 5. Forms without submission targets
  const formMatches = html.match(/<form\b[^>]*>/gi) || [];
  for (const form of formMatches) {
    const action = (form.match(/action=["']([^"']+)["']/) || [])[1];
    if (!action || action === "#" || action === "") {
      add("error", "forms", "Contact/signup form doesn't submit anywhere", "Connect the form to an email or integration in settings.");
      break;
    }
  }

  // 6. Email / phone / address check
  if (/(contact|footer)/i.test(html)) {
    const hasEmail = /[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(html);
    const hasPhone = /(\+?\d[\d\s\-()]{7,}\d)/.test(html);
    if (!hasEmail && !hasPhone) {
      add("warning", "contact", "No contact email or phone visible anywhere on your site", "Customers need a way to reach you.");
    }
  }

  // 7. Broken internal anchors
  const anchorLinks = [...html.matchAll(/href=["']#([^"'\s]+)["']/g)].map(m => m[1]);
  const ids = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map(m => m[1]);
  const missingAnchors = anchorLinks.filter(a => a !== "" && a !== "top" && !ids.includes(a));
  if (missingAnchors.length) {
    add("warning", "navigation", `Nav links point to sections that don't exist: ${[...new Set(missingAnchors)].slice(0, 3).join(", ")}`, "Ask AI to fix the link targets or add the missing sections.");
  }

  // 8. Pricing with no actual price
  if (/pricing|subscribe|buy now|get started/i.test(html)) {
    if (!/\$\s?\d|\€\s?\d|\£\s?\d|\bfree\b/i.test(html)) {
      add("info", "commerce", "Pricing section mentioned but no $ price visible", "If you sell something, show the price clearly.");
    }
  }

  // 9. Analytics / tracking not set up (info only)
  if (!/gtag|googletagmanager|meta.*pixel|plausible|fathom/i.test(html)) {
    add("info", "analytics", "No analytics tracking installed", "You won't know how many people visit your site. Enable analytics in Settings.");
  }

  // 10. Huge HTML (>500KB) — performance warning
  if (html.length > 500000) {
    add("warning", "performance", `Site is ${Math.round(html.length/1024)}KB — larger than ideal`, "Large pages load slowly. Consider splitting into multiple pages.");
  }

  // 11. Missing meta title / description
  if (!/<title>[^<]{5,}<\/title>/i.test(html)) {
    add("warning", "seo", "Missing page title", "SEO needs a <title> tag. Ask AI to add one.");
  }
  if (!/<meta[^>]+name=["']description["'][^>]+content=["'][^"']{20,}/i.test(html)) {
    add("info", "seo", "Missing meta description", "Google uses this in search results. Ask AI to add one.");
  }

  // 12. No viewport meta (mobile responsiveness)
  if (!/<meta[^>]+name=["']viewport["']/i.test(html)) {
    add("error", "mobile", "No viewport meta tag — site will look broken on mobile", "Ask AI to add a proper viewport tag.");
  }

  // Score summary
  const errors = issues.filter(i => i.severity === "error").length;
  const warnings = issues.filter(i => i.severity === "warning").length;
  const infos = issues.filter(i => i.severity === "info").length;
  const canPublish = errors === 0;

  res.json({
    issues,
    summary: { errors, warnings, info: infos, total: issues.length },
    canPublish,
    message: canPublish
      ? (issues.length === 0 ? "✅ Your site looks great — ready to publish!" : `You can publish, but ${warnings + infos} thing${(warnings + infos) === 1 ? '' : 's'} could be better.`)
      : `❌ ${errors} issue${errors === 1 ? '' : 's'} must be fixed before publishing.`
  });
});

