// ═══════════════════════════════════════════════════════════════════
// MINE v49.2 — Full Site Editor Backend
// Powers: inline editing, AI rewrite, image upload, sections,
// robust HTML mutation (DOMParser), version history (undo/redo)
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const { isAdmin } = require('../utils/admin-check');
const router = express.Router();
const { auth } = require('../middleware/auth');

// Lazy-require heavy deps so server boots even if jsdom isn't installed
let JSDOM, Anthropic, AWS, multer;
function lazyJsdom() { if (!JSDOM) JSDOM = require('jsdom').JSDOM; return JSDOM; }
function lazyAnthropic() { if (!Anthropic) Anthropic = require('@anthropic-ai/sdk'); return Anthropic; }
function lazyAWS() { if (!AWS) AWS = require('aws-sdk'); return AWS; }
function lazyMulter() { if (!multer) multer = require('multer'); return multer; }

// ─── Helpers ────────────────────────────────────────────────────────
function getSite(db, siteId, userId) {
  try {
    return db.prepare(`SELECT * FROM sites WHERE id = ? AND user_id = ?`).get(siteId, userId) || null;
  } catch (e) { return null; }
}

function bumpUsage(db, userId, column) {
  try { db.prepare(`UPDATE users SET ${column} = COALESCE(${column},0) + 1 WHERE id = ?`).run(userId); } catch(e) { console.error("[/site-editor.js]", e.message || e); }
}

function ensureVersionsTable(db) {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS site_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL,
      html TEXT NOT NULL,
      label TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_site_versions_site ON site_versions(site_id, id)`).run();
  } catch (e) {}
}

function snapshot(db, siteId, html, label) {
  ensureVersionsTable(db);
  try {
    db.prepare(`INSERT INTO site_versions (site_id, html, label) VALUES (?, ?, ?)`).run(siteId, html, label || 'auto');
    // Keep last 50 per site
    db.prepare(`DELETE FROM site_versions WHERE site_id = ? AND id NOT IN (
      SELECT id FROM site_versions WHERE site_id = ? ORDER BY id DESC LIMIT 50
    )`).run(siteId, siteId);
  } catch(e) { console.error("[/site-editor.js]", e.message || e); }
}

// ─── 1. GET site HTML ────────────────────────────────────────────────
function planCap(plan, key, fallback) {
  try { const C = require("./features").PLAN_CAPS || {}; const p = C[plan] || null; if (p && p[key] != null) return p[key]; } catch (_) {}
  return fallback;
}

router.get('/:siteId', auth, (req, res) => {
  try {
    const db = req.app.locals.db;
    const site = getSite(db, req.params.siteId, req.user.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    res.json({
      id: site.id,
      name: site.name || site.title || 'Untitled',
      html: site.html || '',
      updated_at: site.updated_at,
      published: !!site.published
    });
  } catch (e) { console.error("[/:siteId]", e?.message || e); res.status(500).json({ error: "An internal error occurred" }); }
});

// ─── 2. PATCH element text/attr by selector (robust DOMParser) ───────
router.patch('/:siteId/element', auth, (req, res) => {
  try {
    const db = req.app.locals.db;
    const site = getSite(db, req.params.siteId, req.user.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const { selector, content, attr } = req.body || {};
    if (!selector) return res.status(400).json({ error: 'selector required' });

    snapshot(db, site.id, site.html, 'before-edit');

    const dom = new (lazyJsdom())(site.html);
    const el = dom.window.document.querySelector(selector);
    if (!el) return res.status(400).json({ error: 'Element not found: ' + selector });

    if (attr) el.setAttribute(attr, content || '');
    else el.textContent = content || '';

    const newHtml = dom.serialize();
    db.prepare(`UPDATE sites SET html = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(newHtml, site.id);
    bumpUsage(db, req.user.id, 'ai_edits_used');

    res.json({ success: true, html: newHtml });
  } catch (e) { console.error("[/:siteId/element]", e?.message || e); res.status(500).json({ error: "An internal error occurred" }); }
});

// ─── 3. AI REWRITE with Claude ───────────────────────────────────────
router.post('/:siteId/ai-rewrite', auth, async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

    const db = req.app.locals.db;
    const site = getSite(db, req.params.siteId, req.user.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const { selector, currentText, prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    // Cap check
    // Unified metered cap: monthly PLAN_CAPS 'edits' (lifetime ai_edits_used ceiling removed)
    if (!isAdmin(db, req.userId) && typeof global.mineCheckUsage === "function") {
      const _u = global.mineCheckUsage(db, req.user.id, "edits");
      if (_u && _u.blocked) return res.status(402).json({ error: "Monthly AI edit allowance reached - upgrade your plan or continue pay-as-you-go.", code: "PLAN_LIMIT", requiresUpgrade: true, used: _u.used, cap: _u.cap });
    }
    if (typeof global.mineTrackUsage === "function") { try { global.mineTrackUsage(db, req.user.id, "edits", 1); } catch(_e){} }

    const client = new (lazyAnthropic())({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `You are rewriting one element on a website. Return ONLY the new text — no quotes, no preamble, no markdown, no explanation.\n\nCurrent text: "${currentText || ''}"\n\nUser instruction: ${prompt}\n\nNew text:`
      }]
    });

    const rewritten = (msg.content?.[0]?.text || '').trim().replace(/^["']|["']$/g, '');

    if (selector) {
      const dom = new (lazyJsdom())(site.html);
      const el = dom.window.document.querySelector(selector);
      if (el) {
        snapshot(db, site.id, site.html, 'before-ai-rewrite');
        el.textContent = rewritten;
        const newHtml = dom.serialize();
        db.prepare(`UPDATE sites SET html = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(newHtml, site.id);
      }
    }
    bumpUsage(db, req.user.id, 'ai_edits_used');
    res.json({ success: true, rewritten });
  } catch (e) {
    console.error('[ai-rewrite]', e);
    console.error("[/:siteId/ai-rewrite]", e?.message || e); res.status(500).json({ error: "An internal error occurred" });
  }
});

// ─── 4. REPLACE IMAGE — S3 upload + DOM swap ─────────────────────────
router.post('/:siteId/ai-restyle', auth, async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
    const db = req.app.locals.db;
    const site = getSite(db, req.params.siteId, req.user.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    const { prompt, referenceImage } = req.body || {};
    if (!referenceImage || !referenceImage.data || !referenceImage.media_type) return res.status(400).json({ error: 'referenceImage required' });
    if (!/^image\/(png|jpeg|webp)$/.test(referenceImage.media_type)) return res.status(400).json({ error: 'PNG, JPEG or WebP only' });
    if (String(referenceImage.data).length > 5200000) return res.status(400).json({ error: 'Image too large (max ~3.5MB)' });
    // Unified metered cap: monthly PLAN_CAPS 'edits' (lifetime ai_edits_used ceiling removed)
    if (!isAdmin(db, req.userId) && typeof global.mineCheckUsage === "function") {
      const _u = global.mineCheckUsage(db, req.user.id, "edits");
      if (_u && _u.blocked) return res.status(402).json({ error: "Monthly AI edit allowance reached - upgrade your plan or continue pay-as-you-go.", code: "PLAN_LIMIT", requiresUpgrade: true, used: _u.used, cap: _u.cap });
    }
    if (typeof global.mineTrackUsage === "function") { try { global.mineTrackUsage(db, req.user.id, "edits", 1); } catch(_e){} }
    const html = String(site.html || '');
    if (html.length < 100) return res.status(400).json({ error: 'Site has no HTML to restyle' });
    if (html.length > 95000) return res.status(400).json({ error: 'Site too large for a one-shot visual restyle \u2014 restyle sections instead' });
    const client = new (lazyAnthropic())({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 30000,
      system: 'You restyle existing websites to match a reference image. Rewrite the FULL HTML so its look matches the reference: colour palette, typography mood, spacing, button styles, backgrounds, overall vibe. PRESERVE all text content, structure, links, images, ids, classes used by scripts, and all <script> blocks exactly. Styling changes only. Return ONLY the complete HTML document, no markdown fences, no commentary.',
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: referenceImage.media_type, data: referenceImage.data } },
        { type: 'text', text: 'Reference image of the desired look attached. ' + (prompt ? 'Owner notes: ' + String(prompt).slice(0, 400) + '. ' : '') + 'Current site HTML follows \u2014 restyle it to match the reference.\n\n' + html }
      ]}]
    });
    let out = (msg.content && msg.content[0] && msg.content[0].text || '').trim();
    out = out.replace(/^```(?:html)?/i, '').replace(/```$/, '').trim();
    if (out.toLowerCase().indexOf('<html') < 0) return res.status(500).json({ error: 'Restyle did not return a full document \u2014 try again' });
    try { db.prepare(`INSERT INTO site_versions (site_id, html, label) VALUES (?, ?, ?)`).run(siteId, html, label || 'auto'); } catch (_v) {}
    db.prepare(`UPDATE sites SET html = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(out, site.id);
    db.prepare(`UPDATE users SET ai_edits_used = COALESCE(ai_edits_used,0)+1 WHERE id = ?`).run(req.user.id);
    res.json({ html: out, saved: true });
  } catch (e) { console.error('[ai-restyle]', e.message); res.status(500).json({ error: 'Restyle failed: ' + e.message }); }
});

// --- AI restyle FROM AN INSPIRATION URL (scrapes the site's design DNA, then restyles) ---
router.post('/:siteId/restyle-from-url', auth, async (req, res) => {
  let JSDOM;
  try {
    const { url, prompt } = req.body || {};
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url required' });
    // SSRF guard (same as import-from-url)
    let parsed;
    try { parsed = new URL(url); } catch(e) { return res.status(400).json({ error: 'Invalid URL format' }); }
    if (!/^https?:$/.test(parsed.protocol)) return res.status(400).json({ error: 'Only http(s) URLs supported' });
    const host = parsed.hostname.toLowerCase();
    if (['localhost','127.0.0.1','0.0.0.0','::1'].includes(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host))
      return res.status(400).json({ error: 'Cannot analyze internal/private addresses' });

    const db = getDb();
    const site = db.prepare('SELECT * FROM sites WHERE id = ? AND user_id = ?').get(req.params.siteId, req.userId);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    // metered like a normal edit
    if (!isAdmin(db, req.userId) && typeof global.mineCheckUsage === 'function') {
      const u = global.mineCheckUsage(db, req.userId, 'edits');
      if (u && u.blocked) return res.status(402).json({ error: 'Monthly AI edit allowance reached — upgrade your plan or continue pay-as-you-go.', code: 'PLAN_LIMIT', requiresUpgrade: true });
    }

    // 1. Fetch the inspiration page (10s timeout, 1MB cap)
    let htmlText = '';
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 10000);
      const nf = (await import('node-fetch')).default;
      const r = await nf(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (TAKEOVA design analyzer)' } });
      clearTimeout(to);
      if (!r.ok) return res.status(400).json({ error: 'Could not fetch that URL — got ' + r.status });
      const buf = await r.buffer();
      htmlText = buf.slice(0, 1024 * 1024).toString('utf8');
    } catch(e) {
      return res.status(400).json({ error: e && e.name === 'AbortError' ? 'That page took too long to load (10s)' : 'Could not fetch that URL' });
    }

    // 2. Extract design DNA: colors (hex/rgb from inline + style blocks), fonts, and vibe cues
    const colors = {};
    (htmlText.match(/#[0-9a-fA-F]{6}\b/g) || []).forEach(c => { const k = c.toLowerCase(); colors[k] = (colors[k]||0)+1; });
    (htmlText.match(/rgb\([^)]+\)/g) || []).forEach(c => { colors[c] = (colors[c]||0)+1; });
    const topColors = Object.entries(colors).sort((a,b)=>b[1]-a[1]).slice(0,8).map(x=>x[0]);
    const fonts = Array.from(new Set((htmlText.match(/font-family:\s*([^;"'}]+)/gi) || []).map(f => f.replace(/font-family:\s*/i,'').trim()))).slice(0,6);
    let title = ''; const tm = htmlText.match(/<title[^>]*>([^<]{0,120})<\/title>/i); if (tm) title = tm[1].trim();
    const bigText = (htmlText.match(/font-size:\s*(\d{2,3})px/gi) || []).length;

    // 3. Build a design brief + restyle the user's site to match
    const anthropicKey = (db.prepare("SELECT value FROM settings WHERE key = ?").get("ANTHROPIC_API_KEY") || {}).value || process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return res.status(500).json({ error: 'AI is not configured (missing Anthropic key).' });
    const brief = [
      'Reference site: ' + (title || url),
      topColors.length ? 'Dominant colours: ' + topColors.join(', ') : '',
      fonts.length ? 'Typefaces / font stacks: ' + fonts.join(' | ') : '',
      bigText > 20 ? 'Design feel: bold, large-type, high-impact.' : 'Design feel: clean and restrained.',
      prompt ? ('Owner notes: ' + String(prompt).slice(0, 300)) : ''
    ].filter(Boolean).join('\n');

    const client = new (lazyAnthropic())({ apiKey: anthropicKey });
    const sys = 'You restyle an existing website to match the design DNA of a reference site (described below by its real extracted colours, fonts, and feel). Rewrite the FULL HTML so its look — colour palette, typography, spacing, button styles, backgrounds, overall vibe — matches that reference. PRESERVE all text content, structure, links, images, ids, classes used by scripts, and all <script> blocks exactly. Styling only. Return ONLY the complete HTML document, no markdown, no commentary.';
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 8000,
      system: sys,
      messages: [{ role: 'user', content: 'DESIGN DNA OF THE REFERENCE:\n' + brief + '\n\n=== CURRENT SITE HTML (restyle this) ===\n' + (site.html || '') }]
    });
    let out = (msg.content && msg.content[0] && msg.content[0].text || '').trim().replace(/^```html?\s*/i,'').replace(/```\s*$/,'');
    if (!/<[a-z]/i.test(out)) return res.status(502).json({ error: 'Restyle failed — please try again.' });

    snapshot(db, site.id, site.html, 'before-restyle-from-url');
    db.prepare('UPDATE sites SET html = ? WHERE id = ?').run(out, site.id);
    if (typeof global.mineTrackUsage === 'function') { try { global.mineTrackUsage(db, req.userId, 'edits', 1); } catch(_e){} }
    res.json({ ok: true, html: out, analyzed: { colors: topColors, fonts, title: title || url } });
  } catch (e) {
    res.status(500).json({ error: 'Could not restyle from that URL right now.' });
  }
});

router.post('/:siteId/image', auth, (req, res) => {
  try {
    const upload = lazyMulter()({ limits: { fileSize: 10 * 1024 * 1024 } }).single('file');
    upload(req, res, async (err) => {
      if (err) return console.error("[/:siteId/image]", err?.message || err); res.status(400).json({ error: "An internal error occurred" });
      if (!req.file) return res.status(400).json({ error: 'file required' });

      // Magic-byte validation — multer.memoryStorage stores in req.file.buffer
      const { validateUploadedBuffer } = require('../lib/file-validator');
      const validation = validateUploadedBuffer(req.file.buffer, 'image');
      if (!validation.valid) {
        return res.status(400).json({ error: 'Invalid image: ' + validation.reason });
      }

      const db = req.app.locals.db;
      const site = getSite(db, req.params.siteId, req.user.id);
      if (!site) return res.status(404).json({ error: 'Site not found' });

      const { selector } = req.body || {};
      if (!selector) return res.status(400).json({ error: 'selector required' });

      // Upload path: S3 if configured, else base64 fallback
      let imageUrl;
      if (process.env.S3_BUCKET && process.env.AWS_ACCESS_KEY_ID) {
        const AWSLib = lazyAWS();
        const s3 = new AWSLib.S3({
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          region: process.env.AWS_REGION || 'us-east-1'
        });
        const key = `sites/${site.id}/${Date.now()}-${(req.file.originalname || 'img').replace(/[^\w.-]/g, '_')}`;
        const r = await s3.upload({
          Bucket: process.env.S3_BUCKET, Key: key, Body: req.file.buffer,
          ContentType: req.file.mimetype, ACL: 'public-read'
        }).promise();
        imageUrl = r.Location;
      } else {
        imageUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
      }

      const dom = new (lazyJsdom())(site.html);
      const el = dom.window.document.querySelector(selector);
      if (!el) return res.status(400).json({ error: 'Element not found: ' + selector });

      snapshot(db, site.id, site.html, 'before-image-swap');

      if (el.tagName.toLowerCase() === 'img') {
        el.setAttribute('src', imageUrl);
      } else {
        const existing = (el.getAttribute('style') || '').replace(/background-image:\s*url\([^)]+\);?/gi, '').trim();
        el.setAttribute('style', `${existing};background-image:url('${imageUrl}')`.replace(/^;+/, ''));
      }

      const newHtml = dom.serialize();
      db.prepare(`UPDATE sites SET html = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(newHtml, site.id);
      bumpUsage(db, req.user.id, 'ai_images_used');
      res.json({ success: true, url: imageUrl });
    });
  } catch (e) { console.error("[/:siteId/image]", e?.message || e); res.status(500).json({ error: "An internal error occurred" }); }
});

// ─── 5. SECTIONS — library + add/remove/reorder ──────────────────────
const SECTION_LIBRARY = {
  hero:         `<section class="mine-section" data-sec="hero"><div style="background:linear-gradient(135deg,#1e3a5f,#2563EB);padding:80px 20px;text-align:center;color:#fff"><h1 style="font-size:42px;font-weight:900;margin:0 0 16px">Your Headline Here</h1><p style="font-size:18px;opacity:.85;margin:0 0 24px">Compelling subheadline.</p><a href="#" style="background:#fff;color:#2563EB;padding:14px 32px;border-radius:30px;font-weight:700;text-decoration:none;display:inline-block">Get Started</a></div></section>`,
  trust:        `<section class="mine-section" data-sec="trust"><div style="background:#F8FAFC;padding:30px 20px;text-align:center"><div style="font-size:12px;color:#64748B;margin-bottom:12px;font-weight:600">TRUSTED BY</div><div style="display:flex;gap:30px;justify-content:center;flex-wrap:wrap;opacity:.6;font-weight:700">Company A · Company B · Company C · Company D</div></div></section>`,
  services:     `<section class="mine-section" data-sec="services"><div style="padding:60px 20px;max-width:1100px;margin:0 auto"><h2 style="text-align:center;font-size:32px;margin:0 0 40px">Our Services</h2><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:20px"><div style="padding:24px;border-radius:12px;background:#F8FAFC"><h3 style="margin:0 0 8px">Service One</h3><p style="margin:0;color:#64748B">Description.</p></div><div style="padding:24px;border-radius:12px;background:#F8FAFC"><h3 style="margin:0 0 8px">Service Two</h3><p style="margin:0;color:#64748B">Description.</p></div><div style="padding:24px;border-radius:12px;background:#F8FAFC"><h3 style="margin:0 0 8px">Service Three</h3><p style="margin:0;color:#64748B">Description.</p></div></div></div></section>`,
  testimonials: `<section class="mine-section" data-sec="testimonials"><div style="padding:60px 20px;background:#F8FAFC"><h2 style="text-align:center;font-size:32px;margin:0 0 40px">What Customers Say</h2><div style="max-width:700px;margin:0 auto;text-align:center"><p style="font-size:20px;line-height:1.6;margin:0 0 16px">&ldquo;An amazing experience from start to finish.&rdquo;</p><div style="font-weight:700">&mdash; Happy Customer</div></div></div></section>`,
  pricing:      `<section class="mine-section" data-sec="pricing"><div style="padding:60px 20px;max-width:900px;margin:0 auto"><h2 style="text-align:center;font-size:32px;margin:0 0 40px">Pricing</h2><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:20px"><div style="padding:24px;border:1px solid #E2E8F0;border-radius:12px;text-align:center"><h3 style="margin:0 0 8px">Starter</h3><div style="font-size:32px;font-weight:900;margin:0 0 16px">$29/mo</div><a href="#" style="background:#2563EB;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;display:inline-block">Choose</a></div><div style="padding:24px;border:2px solid #2563EB;border-radius:12px;text-align:center"><h3 style="margin:0 0 8px">Pro</h3><div style="font-size:32px;font-weight:900;margin:0 0 16px">$79/mo</div><a href="#" style="background:#2563EB;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;display:inline-block">Choose</a></div></div></div></section>`,
  booking:      `<section class="mine-section" data-sec="booking"><div style="padding:60px 20px;text-align:center;background:linear-gradient(135deg,#1e3a5f,#2563EB);color:#fff"><h2 style="font-size:32px;margin:0 0 16px">Ready to get started?</h2><p style="font-size:18px;opacity:.85;margin:0 0 24px">Book a free consultation today.</p><a href="#" style="background:#fff;color:#2563EB;padding:14px 32px;border-radius:30px;font-weight:700;text-decoration:none;display:inline-block">Book Now</a></div></section>`,
  contact:      `<section class="mine-section" data-sec="contact"><div style="padding:60px 20px;max-width:600px;margin:0 auto"><h2 style="text-align:center;font-size:32px;margin:0 0 32px">Contact Us</h2><div style="display:grid;gap:16px"><input placeholder="Name" style="padding:12px;border:1px solid #E2E8F0;border-radius:8px;font-size:15px"><input placeholder="Email" style="padding:12px;border:1px solid #E2E8F0;border-radius:8px;font-size:15px"><textarea placeholder="Message" rows="4" style="padding:12px;border:1px solid #E2E8F0;border-radius:8px;font-size:15px"></textarea><button style="background:#2563EB;color:#fff;padding:14px;border:0;border-radius:8px;font-weight:700;font-size:15px;cursor:pointer">Send</button></div></div></section>`,
  footer:       `<section class="mine-section" data-sec="footer"><div style="padding:30px 20px;background:#0F172A;color:#94A3B8;text-align:center;font-size:13px"><div style="margin-bottom:8px">&copy; 2026 Your Business.</div><div style="display:flex;gap:16px;justify-content:center"><a href="#" style="color:#94A3B8;text-decoration:none">Privacy</a><a href="#" style="color:#94A3B8;text-decoration:none">Terms</a><a href="#" style="color:#94A3B8;text-decoration:none">Contact</a></div></div></section>`
};

router.get('/sections/library', auth, (req, res) => {
  res.json({ sections: Object.keys(SECTION_LIBRARY).map(key => ({
    key, name: key.charAt(0).toUpperCase() + key.slice(1)
  })) });
});

router.post('/:siteId/section/add', auth, (req, res) => {
  try {
    const db = req.app.locals.db;
    const site = getSite(db, req.params.siteId, req.user.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const { sectionKey, position } = req.body || {};
    if (!sectionKey || !SECTION_LIBRARY[sectionKey]) {
      return res.status(400).json({ error: 'Invalid sectionKey. Options: ' + Object.keys(SECTION_LIBRARY).join(', ') });
    }

    snapshot(db, site.id, site.html, 'before-section-add');

    const dom = new (lazyJsdom())(site.html);
    const body = dom.window.document.body;
    const tmp = dom.window.document.createElement('div');
    tmp.innerHTML = SECTION_LIBRARY[sectionKey];
    const el = tmp.firstElementChild;

    const sections = body.querySelectorAll('.mine-section');
    if (typeof position === 'number' && sections[position]) {
      body.insertBefore(el, sections[position]);
    } else {
      const footer = body.querySelector('[data-sec="footer"]');
      if (footer) body.insertBefore(el, footer);
      else body.appendChild(el);
    }

    const newHtml = dom.serialize();
    db.prepare(`UPDATE sites SET html = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(newHtml, site.id);
    res.json({ success: true, html: newHtml });
  } catch (e) { console.error("[/:siteId/section/add]", e?.message || e); res.status(500).json({ error: "An internal error occurred" }); }
});

router.post('/:siteId/section/remove', auth, (req, res) => {
  try {
    const db = req.app.locals.db;
    const site = getSite(db, req.params.siteId, req.user.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const { index } = req.body || {};
    if (typeof index !== 'number') return res.status(400).json({ error: 'index (number) required' });

    snapshot(db, site.id, site.html, 'before-section-remove');

    const dom = new (lazyJsdom())(site.html);
    const sections = dom.window.document.querySelectorAll('.mine-section');
    if (!sections[index]) return res.status(400).json({ error: 'Section not found at index ' + index });
    sections[index].remove();

    const newHtml = dom.serialize();
    db.prepare(`UPDATE sites SET html = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(newHtml, site.id);
    res.json({ success: true, html: newHtml });
  } catch (e) { console.error("[/:siteId/section/remove]", e?.message || e); res.status(500).json({ error: "An internal error occurred" }); }
});

router.post('/:siteId/section/reorder', auth, (req, res) => {
  try {
    const db = req.app.locals.db;
    const site = getSite(db, req.params.siteId, req.user.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const { fromIndex, toIndex } = req.body || {};
    if (typeof fromIndex !== 'number' || typeof toIndex !== 'number') {
      return res.status(400).json({ error: 'fromIndex and toIndex required' });
    }

    snapshot(db, site.id, site.html, 'before-reorder');

    const dom = new (lazyJsdom())(site.html);
    const sections = Array.from(dom.window.document.querySelectorAll('.mine-section'));
    if (!sections[fromIndex] || fromIndex === toIndex) {
      return res.status(400).json({ error: 'Invalid indices' });
    }
    const moved = sections[fromIndex];
    const target = sections[toIndex];
    if (fromIndex < toIndex) target.after(moved); else target.before(moved);

    const newHtml = dom.serialize();
    db.prepare(`UPDATE sites SET html = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(newHtml, site.id);
    res.json({ success: true, html: newHtml });
  } catch (e) { console.error("[/:siteId/section/reorder]", e?.message || e); res.status(500).json({ error: "An internal error occurred" }); }
});

// ─── 6. UNDO / REDO ─────────────────────────────────────────────────
router.get('/:siteId/versions', auth, (req, res) => {
  try {
    const db = req.app.locals.db;
    const site = getSite(db, req.params.siteId, req.user.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    ensureVersionsTable(db);
    const versions = db.prepare(`
      SELECT id, label, created_at FROM site_versions WHERE site_id = ? ORDER BY id DESC LIMIT 50
    `).all(site.id);
    res.json({ versions });
  } catch (e) { res.json({ versions: [] }); }
});

router.post('/:siteId/undo', auth, (req, res) => {
  try {
    const db = req.app.locals.db;
    const site = getSite(db, req.params.siteId, req.user.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const prev = db.prepare(`SELECT * FROM site_versions WHERE site_id = ? AND label != 'redo-point' ORDER BY id DESC LIMIT 1`).get(site.id);
    if (!prev) return res.status(400).json({ error: 'Nothing to undo' });

    // Save current as redo point
    db.prepare(`INSERT INTO site_versions (site_id, html, label) VALUES (?, ?, 'redo-point')`).run(site.id, site.html);
    db.prepare(`UPDATE sites SET html = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(prev.html, site.id);
    db.prepare(`DELETE FROM site_versions WHERE id = ?`).run(prev.id);

    res.json({ success: true, html: prev.html });
  } catch (e) { console.error("[/:siteId/undo]", e?.message || e); res.status(500).json({ error: "An internal error occurred" }); }
});

router.post('/:siteId/redo', auth, (req, res) => {
  try {
    const db = req.app.locals.db;
    const site = getSite(db, req.params.siteId, req.user.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const redoVer = db.prepare(`SELECT * FROM site_versions WHERE site_id = ? AND label = 'redo-point' ORDER BY id DESC LIMIT 1`).get(site.id);
    if (!redoVer) return res.status(400).json({ error: 'Nothing to redo' });

    snapshot(db, site.id, site.html, 'before-redo');
    db.prepare(`UPDATE sites SET html = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(redoVer.html, site.id);
    db.prepare(`DELETE FROM site_versions WHERE id = ?`).run(redoVer.id);

    res.json({ success: true, html: redoVer.html });
  } catch (e) { console.error("[/:siteId/redo]", e?.message || e); res.status(500).json({ error: "An internal error occurred" }); }
});

router.post('/:siteId/restore/:versionId', auth, (req, res) => {
  try {
    const db = req.app.locals.db;
    const site = getSite(db, req.params.siteId, req.user.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    const ver = db.prepare(`SELECT * FROM site_versions WHERE id = ? AND site_id = ?`).get(req.params.versionId, site.id);
    if (!ver) return res.status(404).json({ error: 'Version not found' });
    snapshot(db, site.id, site.html, 'before-restore');
    db.prepare(`UPDATE sites SET html = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(ver.html, site.id);
    res.json({ success: true, html: ver.html });
  } catch (e) { console.error("[/:siteId/restore/:versionId]", e?.message || e); res.status(500).json({ error: "An internal error occurred" }); }
});

module.exports = router;
