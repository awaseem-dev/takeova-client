// AI Tools — real handlers for the dashboard "Run a tool" actions.
// Each generates content via Claude and SAVES it to the table its panel reads,
// so the result actually appears (blog/email/social/services/site/insights).
// Honest 503 when ANTHROPIC_API_KEY is absent. Mounted at /api/ai-tools.
const express = require("express");
const router = express.Router();
const { v4: uuid } = require("uuid");

function getDb() { return require("../db/init").getDb(); }
function auth(req, res, next) { const m = require("../middleware/auth"); m.auth(req, res, next); }
function getSetting(k) { try { return getDb().prepare("SELECT value FROM platform_settings WHERE key = ?").get(k)?.value || ""; } catch { return ""; } }
function apiKey() { return getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY; }

async function ai(system, user, maxTokens) {
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: apiKey() });
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens || 2000,
    system,
    messages: [{ role: "user", content: user }],
  });
  return ((msg.content && msg.content[0] && msg.content[0].text) || "").trim();
}
function parseJson(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(t); } catch (_) {}
  const m = t.match(/[\[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  return null;
}
function firstSite(db, userId) {
  try { return db.prepare("SELECT * FROM sites WHERE user_id = ? ORDER BY rowid DESC LIMIT 1").get(userId) || null; } catch (_) { return null; }
}
const guard = (res) => res.status(503).json({ error: "AI not configured — add ANTHROPIC_API_KEY" });

// 1) Blog post -> blog_posts (draft)
router.post("/blog-post/run", auth, async (req, res) => {
  if (!apiKey()) return guard(res);
  try {
    const b = req.body || {};
    const sys = "You are an expert content writer. Return ONLY valid JSON, no markdown fences, no commentary, shaped {\"title\":\"...\",\"excerpt\":\"...\",\"content\":\"<full post as clean HTML using <h2>/<p>/<ul>>\"}.";
    const user = `Write a blog post.\nTopic: ${b.topic || "general business update"}\nWord count: ${b.word_count || 800}\nTone: ${b.tone || "professional"}\nSEO keywords: ${b.keywords || "(suggest appropriate ones)"}`;
    const out = await ai(sys, user, 4000);
    const j = parseJson(out) || { title: (b.topic || "Untitled post").slice(0, 120), excerpt: "", content: "<p>" + out.replace(/\n/g, "<br>") + "</p>" };
    const db = getDb(); const site = firstSite(db, req.userId);
    const id = uuid();
    const slug = String(j.title || "post").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
    db.prepare("INSERT INTO blog_posts (id, site_id, user_id, title, slug, content, excerpt, tags_json, status) VALUES (?,?,?,?,?,?,?,?, 'draft')")
      .run(id, site ? site.id : null, req.userId, j.title || "Untitled post", slug, j.content || "", j.excerpt || "", JSON.stringify(b.keywords ? String(b.keywords).split(",").map(s => s.trim()) : []));
    return res.json({ ok: true, success: true, id, title: j.title });
  } catch (e) { console.error("[ai-tools/blog-post]", e.message); return res.status(502).json({ error: "Generation failed: " + e.message }); }
});

// 2) Email campaign -> email_campaigns (draft)
router.post("/email-campaign/run", auth, async (req, res) => {
  if (!apiKey()) return guard(res);
  try {
    const b = req.body || {};
    const n = Math.max(1, Math.min(parseInt(b.email_count) || 1, 7));
    const sys = "You are an expert email marketer. Return ONLY valid JSON, no markdown, shaped {\"name\":\"...\",\"subject\":\"...\",\"body\":\"<email as clean HTML>\"}. If multiple emails are requested, combine the sequence into one body separated by <hr> with each email's subject as an <h3>.";
    const user = `Write an email campaign.\nObjective: ${b.objective || "engage customers"}\nAudience: ${b.audience || "all subscribers"}\nEmails in sequence: ${n}\nTone: ${b.tone || "warm"}`;
    const out = await ai(sys, user, 4000);
    const j = parseJson(out) || { name: (b.objective || "Campaign").slice(0, 120), subject: (b.objective || "Hello"), body: "<p>" + out.replace(/\n/g, "<br>") + "</p>" };
    const db = getDb(); const id = uuid();
    try { db.exec("CREATE TABLE IF NOT EXISTS email_campaigns (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, subject TEXT, body TEXT, segment TEXT, status TEXT DEFAULT 'draft', sent_at TEXT, opens INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))"); } catch (_) {}
    db.prepare("INSERT INTO email_campaigns (id, user_id, name, subject, body, segment, status) VALUES (?,?,?,?,?,?, 'draft')")
      .run(id, req.userId, j.name || b.objective || "Campaign", j.subject || "", j.body || "", b.audience || "all");
    return res.json({ ok: true, success: true, id, subject: j.subject });
  } catch (e) { console.error("[ai-tools/email-campaign]", e.message); return res.status(502).json({ error: "Generation failed: " + e.message }); }
});

// 3) Social captions -> social_posts (drafts)
router.post("/social-captions/run", auth, async (req, res) => {
  if (!apiKey()) return guard(res);
  try {
    const b = req.body || {};
    const count = Math.max(1, Math.min(parseInt(b.count) || 5, 20));
    const platform = b.platform || "instagram";
    const sys = "You are a social media copywriter. Return ONLY a valid JSON array of caption strings, no markdown, no commentary.";
    const user = `Write ${count} ${b.tone || "engaging"} social media captions for ${platform}.\nTopic: ${b.topic || "our business"}\nInclude relevant hashtags where appropriate.`;
    const out = await ai(sys, user, 2000);
    let arr = parseJson(out);
    if (!Array.isArray(arr)) arr = String(out).split(/\n{2,}/).map(s => s.trim()).filter(Boolean).slice(0, count);
    const db = getDb(); let created = 0;
    const stmt = db.prepare("INSERT INTO social_posts (id, user_id, text, platforms, status) VALUES (?,?,?,?, 'draft')");
    for (const cap of arr) { if (cap && String(cap).trim()) { stmt.run(uuid(), req.userId, String(cap).trim(), platform); created++; } }
    return res.json({ ok: true, success: true, created });
  } catch (e) { console.error("[ai-tools/social-captions]", e.message); return res.status(502).json({ error: "Generation failed: " + e.message }); }
});

// 4) Homepage copy -> rewrite hero in sites.html
router.post("/homepage-copy/run", auth, async (req, res) => {
  if (!apiKey()) return guard(res);
  try {
    const db = getDb(); const site = firstSite(db, req.userId);
    if (!site || !site.html || site.html.length < 30) return res.json({ ok: true, success: true, note: "No site to update yet — build a site first" });
    const { JSDOM } = require("jsdom");
    const dom = new JSDOM(site.html); const doc = dom.window.document;
    const h1 = doc.querySelector("h1");
    if (!h1) return res.json({ ok: true, success: true, note: "No headline found to rewrite" });
    const hero = h1.closest("section, header, div") || h1.parentElement;
    const subEl = hero ? hero.querySelector("p") : null;
    const ctaEl = hero ? hero.querySelector("a.btn, a[class*='bg-'], a[class*='button'], a[href='#book'], a[href*='contact']") : null;
    const cur = { headline: h1.textContent.trim(), subhead: subEl ? subEl.textContent.trim() : "", cta: ctaEl ? ctaEl.textContent.trim() : "" };
    const sys = "You are a conversion copywriter. Return ONLY valid JSON, no markdown, shaped {\"headline\":\"...\",\"subhead\":\"...\",\"cta\":\"...\"}. Keep the CTA to 2-4 words. Match the business implied by the current copy.";
    const out = await ai(sys, "Rewrite this website hero to be more compelling and clear.\nCurrent:\n" + JSON.stringify(cur), 800);
    const j = parseJson(out);
    if (!j || !j.headline) return res.json({ ok: true, success: true, note: "Could not generate copy — try again" });
    h1.textContent = j.headline;
    if (subEl && j.subhead) subEl.textContent = j.subhead;
    if (ctaEl && j.cta) ctaEl.textContent = j.cta;
    db.prepare("UPDATE sites SET html = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(dom.serialize(), site.id, req.userId);
    return res.json({ ok: true, success: true, headline: j.headline });
  } catch (e) { console.error("[ai-tools/homepage-copy]", e.message); return res.status(502).json({ error: "Generation failed: " + e.message }); }
});

// 5) Service descriptions -> rewrite existing services
router.post("/service-descriptions/run", auth, async (req, res) => {
  if (!apiKey()) return guard(res);
  try {
    const db = getDb();
    const services = db.prepare("SELECT id, name, description FROM services WHERE user_id = ? AND active = 1 ORDER BY rowid").all(req.userId);
    if (!services.length) return res.json({ ok: true, success: true, updated: 0, note: "No services to rewrite — add services first" });
    const sys = "You are a marketing copywriter. Given a list of services, rewrite each description to be detailed and compelling (2-3 sentences each). Return ONLY a valid JSON object mapping the exact service name to its new description, no markdown.";
    const user = "Services:\n" + services.map(s => `- ${s.name}${s.description ? " (current: " + s.description + ")" : ""}`).join("\n");
    const out = await ai(sys, user, 3000);
    const j = parseJson(out) || {};
    let updated = 0;
    const stmt = db.prepare("UPDATE services SET description = ? WHERE id = ? AND user_id = ?");
    for (const s of services) { const desc = j[s.name]; if (desc && String(desc).trim()) { stmt.run(String(desc).trim(), s.id, req.userId); updated++; } }
    return res.json({ ok: true, success: true, updated });
  } catch (e) { console.error("[ai-tools/service-descriptions]", e.message); return res.status(502).json({ error: "Generation failed: " + e.message }); }
});

// 6) Insights -> ai_agent_insights
router.post("/insights/run", auth, async (req, res) => {
  if (!apiKey()) return guard(res);
  try {
    const db = getDb();
    try { db.exec("CREATE TABLE IF NOT EXISTS ai_agent_insights (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, category TEXT, title TEXT, description TEXT, severity TEXT DEFAULT 'info', data_json TEXT DEFAULT '{}', action_taken TEXT, action_result TEXT, dismissed INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))"); } catch (_) {}
    const safeCount = (sql) => { try { return db.prepare(sql).get(req.userId).c; } catch (_) { return 0; } };
    const stats = {
      contacts: safeCount("SELECT COUNT(*) c FROM contacts WHERE user_id = ?"),
      orders: safeCount("SELECT COUNT(*) c FROM orders WHERE user_id = ?"),
      revenue: (() => { try { return db.prepare("SELECT COALESCE(SUM(total),0) c FROM orders WHERE user_id = ?").get(req.userId).c; } catch (_) { return 0; } })(),
      deals: safeCount("SELECT COUNT(*) c FROM deals WHERE user_id = ?"),
      bookings: safeCount("SELECT COUNT(*) c FROM bookings WHERE user_id = ?"),
    };
    const sys = "You are a business analyst. Given summary metrics, return ONLY a valid JSON array of 3-5 insights, each shaped {\"title\":\"...\",\"description\":\"...\",\"severity\":\"info|warning|opportunity\",\"category\":\"...\"}. No markdown.";
    const out = await ai(sys, "Business metrics:\n" + JSON.stringify(stats) + "\nSurface the most important patterns and concrete recommendations.", 2000);
    let arr = parseJson(out);
    if (!Array.isArray(arr)) return res.json({ ok: true, success: true, created: 0, note: "Could not generate insights — try again" });
    let created = 0;
    const stmt = db.prepare("INSERT INTO ai_agent_insights (id, user_id, type, category, title, description, severity, dismissed) VALUES (?,?, 'ai-tool', ?,?,?,?, 0)");
    for (const it of arr.slice(0, 5)) { if (it && it.title) { stmt.run(uuid(), req.userId, it.category || "general", String(it.title), String(it.description || ""), it.severity || "info"); created++; } }
    return res.json({ ok: true, success: true, created });
  } catch (e) { console.error("[ai-tools/insights]", e.message); return res.status(502).json({ error: "Generation failed: " + e.message }); }
});

// ✨ UNIVERSAL AI WRITER (2026-06-13): write or improve ANY field, on-brand. Powers the ✨ button everywhere.
router.post("/compose", auth, async (req, res) => {
  try {
    const db = getDb();
    const userId = req.userId;
    const { kind, mode, prompt, current, tone } = req.body || {};
    // kind = what we're writing (email, social_caption, product_description, service_blurb, bio, sms, review_reply, headline, general)
    // mode = "write" (from a brief) or "improve" (polish existing `current` text)
    const apiKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(503).json({ error: "AI not configured — add an Anthropic API key" });
    if (mode === "improve" && (!current || String(current).trim().length < 2)) return res.status(400).json({ error: "Nothing to improve yet — write a little first" });
    if (mode !== "improve" && (!prompt || String(prompt).trim().length < 2)) return res.status(400).json({ error: "Tell me what to write" });

    // brand context
    let brand = {};
    try { const r = db.prepare("SELECT business_name, brand_kit FROM users WHERE id=?").get(userId) || {}; let k={}; try{k=r.brand_kit?JSON.parse(r.brand_kit):{};}catch(_e){} brand = { name: k.businessName || r.business_name || "the business", voice: k.voice || "" }; } catch(_e) {}

    const KINDS = {
      email: "an email body (conversational, not salesy, 4-6 sentences)",
      social_caption: "a social media caption (punchy, scroll-stopping, with a light call to action)",
      product_description: "a product description (benefits-first, vivid, concise)",
      service_blurb: "a short service description (clear, reassuring, value-focused)",
      bio: "a short business or personal bio (warm, credible, first or third person as fits)",
      sms: "a text message (under 160 chars, friendly, clear)",
      review_reply: "a reply to a customer review (genuine, never defensive, 1-3 sentences)",
      headline: "a headline or title (short, compelling, no clickbait)",
      general: "the requested text (clear, on-brand)"
    };
    const what = KINDS[kind] || KINDS.general;
    const toneLine = tone ? (" Tone: " + tone + ".") : (brand.voice ? (" Brand voice: " + brand.voice + ".") : "");
    let sys = "You are a sharp copywriter for " + brand.name + ". Write " + what + "." + toneLine + " Return ONLY the text — no preamble, no quotes, no markdown.";
    let userMsg;
    if (mode === "improve") {
      sys = "You are a sharp editor for " + brand.name + ". Improve the following " + (kind||"text") + " — clearer, more engaging, on-brand, same intent." + toneLine + " Return ONLY the improved text.";
      userMsg = String(current).slice(0, 2000) + (prompt ? ("\n\nExtra instructions: " + String(prompt).slice(0,300)) : "");
    } else {
      userMsg = String(prompt).slice(0, 600);
    }

    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic.default({ apiKey });
    const msg = await client.messages.create({ model: "claude-sonnet-4-6", max_tokens: 700, system: sys, messages: [{ role: "user", content: userMsg }] });
    let text = (msg.content && msg.content[0] && msg.content[0].text || "").trim().replace(/^["'“]|["'”]$/g, "").trim();
    if (!text) return res.status(502).json({ error: "Couldn't generate — try again" });
    res.json({ success: true, text, kind: kind || "general", mode: mode || "write" });
  } catch (e) { console.error("[ai-tools/compose]", e.message); res.status(500).json({ error: "Compose failed" }); }
});

module.exports = router;
