/**
 * site-localize.js — Auto-translate published sites into multiple languages.
 *
 * Customer flow:
 *   1. Site is published in English
 *   2. User taps "Translate this site" → picks target languages (es, fr, zh, etc.)
 *   3. Backend translates content via Claude → stores per language
 *   4. Hosting layer detects visitor's Accept-Language header → serves
 *      matching translation. SEO-friendly URL: /es/, /fr/, etc.
 *
 * ENDPOINTS
 *   POST /api/site-localize/translate   → translate a site to N languages
 *   GET  /api/site-localize/list/:siteId → list available translations
 *   DELETE /api/site-localize/:siteId/:lang → remove a translation
 *
 * NOTES
 *   - Stores translations as a single JSON per (site_id, language) row.
 *   - Translation is content-only (text). Layout/styling unchanged.
 *   - SEO: each language gets a public route /<lang>/{site-slug}
 *   - Hosting.js needs a small patch to read Accept-Language and route.
 */

const express   = require("express");
const router    = express.Router();
const { getDb } = require("../db/init");
const { auth }  = require("../middleware/auth");
const { v4: uuid } = require("uuid");

function getSetting(key) {
  try { return getDb().prepare("SELECT value FROM platform_settings WHERE key = ?").get(key)?.value; }
  catch (_) { return null; }
}

const SUPPORTED_LANGUAGES = {
  es: "Spanish",   fr: "French",    de: "German",     it: "Italian",
  pt: "Portuguese",nl: "Dutch",     pl: "Polish",     ru: "Russian",
  zh: "Mandarin Chinese (Simplified)",
  ja: "Japanese",  ko: "Korean",    ar: "Arabic",     he: "Hebrew",
  hi: "Hindi",     vi: "Vietnamese",th: "Thai",       id: "Indonesian",
  tr: "Turkish",   sv: "Swedish",   no: "Norwegian",  da: "Danish",
  fi: "Finnish",
};

function ensureTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS site_translations (
    id          TEXT PRIMARY KEY,
    site_id     TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    language    TEXT NOT NULL,
    html_content TEXT,
    status      TEXT DEFAULT 'ready',
    word_count  INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(site_id, language)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_site_trans_site
           ON site_translations(site_id, language)`);
}

// ──────────────────────────────────────────────────────────────────────
// POST /translate — translate a site to multiple languages
// Body: { site_id, languages: ['es', 'fr', 'zh'] }
// ──────────────────────────────────────────────────────────────────────
router.post("/translate", auth, express.json(), async (req, res) => {
  const db = getDb();
  ensureTables(db);

  const siteId    = String(req.body?.site_id || "");
  const languages = Array.isArray(req.body?.languages) ? req.body.languages : [];

  if (!siteId)         return res.status(400).json({ error: "site_id required" });
  if (!languages.length) return res.status(400).json({ error: "languages array required (e.g. ['es', 'fr'])" });

  // Verify the user owns this site and pull its HTML
  let site;
  try {
    site = db.prepare("SELECT id, user_id, name, html FROM sites WHERE id = ? AND user_id = ?")
             .get(siteId, req.userId);
  } catch (_) { /* sites table missing */ }
  if (!site) return res.status(404).json({ error: "Site not found" });
  if (!site.html) return res.status(400).json({ error: "Site has no HTML content to translate" });

  // Validate requested languages
  const validLangs = languages.filter(l => SUPPORTED_LANGUAGES[l]);
  if (!validLangs.length) {
    return res.status(400).json({
      error: "No valid languages",
      supported: Object.keys(SUPPORTED_LANGUAGES),
    });
  }

  // ── Plan cap check ─────────────────────────────────────────────────
  // Each language counts as one translation. Admin bypasses.
  // Starter blocked; growth=3/mo, pro=15, enterprise=50, agency=100
  if (typeof global.mineCheckUsage === "function") {
    const check = global.mineCheckUsage(db, req.userId, "siteTranslations");
    const wantsToUse = validLangs.length;
    if (check.blocked) {
      return res.status(403).json({
        error: check.cap === 0
          ? "Site Auto-Translation is a Growth-plan feature. Upgrade to unlock."
          : `You've used your ${check.cap} site translations this month.`,
        plan: check.plan,
        cap: check.cap,
        current: check.current,
        upgrade_required: check.cap === 0,
      });
    }
    if (check.remaining < wantsToUse) {
      return res.status(403).json({
        error: `You requested ${wantsToUse} translations but only have ${check.remaining} left this month on the ${check.plan} plan. Upgrade or pick fewer languages.`,
        plan: check.plan,
        cap: check.cap,
        remaining: check.remaining,
        requested: wantsToUse,
      });
    }
  }

  const apiKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  // Run translations in parallel, capped at 3 at a time to avoid rate limits
  const results = [];
  const failures = [];

  const fetch = (await import("node-fetch")).default;

  async function translateOne(lang) {
    const langName = SUPPORTED_LANGUAGES[lang];

    const prompt = `You are TAKEOVA's site translator. Translate the following HTML content from English into ${langName}.

CRITICAL RULES:
1. Translate ONLY visible text — never translate tag names, attribute names, class names, or IDs.
2. Translate alt="..." and placeholder="..." attribute VALUES (those are user-visible).
3. Do NOT translate URLs, email addresses, brand names that are proper nouns, or code samples.
4. Preserve every HTML tag exactly. Same structure, same attributes, same classes.
5. Keep all <script>, <style>, and <code> contents unchanged.
6. Match the original tone — casual stays casual, formal stays formal.
7. Update the <html lang="..."> attribute to "${lang}".
8. If the page is in English already, just translate. Do not add language switcher widgets — that's handled by TAKEOVA's hosting layer.

OUTPUT: the complete translated HTML, nothing else. No markdown fences, no prose, no explanation.

HTML:
${site.html}`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key":         apiKey,
        "content-type":      "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-6",
        max_tokens: 16000,
        messages:   [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
    }
    const data = await r.json();
    let translated = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    translated = translated.replace(/^```html\s*/i, "").replace(/```$/, "").trim();
    return translated;
  }

  // Process languages in chunks of 3
  const chunks = [];
  for (let i = 0; i < validLangs.length; i += 3) chunks.push(validLangs.slice(i, i + 3));

  for (const chunk of chunks) {
    const settled = await Promise.allSettled(chunk.map(translateOne));
    chunk.forEach((lang, idx) => {
      const r = settled[idx];
      if (r.status === "fulfilled") {
        try {
          // Upsert
          const wordCount = (r.value.match(/\b\w+\b/g) || []).length;
          db.prepare(`
            INSERT INTO site_translations (id, site_id, user_id, language, html_content, status, word_count)
            VALUES (?, ?, ?, ?, ?, 'ready', ?)
            ON CONFLICT(site_id, language) DO UPDATE SET
              html_content = excluded.html_content,
              status       = 'ready',
              word_count   = excluded.word_count,
              updated_at   = datetime('now')
          `).run(uuid(), siteId, req.userId, lang, r.value, wordCount);
          results.push({ lang, name: SUPPORTED_LANGUAGES[lang], word_count: wordCount });
        } catch (e) {
          failures.push({ lang, error: "DB error: " + e.message });
        }
      } else {
        failures.push({ lang, error: String(r.reason).slice(0, 200) });
      }
    });
  }

  res.json({
    success: results.length > 0,
    translated: results,
    failed: failures,
    site_id: siteId,
  });

  // Track usage — only count translations that actually succeeded
  if (typeof global.mineTrackUsage === "function" && results.length > 0) {
    try { global.mineTrackUsage(db, req.userId, "siteTranslations", results.length); } catch (_) {}
  }
});

// ──────────────────────────────────────────────────────────────────────
// GET /list/:siteId — list translations available for a site
// ──────────────────────────────────────────────────────────────────────
router.get("/list/:siteId", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const rows = db.prepare(`
    SELECT language, status, word_count, updated_at
    FROM site_translations
    WHERE site_id = ? AND user_id = ?
    ORDER BY language ASC
  `).all(req.params.siteId, req.userId);

  res.json({
    translations: rows.map(r => ({
      lang: r.language,
      name: SUPPORTED_LANGUAGES[r.language] || r.language,
      status: r.status,
      word_count: r.word_count,
      updated_at: r.updated_at,
    })),
    supported: SUPPORTED_LANGUAGES,
  });
});

// ──────────────────────────────────────────────────────────────────────
// DELETE /:siteId/:lang — remove a translation
// ──────────────────────────────────────────────────────────────────────
router.delete("/:siteId/:lang", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  db.prepare("DELETE FROM site_translations WHERE site_id = ? AND user_id = ? AND language = ?")
    .run(req.params.siteId, req.userId, req.params.lang);
  res.json({ success: true });
});

// Public helper used by hosting.js to serve the right language
function getTranslation(siteId, lang) {
  try {
    const db = getDb();
    return db.prepare(
      "SELECT html_content FROM site_translations WHERE site_id = ? AND language = ? AND status = 'ready'"
    ).get(siteId, lang)?.html_content || null;
  } catch (_) { return null; }
}

function getAvailableLanguages(siteId) {
  try {
    const db = getDb();
    return db.prepare(
      "SELECT language FROM site_translations WHERE site_id = ? AND status = 'ready'"
    ).all(siteId).map(r => r.language);
  } catch (_) { return []; }
}

module.exports = router;
module.exports.getTranslation         = getTranslation;
module.exports.getAvailableLanguages  = getAvailableLanguages;
module.exports.SUPPORTED_LANGUAGES    = SUPPORTED_LANGUAGES;
