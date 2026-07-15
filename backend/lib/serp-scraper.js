/**
 * lib/serp-scraper.js
 * Fetches Google SERP results. SerpAPI primary; Bing HTML fallback if no SerpAPI key.
 *
 * Usage:
 *   const { fetchSERP, fetchCompetitorPage } = require("../lib/serp-scraper");
 *   const results = await fetchSERP("yoga brisbane", { location: "Brisbane,AU", num: 5 });
 *   // → [{ rank, url, title, snippet, displayUrl }, ...]
 *
 *   const page = await fetchCompetitorPage(url);
 *   // → { url, statusCode, title, metaDescription, h1, h2s, wordCount, schemaTypes, internalLinks }
 */

const SERPAPI_KEY = process.env.SERPAPI_KEY || "";

// ─── 1. SERP fetch ───────────────────────────────────────────────────────
async function fetchSERP(keyword, opts) {
  opts = opts || {};
  const num = Math.min(opts.num || 5, 10);
  const location = opts.location || "United States";

  if (SERPAPI_KEY) {
    return _fetchViaSerpAPI(keyword, { num, location });
  }
  // Fallback: scrape Bing HTML directly (Google blocks; Bing is permissive)
  return _fetchViaBing(keyword, { num });
}

async function _fetchViaSerpAPI(keyword, { num, location }) {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("q", keyword);
  url.searchParams.set("location", location);
  url.searchParams.set("num", String(num));
  url.searchParams.set("engine", "google");
  url.searchParams.set("api_key", SERPAPI_KEY);

  const r = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("SerpAPI HTTP " + r.status);
  const data = await r.json();
  const organic = data.organic_results || [];
  return organic.slice(0, num).map((item, idx) => ({
    rank: item.position || (idx + 1),
    url: item.link,
    title: item.title || "",
    snippet: item.snippet || "",
    displayUrl: item.displayed_link || item.link
  }));
}

async function _fetchViaBing(keyword, { num }) {
  const url = "https://www.bing.com/search?q=" + encodeURIComponent(keyword) + "&count=" + num;
  const r = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; MineSEOAgent/1.0)",
      "Accept": "text/html"
    }
  });
  if (!r.ok) throw new Error("Bing HTTP " + r.status);
  const html = await r.text();

  // Crude but effective: extract organic results from Bing's b_algo blocks
  const results = [];
  const blockRegex = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  let rank = 1;
  while ((m = blockRegex.exec(html)) !== null && results.length < num) {
    const block = m[1];
    const titleMatch = block.match(/<h2>\s*<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    const url = titleMatch[1];
    const title = titleMatch[2].replace(/<[^>]+>/g, "").trim();
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim() : "";
    results.push({ rank, url, title, snippet, displayUrl: url });
    rank++;
  }
  return results;
}

// ─── 2. Competitor page fetcher ──────────────────────────────────────────
async function fetchCompetitorPage(url) {
  const result = {
    url,
    statusCode: 0,
    title: "",
    metaDescription: "",
    h1: "",
    h2s: [],
    wordCount: 0,
    schemaTypes: [],
    internalLinks: 0,
    error: null
  };
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MineSEOAgent/1.0)",
        "Accept": "text/html"
      },
      redirect: "follow"
    });
    result.statusCode = r.status;
    if (!r.ok) { result.error = "HTTP " + r.status; return result; }
    const html = await r.text();

    // Title
    const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleM) result.title = _decode(titleM[1].replace(/<[^>]+>/g, "").trim()).slice(0, 200);

    // Meta description
    const metaM = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
               || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
    if (metaM) result.metaDescription = _decode(metaM[1]).slice(0, 500);

    // H1
    const h1M = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1M) result.h1 = _decode(h1M[1].replace(/<[^>]+>/g, "").trim()).slice(0, 200);

    // H2s
    const h2Regex = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
    let h;
    while ((h = h2Regex.exec(html)) !== null) {
      const txt = _decode(h[1].replace(/<[^>]+>/g, "").trim()).slice(0, 120);
      if (txt && result.h2s.length < 20) result.h2s.push(txt);
    }

    // Word count — strip tags and count words
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    result.wordCount = text.split(" ").filter(w => w.length > 0).length;

    // Schema.org markup
    const schemaRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let s;
    while ((s = schemaRegex.exec(html)) !== null) {
      try {
        const parsed = JSON.parse(s[1].trim());
        const types = _extractSchemaTypes(parsed);
        types.forEach(t => { if (result.schemaTypes.indexOf(t) === -1) result.schemaTypes.push(t); });
      } catch (_) { /* invalid JSON-LD */ }
    }

    // Internal link count — approximate (links to same host)
    const hostname = new URL(url).hostname;
    const linkRegex = /<a [^>]*href=["']([^"']+)["']/gi;
    let l, internal = 0;
    while ((l = linkRegex.exec(html)) !== null) {
      const href = l[1];
      if (href.startsWith("/") || href.indexOf(hostname) !== -1) internal++;
    }
    result.internalLinks = internal;

  } catch (e) {
    result.error = e.message || "fetch failed";
  }
  return result;
}

function _decode(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function _extractSchemaTypes(obj) {
  const out = [];
  function walk(o) {
    if (!o) return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (typeof o !== "object") return;
    if (o["@type"]) {
      if (Array.isArray(o["@type"])) o["@type"].forEach(t => out.push(t));
      else out.push(o["@type"]);
    }
    if (o["@graph"]) walk(o["@graph"]);
  }
  walk(obj);
  return out;
}

module.exports = { fetchSERP, fetchCompetitorPage };
