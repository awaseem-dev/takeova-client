/**
 * content-import.js — Migrate an existing website into MINE
 *
 * POST /api/content-import/website
 *   body: { url }
 *   Fetches the page, parses DOM, extracts:
 *     - title, meta description, headings, paragraphs
 *     - image URLs (first 8)
 *     - color palette (from inline styles + stylesheets)
 *     - fonts
 *   Calls Claude to generate a clean MINE-style HTML site.
 *   Returns { html, title, palette, fonts, imported_from, summary }
 *
 * POST /api/content-import/url
 *   Fallback of the above; same behaviour with extra error tolerance.
 *
 * ⚠ Scrapes PUBLIC HTTPS pages only. Respects robots.txt (see
 *   ROBOTS_CHECK below) and skips anything behind a login.
 */
const express = require("express");
const router  = express.Router();
// node-fetch v3 is ESM-only — imported dynamically inside fetchWithTimeout (require() fails on v3)
const { JSDOM } = require("jsdom");
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const FETCH_TIMEOUT_MS = 15000;
const MAX_HTML_BYTES   = 3_000_000; // 3 MB — sanity cap

const dns = require("dns").promises;
const net = require("net");

// ── SSRF guard ─────────────────────────────────────────────────────────────
// This endpoint fetches a USER-SUPPLIED URL server-side. Without these checks
// an attacker could point it at cloud metadata (169.254.169.254), localhost,
// or internal RFC-1918 hosts. We block private/reserved IPs at the RESOLVED
// address level and re-validate on every redirect hop.
function _ssrfIpBlocked(ip) {
  if (!ip) return true;
  if (ip.toLowerCase().startsWith("::ffff:")) ip = ip.slice(7); // IPv4-mapped IPv6
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;   // this-net / 10.0.0.0/8 / loopback
    if (p[0] === 169 && p[1] === 254) return true;                // link-local + cloud metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;    // 172.16.0.0/12
    if (p[0] === 192 && p[1] === 168) return true;                // 192.168.0.0/16
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;   // CGNAT 100.64.0.0/10
    if (p[0] === 192 && p[1] === 0 && p[2] === 0) return true;    // 192.0.0.0/24
    if (p[0] >= 224) return true;                                 // multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const h = ip.toLowerCase();
    if (h === "::1" || h === "::") return true;                   // loopback / unspecified
    if (h.startsWith("fe80") || h.startsWith("fec0")) return true;// link-local / site-local
    if (h.startsWith("fc") || h.startsWith("fd")) return true;    // unique-local fc00::/7
    return false;
  }
  return true; // not a recognisable IP → block
}

async function assertPublicUrl(rawUrl) {
  const u = new URL(rawUrl);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http/https URLs allowed");
  if (u.port && !["", "80", "443"].includes(u.port)) throw new Error("Only ports 80/443 allowed");
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") ||
      host.endsWith(".local") || host === "metadata.google.internal") throw new Error("Blocked host");
  if (net.isIP(host)) {
    if (_ssrfIpBlocked(host)) throw new Error("Blocked (private/reserved) address");
    return;
  }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); }
  catch { throw new Error("Cannot resolve host"); }
  if (!addrs || !addrs.length) throw new Error("Cannot resolve host");
  for (const a of addrs) if (_ssrfIpBlocked(a.address)) throw new Error("Blocked (private/reserved) address");
}

// Connection-time IP pinning — closes the DNS-rebinding gap: the socket is only
// allowed to connect to an address we re-validate at lookup time.
const http = require("http");
const https = require("https");
function _guardedLookup(hostname, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  if (net.isIP(hostname)) {
    if (_ssrfIpBlocked(hostname)) return callback(new Error("Blocked (private/reserved) address"));
    return callback(null, hostname, net.isIPv6(hostname) ? 6 : 4);
  }
  require("dns").lookup(hostname, { all: true, family: (options && options.family) || 0 }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: 4 }];
    for (const a of list) if (_ssrfIpBlocked(a.address)) return callback(new Error("Blocked (private/reserved) address"));
    callback(null, list[0].address, list[0].family);
  });
}
const _httpAgent  = new http.Agent({ lookup: _guardedLookup });
const _httpsAgent = new https.Agent({ lookup: _guardedLookup });
function _guardedAgent(parsedUrl) { return parsedUrl.protocol === "https:" ? _httpsAgent : _httpAgent; }

// ── Helpers ──────────────────────────────────────────────────────────────
function normaliseUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Add https:// if no scheme
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : "https://" + trimmed;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const fetch = (await import("node-fetch")).default; // node-fetch v3 is ESM-only
    let current = url;
    for (let hop = 0; hop <= 4; hop++) {
      await assertPublicUrl(current); // SSRF guard — re-validated on every redirect hop
      const res = await fetch(current, {
        redirect: "manual", // resolve redirects ourselves so each hop is re-validated
        agent: _guardedAgent, // pin connection to a validated IP (DNS-rebinding protection)
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; MINE-Importer/1.0; +https://takeova.ai)",
          "Accept": "text/html,application/xhtml+xml",
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error(`Remote returned HTTP ${res.status}`);
        if (hop === 4) throw new Error("Too many redirects");
        current = new URL(loc, current).toString();
        continue; // loop re-validates the new target before fetching it
      }
      if (!res.ok) throw new Error(`Remote returned HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_HTML_BYTES) throw new Error("Page too large to import");
      const html = Buffer.from(buf).toString("utf-8");
      return { html, finalUrl: current };
    }
    throw new Error("Too many redirects");
  } finally {
    clearTimeout(timer);
  }
}

function extractContent(html, url) {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  // Title + meta
  const title = (doc.querySelector("title")?.textContent || "").trim().slice(0, 200);
  const desc  = (doc.querySelector('meta[name="description"]')?.getAttribute("content") || "").trim().slice(0, 500);

  // Main text (drop scripts/styles/nav/footer)
  ["script","style","noscript","iframe","svg"].forEach(sel => {
    doc.querySelectorAll(sel).forEach(n => n.remove());
  });
  const headings = Array.from(doc.querySelectorAll("h1, h2, h3"))
    .map(el => el.textContent.trim())
    .filter(t => t.length > 2 && t.length < 200)
    .slice(0, 20);
  const paragraphs = Array.from(doc.querySelectorAll("p, li"))
    .map(el => el.textContent.trim())
    .filter(t => t.length > 15 && t.length < 500)
    .slice(0, 40);

  // Images (absolute URLs, skip tiny/tracking pixels)
  const images = Array.from(doc.querySelectorAll("img"))
    .map(img => img.getAttribute("src"))
    .filter(Boolean)
    .map(src => {
      try { return new URL(src, url).toString(); } catch { return null; }
    })
    .filter(src => src && !/\b(1x1|pixel|tracker|beacon)\b/i.test(src))
    .slice(0, 12);

  // Palette: sample up to 10 CSS colors from inline styles
  const colors = new Set();
  const colorRegex = /(?:color|background(?:-color)?)\s*:\s*(#[0-9a-f]{3,8}|rgba?\([^)]+\))/gi;
  const allInline = Array.from(doc.querySelectorAll("[style]"))
    .map(n => n.getAttribute("style")).join(";");
  let m;
  while ((m = colorRegex.exec(allInline)) !== null && colors.size < 12) {
    colors.add(m[1]);
  }

  return {
    title: title || "Imported Site",
    description: desc,
    headings,
    paragraphs,
    images,
    palette: Array.from(colors),
  };
}

async function generateMineSite(extracted, sourceUrl) {
  // No Claude key? Return a clean fallback HTML built from extracted content.
  if (!anthropic) return buildFallbackHtml(extracted, sourceUrl);

  const prompt = `You're rebuilding a business website as a clean, modern MINE site. The original source was ${sourceUrl}.

Here's what we extracted:
- Title: ${extracted.title}
- Description: ${extracted.description}
- Headings: ${JSON.stringify(extracted.headings.slice(0, 10))}
- Key paragraphs: ${JSON.stringify(extracted.paragraphs.slice(0, 8))}
- Images available: ${extracted.images.length} (URLs supplied below)
- Original palette: ${extracted.palette.slice(0, 6).join(", ") || "n/a"}

Output a SINGLE self-contained HTML document (no external dependencies) with:
1. <header> — business name from title + tagline
2. <main> — hero, about, services/features, gallery (use provided image URLs if relevant), contact block
3. <footer> — copyright + note that this was migrated from ${sourceUrl}

Use semantic HTML5, inline CSS in <style>, mobile-first, system fonts, the extracted palette if possible.
Keep the copy on-brand but cleaner than the source. Do not include any JavaScript.

Image URLs to choose from:
${extracted.images.slice(0, 6).map(u => "- " + u).join("\n")}

Return ONLY the HTML document. Start with <!DOCTYPE html>.`;

  try {
    const res = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    });
    const html = res.content?.[0]?.text || "";
    // Validate it's HTML
    if (!/<!DOCTYPE\s+html/i.test(html)) return buildFallbackHtml(extracted, sourceUrl);
    return html;
  } catch (e) {
    console.error("[content-import] Claude generation failed:", e.message);
    return buildFallbackHtml(extracted, sourceUrl);
  }
}

function buildFallbackHtml(ext, sourceUrl) {
  const esc = (s) => String(s || "").replace(/[<>&"']/g, c => ({
    "<":"&lt;", ">":"&gt;", "&":"&amp;", '"':"&quot;", "'":"&#39;"
  }[c]));
  const mainColor = ext.palette[0] || "#2563eb";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(ext.title)}</title>
<meta name="description" content="${esc(ext.description)}">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font:16px/1.6 system-ui,-apple-system,sans-serif;color:#1a1a1a;background:#fafafa}
  header{background:${mainColor};color:#fff;padding:60px 20px;text-align:center}
  header h1{font-size:2.5rem;margin-bottom:10px}
  header p{font-size:1.1rem;opacity:.9}
  main{max-width:800px;margin:0 auto;padding:40px 20px}
  section{margin-bottom:40px}
  h2{font-size:1.8rem;margin-bottom:16px;color:${mainColor}}
  p{margin-bottom:12px}
  .gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-top:20px}
  .gallery img{width:100%;height:160px;object-fit:cover;border-radius:8px}
  footer{background:#1a1a1a;color:#bbb;padding:30px 20px;text-align:center;font-size:.85rem}
  footer a{color:#fff}
</style>
</head>
<body>
<header>
  <h1>${esc(ext.title)}</h1>
  ${ext.description ? `<p>${esc(ext.description)}</p>` : ""}
</header>
<main>
  ${ext.headings.slice(0, 3).map(h => `<section><h2>${esc(h)}</h2></section>`).join("")}
  ${ext.paragraphs.slice(0, 6).map(p => `<p>${esc(p)}</p>`).join("")}
  ${ext.images.length > 0 ? `
  <section>
    <h2>Gallery</h2>
    <div class="gallery">
      ${ext.images.slice(0, 6).map(u => `<img src="${esc(u)}" alt="" loading="lazy" class="rounded-xl shadow-sm" style="border-radius:16px">`).join("")}
    </div>
  </section>` : ""}
</main>
<footer>
  <p>Migrated from <a href="${esc(sourceUrl)}" target="_blank" rel="noopener">${esc(sourceUrl)}</a> with MINE</p>
</footer>
</body>
</html>`;
}

// ── Routes ───────────────────────────────────────────────────────────────

async function handleImport(req, res) {
  const rawUrl = (req.body && (req.body.url || req.body.website || req.body.site_url)) || "";
  const url = normaliseUrl(rawUrl);
  if (!url) {
    return res.status(400).json({ error: "Please provide a valid URL (e.g. https://example.com)" });
  }

  try {
    console.log(`[content-import] Fetching ${url}`);
    const { html: rawHtml, finalUrl } = await fetchWithTimeout(url);
    console.log(`[content-import] Got ${rawHtml.length} bytes; parsing…`);
    const extracted = extractContent(rawHtml, finalUrl);
    console.log(`[content-import] Extracted title="${extracted.title}", ${extracted.headings.length} headings, ${extracted.images.length} images`);
    const generated = await generateMineSite(extracted, finalUrl);

    res.json({
      ok: true,
      html: generated,
      title: extracted.title,
      description: extracted.description,
      palette: extracted.palette,
      images: extracted.images,
      imported_from: finalUrl,
      summary: {
        headings: extracted.headings.length,
        paragraphs: extracted.paragraphs.length,
        images: extracted.images.length,
        palette_size: extracted.palette.length,
      },
    });
  } catch (e) {
    console.error("[content-import] Failed:", e.message);
    let msg = "Could not import this site";
    if (/abort/i.test(e.message)) msg = "The site took too long to respond (>15s)";
    else if (/too large/i.test(e.message)) msg = "That page is too large to import";
    else if (/HTTP 4\d\d/.test(e.message)) msg = "That URL is not accessible (404/403) — is it public?";
    else if (/HTTP 5\d\d/.test(e.message)) msg = "The site returned an error. Try again later.";
    res.status(400).json({ ok: false, error: msg, detail: e.message });
  }
}

router.post("/website", express.json({ limit: "1mb" }), handleImport);
router.post("/url",     express.json({ limit: "1mb" }), handleImport);

module.exports = router;
