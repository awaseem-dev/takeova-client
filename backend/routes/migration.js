/**
 * MINE Migration Wizard — backend route
 *
 * Handles the full site migration flow:
 *   POST /api/migration/analyse    — scrape URL, detect platform, extract content
 *   POST /api/migration/rebuild    — AI rebuilds site from extracted content
 *   POST /api/migration/import-products — import products (Shopify API or CSV)
 *   POST /api/migration/import-contacts — import contacts/customers (CSV or Shopify)
 *   POST /api/migration/import-shopify-orders — import historical orders from Shopify
 *   POST /api/migration/mailchimp/lists — fetch user's Mailchimp lists
 *   POST /api/migration/mailchimp/import — import members from a Mailchimp list
 *   POST /api/migration/status     — get migration record status
 *   GET  /api/migration/history    — list past migrations for this user
 */

"use strict";
const express = require("express");
const router  = express.Router();
const { v4: uuid } = require("uuid");
const { getDb } = require("../db/init");
const { auth }  = require("../middleware/auth");
const { getSetting } = require("./integrations");

// ── Per-user rate limiter for expensive import endpoints ─────────────────
// In-memory map of userId → last-call timestamps. Allows N calls per windowMs.
// Resets on server restart (acceptable for production — daily restart cycle).
const _rateLimits = new Map();
function rateLimit({ windowMs, max }) {
  return function(req, res, next) {
    const key = String(req.userId || req.ip || "anon");
    const now = Date.now();
    const arr = _rateLimits.get(key) || [];
    const recent = arr.filter(t => t > now - windowMs);
    if (recent.length >= max) {
      const retrySec = Math.ceil((recent[0] + windowMs - now) / 1000);
      res.set("Retry-After", String(retrySec));
      return res.status(429).json({ error: `Too many import requests. Try again in ${retrySec}s.` });
    }
    recent.push(now);
    _rateLimits.set(key, recent);
    // Cleanup occasionally — drop empty / old entries
    if (Math.random() < 0.01) {
      for (const [k, v] of _rateLimits) {
        if (v.every(t => t < now - windowMs)) _rateLimits.delete(k);
      }
    }
    next();
  };
}
// Bursts of 5 imports per 5 minutes are plenty for legitimate use.
const importRateLimit = rateLimit({ windowMs: 5 * 60 * 1000, max: 5 });

// ── Ensure migrations table ───────────────────────────────────────────────────
function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      source_url    TEXT,
      platform      TEXT,
      status        TEXT DEFAULT 'started',
      site_id       TEXT,
      products_imported INTEGER DEFAULT 0,
      contacts_imported INTEGER DEFAULT 0,
      orders_imported   INTEGER DEFAULT 0,
      notes         TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mig_user ON migrations(user_id);
  `);
}

// ── Platform detector ─────────────────────────────────────────────────────────
function detectPlatform(html, url) {
  const h = (html || "").toLowerCase();
  const u = (url  || "").toLowerCase();
  if (h.includes("shopify") || u.includes("myshopify.com") || h.includes("cdn.shopify")) return "shopify";
  if (h.includes("squarespace") || h.includes("sqsp.net") || u.includes("squarespace.com")) return "squarespace";
  if (h.includes("wix.com") || h.includes("wixsite") || u.includes("wix.com")) return "wix";
  if (h.includes("kajabi") || u.includes("kajabi.com") || h.includes("kajabi-content")) return "kajabi";
  if (h.includes("wp-content") || h.includes("wordpress") || h.includes("wp-json")) return "wordpress";
  if (h.includes("webflow") || u.includes("webflow.io")) return "webflow";
  if (h.includes("bigcommerce") || u.includes("bigcommerce.com")) return "bigcommerce";
  if (h.includes("weebly") || u.includes("weebly.com")) return "weebly";
  return "other";
}

// ── Content extractor ─────────────────────────────────────────────────────────
function extractContent(html, url) {
  const titleM  = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const descM   = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
  const ogDescM = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
  const ogImgM  = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);

  const title   = titleM?.[1]?.trim() || "";
  const desc    = descM?.[1]?.trim() || ogDescM?.[1]?.trim() || "";

  // Extract text
  const bodyM = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body  = bodyM ? bodyM[1] : html;
  const text  = body
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 4000);

  // Headings
  const heads = [...html.matchAll(/<h[1-3][^>]*>([^<]+)<\/h[1-3]>/gi)]
    .slice(0, 10).map(m => m[1].replace(/<[^>]+>/g, "").trim()).filter(Boolean);

  // Images
  const base = (() => { try { const u = new URL(url.startsWith("http") ? url : "https://"+url); return u.origin; } catch(e) { return ""; } })();
  const imgs = [...html.matchAll(/<img[^>]*src=["']([^"']+)["']/gi)]
    .map(m => {
      let s = m[1];
      if (s.startsWith("//")) s = "https:" + s;
      else if (s.startsWith("/") && base) s = base + s;
      return s;
    })
    .filter(s => s.startsWith("http") && !s.includes("pixel") && !s.includes("tracking") && !s.includes("1x1"))
    .slice(0, 12);

  // Colours from CSS
  const colourRe = /(?:background(?:-color)?|color)\s*:\s*(#[0-9a-f]{3,6}|rgba?\([^)]+\))/gi;
  const colours  = [...new Set([...html.matchAll(colourRe)].map(m => m[1]))].slice(0, 6);

  // Nav links
  const navs = [...new Set([...html.matchAll(/<a[^>]*>([^<]{2,30})<\/a>/gi)]
    .map(m => m[1].trim())
    .filter(l => l.length > 1 && l.length < 30))].slice(0, 10);

  // Price hints — suggests e-commerce
  const prices = [...html.matchAll(/\$\s*(\d+(?:\.\d{2})?)/g)].slice(0, 10).map(m => "$" + m[1]);

  // OG image
  const heroImage = ogImgM?.[1] || imgs[0] || "";

  return { title, desc, text, heads, imgs, colours, navs, prices, heroImage };
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 1 — Analyse URL: detect platform, extract content, return insights
// ════════════════════════════════════════════════════════════════════════════
router.post("/analyse", auth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL required" });

  const db = getDb();
  ensureTables(db);

  const fetch = (await import("node-fetch")).default;

  let html = "";
  try {
    const r = await fetch(url.startsWith("http") ? url : "https://" + url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MINE-Migrator/1.0)" },
      timeout: 15000,
      redirect: "follow",
      size: 5 * 1024 * 1024, // 5MB max
    });
    html = await r.text();
  } catch (e) {
    return res.status(400).json({ error: "Could not reach that URL. Make sure it's publicly accessible.", details: e.message });
  }

  const platform = detectPlatform(html, url);
  const content  = extractContent(html, url);

  // Create migration record
  const migId = uuid();
  db.prepare(`INSERT INTO migrations (id, user_id, source_url, platform, status) VALUES (?,?,?,?,?)`)
    .run(migId, req.userId, url, platform, "analysed");

  res.json({
    migrationId: migId,
    platform,
    content,
    // What we can import per platform
    capabilities: {
      siteRebuild:     true,
      productImport:   ["shopify", "bigcommerce", "woocommerce"].includes(platform) || content.prices.length > 0,
      contactImport:   true, // always via CSV
      shopifyDirect:   platform === "shopify",
      csvAvailable:    true,
      estimatedTime:   "2-5 minutes",
    },
    hint: platform === "shopify"
      ? "We found a Shopify store. Connect your Shopify Admin API to import all products, customers and orders automatically."
      : platform === "kajabi"
      ? "We found a Kajabi site. Export your contacts and products as CSV from Kajabi and import them here."
      : platform === "wix" || platform === "squarespace"
      ? "We found a " + platform + " site. We'll rebuild your design automatically. Export your contacts CSV from " + platform + " to bring your audience across."
      : "We found your website. We'll rebuild the design automatically. Bring your contacts across by uploading a CSV.",
  });
});

// ════════════════════════════════════════════════════════════════════════════
// STEP 2 — AI rebuilds the site from extracted content
// ════════════════════════════════════════════════════════════════════════════
router.post("/rebuild", auth, async (req, res) => {
  const { migrationId, content, platform, customInstructions } = req.body;
  if (!content) return res.status(400).json({ error: "Content required" });

  const db = getDb();
  ensureTables(db);

  const apiKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(400).json({ error: "Anthropic API key not configured" });

  const fetch = (await import("node-fetch")).default;

  const platformNote = {
    shopify:     "This was a Shopify store — preserve the e-commerce feel.",
    squarespace: "This was a Squarespace site — preserve the clean, editorial aesthetic.",
    wix:         "This was a Wix site — significantly upgrade the design quality.",
    kajabi:      "This was a Kajabi site — preserve the course/coaching feel.",
    wordpress:   "This was a WordPress site — clean up and modernise significantly.",
    webflow:     "This was a Webflow site — preserve the premium, animated feel.",
  }[platform] || "Rebuild as a modern, premium small business site.";

  const prompt = `You are a world-class web designer rebuilding a business website as a beautiful, modern, mobile-first site.

ORIGINAL SITE DATA:
- Business name: ${content.title}
- Description: ${content.desc}
- Headings found: ${content.heads?.join(", ")}
- Nav items: ${content.navs?.join(", ")}
- Content: ${(content.text || "").substring(0, 2500)}
- Images available: ${content.imgs?.slice(0, 6).join(", ")}
- Brand colours detected: ${content.colours?.join(", ") || "none detected — choose a professional palette"}
- Prices found: ${content.prices?.join(", ") || "none"}

DESIGN BRIEF:
${platformNote}
${customInstructions ? "Additional instructions: " + customInstructions : ""}

RULES:
- Output ONLY complete, self-contained HTML with all CSS inline or in a <style> block. No markdown, no explanation, nothing else.
- Mobile-first responsive using clamp(), flexbox, CSS grid
- No fixed widths over 400px — use max-width, %, and clamp()
- Beautiful hero section with the business name prominently featured
- Sticky navigation header
- Clear sections for: hero, about/services, products/pricing if relevant, contact/CTA, footer
- Professional typography — use Google Fonts (Bricolage Grotesque or Inter)
- Use the detected brand colours where appropriate — if none, choose a tasteful modern palette
- Include all original images where they fit naturally
- Add a prominent CTA button in the hero
- Footer with business name and basic links
- Make it look genuinely premium — this should be BETTER than what they had`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 8000,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const d = await r.json();
    let html = d.content?.[0]?.text || "";
    html = html.replace(/```html\n?/g, "").replace(/```\n?/g, "").trim();

    if (!html) return res.status(500).json({ error: "AI did not return HTML" });

    // Update migration record
    if (migrationId) {
      db.prepare("UPDATE migrations SET status='rebuilt', updated_at=datetime('now') WHERE id=? AND user_id=?")
        .run(migrationId, req.userId);
    }

    res.json({ success: true, html, migrationId });
  } catch (e) {
    console.error("[Migration] Rebuild error:", e.message);
    res.status(500).json({ error: 'An internal error occurred' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// STEP 3a — Import products from Shopify API
// ════════════════════════════════════════════════════════════════════════════
router.post("/import-shopify", auth, async (req, res) => {
  const { shopDomain, accessToken, migrationId } = req.body;
  if (!shopDomain || !accessToken) return res.status(400).json({ error: "shopDomain and accessToken required" });

  const db = getDb();
  ensureTables(db);

  const fetch = (await import("node-fetch")).default;
  const clean = shopDomain.replace(/https?:\/\//, "").replace(/\/+$/, "").split("/")[0];
  if (!/^[a-zA-Z0-9][a-zA-Z0-9\-\.]{0,61}[a-zA-Z0-9]?\.[a-zA-Z]{2,}$/.test(clean)) {
    return res.status(400).json({ error: "Invalid Shopify domain format" });
  }
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|::1)/i.test(clean) ||
      /^(metadata\.google\.internal|169\.254\.169\.254)/.test(clean)) {
    return res.status(400).json({ error: "Invalid Shopify domain" });
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9\-\.]{0,61}[a-zA-Z0-9]?\.[a-zA-Z]{2,}$/.test(clean)) {
    return res.status(400).json({ error: "Invalid Shopify domain" });
  }

  try {
    const headers = { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" };
    const base    = `https://${clean}/admin/api/2024-01`;

    // Products
    const prodRes  = await fetch(`${base}/products.json?limit=250`, { headers });
    const prodData = await prodRes.json();
    if (!prodData.products) return res.status(400).json({ error: "Could not fetch products — check domain and token" });

    const products = prodData.products.map(sp => ({
      id: uuid(), name: sp.title,
      price: parseFloat(sp.variants?.[0]?.price) || 0,
      desc: (sp.body_html || "").replace(/<[^>]*>/g, "").substring(0, 500),
      image: sp.images?.[0]?.src || "",
      stock: sp.variants?.reduce((a, v) => a + (v.inventory_quantity || 0), 0) || 999,
      active: sp.status === "active",
      shopify_id: String(sp.id),
      imported_from: "shopify",
    }));

    // Customers
    const custRes  = await fetch(`${base}/customers.json?limit=250`, { headers });
    const custData = await custRes.json();
    const customers = (custData.customers || []).map(c => ({
      name: `${c.first_name || ""} ${c.last_name || ""}`.trim() || c.email,
      email: c.email, phone: c.phone || "",
      tags: ["shopify-import"], status: "customer",
      notes: `Imported from Shopify. Orders: ${c.orders_count}. Spent: $${c.total_spent}`,
    })).filter(c => c.email);

    // Orders count
    const ordRes  = await fetch(`${base}/orders.json?limit=1&status=any`, { headers });
    const ordData = await ordRes.json();
    const orderCount = ordData.orders?.length || 0;

    // Save contacts to DB
    let contactsImported = 0;
    const site = db.prepare("SELECT id FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
    for (const c of customers) {
      const exists = db.prepare("SELECT id FROM contacts WHERE user_id = ? AND email = ?").get(req.userId, c.email);
      if (!exists) {
        db.prepare(`INSERT INTO contacts (id, user_id, name, email, phone, status, source, tags, notes, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`)
          .run(uuid(), req.userId, c.name, c.email, c.phone, "customer", "shopify_import",
            JSON.stringify(c.tags), c.notes);
        contactsImported++;
      }
    }

    // Update migration record
    if (migrationId) {
      db.prepare(`UPDATE migrations SET status='products_imported', products_imported=?, contacts_imported=?, updated_at=datetime('now') WHERE id=? AND user_id=?`)
        .run(products.length, contactsImported, migrationId, req.userId);
    }

    res.json({
      success: true,
      products,
      stats: {
        productsFound: products.length,
        customersImported: contactsImported,
        customersSkipped: customers.length - contactsImported,
        orderCount,
      }
    });
  } catch (e) {
    console.error("[Migration] Shopify import error:", e.message);
    res.status(500).json({ error: 'An internal error occurred' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// STEP 3b — Import products from CSV (Shopify export format or custom)
// ════════════════════════════════════════════════════════════════════════════
router.post("/import-products-csv", auth, async (req, res) => {
  const { rows, migrationId } = req.body;
  // rows = array of objects from parsed CSV
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: "No product rows provided" });
  if (rows.length > 2000) return res.status(400).json({ error: "Maximum 2,000 products per import" });

  const db = getDb();
  ensureTables(db);

  // Map common CSV column names to our schema
  const map = (row) => {
    const name  = row["Title"] || row["Name"] || row["Product Name"] || row["name"] || row["title"] || "";
    const price = parseFloat(row["Variant Price"] || row["Price"] || row["price"] || "0") || 0;
    const desc  = (row["Body (HTML)"] || row["Description"] || row["desc"] || row["description"] || "").replace(/<[^>]*>/g, "").substring(0, 500);
    const image = row["Image Src"] || row["Image"] || row["image"] || row["image_url"] || "";
    const stock = parseInt(row["Variant Inventory Qty"] || row["Stock"] || row["stock"] || "999") || 999;
    const active = (row["Status"] || row["active"] || "active").toLowerCase() !== "draft";
    return name ? { id: uuid(), name, price, desc, image, stock, active, imported_from: "csv" } : null;
  };

  const products = rows.map(map).filter(Boolean);
  if (products.length === 0) return res.status(400).json({ error: "Could not map any rows to products. Check column names." });

  if (migrationId) {
    db.prepare("UPDATE migrations SET products_imported=?, updated_at=datetime('now') WHERE id=? AND user_id=?")
      .run(products.length, migrationId, req.userId);
  }

  res.json({ success: true, products, stats: { productsImported: products.length, rowsProcessed: rows.length } });
});

// ════════════════════════════════════════════════════════════════════════════
// STEP 4 — Save site + all imported data together
// ════════════════════════════════════════════════════════════════════════════
router.post("/save", auth, async (req, res) => {
  const { migrationId, siteName, html, products, contacts } = req.body;
  if (!siteName) return res.status(400).json({ error: "Site name required" });

  const db = getDb();
  ensureTables(db);

  const siteId = uuid();
  const siteData = JSON.stringify({
    products: products || [],
    heroHtml: html || "",
    importedAt: new Date().toISOString(),
  });

  try {
    db.prepare(`INSERT INTO sites (id, user_id, name, data, status, created_at, updated_at)
      VALUES (?,?,?,?,?,datetime('now'),datetime('now'))`)
      .run(siteId, req.userId, siteName, siteData, "draft");

    // Save contacts
    let contactsImported = 0;
    for (const c of (contacts || [])) {
      if (!c.email) continue;
      const exists = db.prepare("SELECT id FROM contacts WHERE user_id = ? AND email = ?").get(req.userId, c.email);
      if (!exists) {
        db.prepare(`INSERT INTO contacts (id, user_id, name, email, phone, status, source, tags, created_at)
          VALUES (?,?,?,?,?,?,?,?,datetime('now'))`)
          .run(uuid(), req.userId, c.name || c.email, c.email, c.phone || "",
            c.status || "lead", "migration", JSON.stringify(["migrated"]));
        contactsImported++;
      }
    }

    // Update migration record
    if (migrationId) {
      db.prepare(`UPDATE migrations SET status='complete', site_id=?, contacts_imported=?, updated_at=datetime('now') WHERE id=? AND user_id=?`)
        .run(siteId, contactsImported, migrationId, req.userId);
    }

    res.json({ success: true, siteId, contactsImported, productsImported: (products || []).length });
  } catch (e) {
    console.error("[Migration] Save error:", e.message);
    res.status(500).json({ error: 'An internal error occurred' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET — migration history
// ════════════════════════════════════════════════════════════════════════════
router.get("/history", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const history = db.prepare("SELECT * FROM migrations WHERE user_id = ? ORDER BY created_at DESC LIMIT 20").all(req.userId);
  res.json({ migrations: history });
});

// ════════════════════════════════════════════════════════════════════════════
// STEP 3c — Import ORDERS from Shopify (separate from products/customers
// because most stores have far more orders than products/customers — needs
// pagination + a higher cap)
// ════════════════════════════════════════════════════════════════════════════
//
// Maps Shopify order fields → MINE orders table:
//   - Shopify order.id          → stripe_session_id (prefixed "shopify_") for dedupe
//   - Shopify order_number      → order_number
//   - email + customer.name     → customer_email, customer_name
//   - line_items[]              → items (JSON array)
//   - total_price               → total
//   - financial_status          → status         (paid|pending|refunded|cancelled)
//   - fulfillment_status        → fulfillment_status
//   - shipping_address.{...}    → shipping_name, shipping_address (JSON)
//   - fulfillments[0].tracking_*→ tracking_number, tracking_url, carrier
//
// Pagination: Shopify uses cursor-based pagination via Link header (page_info).
// We honor it up to MAX_PAGES (20 = ~5000 orders) for safety.
//
// Dedupe: skip orders we've already imported (stripe_session_id collision).

router.post("/import-shopify-orders", auth, importRateLimit, async (req, res) => {
  let { shopDomain, accessToken, migrationId, maxOrders } = req.body;

  // Fall back to saved per-user Shopify credentials if not in body
  if (!shopDomain || !accessToken) {
    try {
      const { getSavedKey } = require("./user-integration-keys");
      const saved = getSavedKey(getDb(), req.userId, "shopify");
      if (saved?.apiKey) {
        accessToken = accessToken || saved.apiKey;
        shopDomain  = shopDomain  || saved.shopDomain;
      }
    } catch(_) {}
  }

  if (!shopDomain || !accessToken) return res.status(400).json({ error: "shopDomain and accessToken required (or save Shopify credentials in settings)" });

  // Reuse domain validation from import-shopify
  const clean = shopDomain.replace(/https?:\/\//, "").replace(/\/+$/, "").split("/")[0];
  if (!/^[a-zA-Z0-9][a-zA-Z0-9\-\.]{0,61}[a-zA-Z0-9]?\.[a-zA-Z]{2,}$/.test(clean)) {
    return res.status(400).json({ error: "Invalid Shopify domain format" });
  }
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|::1)/i.test(clean) ||
      /^(metadata\.google\.internal|169\.254\.169\.254)/.test(clean)) {
    return res.status(400).json({ error: "Invalid Shopify domain" });
  }

  const db = getDb();
  ensureTables(db);
  const fetch = (await import("node-fetch")).default;
  const headers = { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" };
  const cap = Math.min(parseInt(maxOrders) || 5000, 10000);

  // Hoist site lookup outside the loop — runs once instead of N times
  const site = db.prepare("SELECT id FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
  const siteId = site?.id || null;

  // Map Shopify financial_status → MINE status
  // SAFER default: null → "pending" (not "paid"). Draft orders / abandoned
  // checkouts / unknown statuses shouldn't be counted as completed revenue.
  function mapStatus(fin) {
    if (!fin) return "pending";
    if (fin === "paid" || fin === "partially_paid") return "paid";
    if (fin === "pending" || fin === "authorized") return "pending";
    if (fin === "refunded") return "refunded";
    if (fin === "partially_refunded") return "partially_refunded";
    if (fin === "voided") return "cancelled";
    return "pending"; // unknown future statuses → safe default
  }
  function mapFulfillment(f) {
    if (!f) return "unfulfilled";
    if (f === "fulfilled") return "fulfilled";
    if (f === "partial") return "partial";
    return "unfulfilled";
  }

  // Re-validate any pagination URL Shopify returns to prevent SSRF if their
  // Link header ever returns a URL pointing off-platform.
  function isValidShopifyPaginationUrl(u) {
    try {
      const parsed = new URL(u);
      return parsed.protocol === "https:" && parsed.hostname === clean;
    } catch(_) { return false; }
  }

  let url = `https://${clean}/admin/api/2024-01/orders.json?limit=250&status=any`;
  let pagesScanned = 0;
  let totalFetched = 0;
  let imported = 0;
  let skipped = 0;
  let totalRevenue = 0;
  const MAX_PAGES = 20;
  const startedAt = Date.now();

  try {
    while (pagesScanned < MAX_PAGES && totalFetched < cap) {
      const r = await fetch(url, { headers });
      if (!r.ok) {
        const errBody = await r.text();
        console.error("[Shopify orders] error", r.status, errBody.slice(0, 200));
        if (r.status === 401) return res.status(401).json({ error: "Shopify access token rejected" });
        return res.status(502).json({ error: `Shopify API returned ${r.status}` });
      }
      const data = await r.json();
      const orders = data.orders || [];
      if (orders.length === 0) break;

      for (const o of orders) {
        if (totalFetched >= cap) break;
        totalFetched++;

        const externalId = "shopify_" + String(o.id);
        const exists = db.prepare("SELECT id FROM orders WHERE user_id = ? AND stripe_session_id = ?").get(req.userId, externalId);
        if (exists) { skipped++; continue; }

        // Build items array from line_items
        const items = (o.line_items || []).map(li => ({
          name: li.title || li.name || "",
          variant: li.variant_title || "",
          quantity: li.quantity || 1,
          price: parseFloat(li.price) || 0,
          shopify_product_id: String(li.product_id || ""),
          shopify_variant_id: String(li.variant_id || ""),
          sku: li.sku || "",
        }));

        const shipping = o.shipping_address || {};
        const shippingAddrJson = JSON.stringify({
          address1: shipping.address1 || "",
          address2: shipping.address2 || "",
          city: shipping.city || "",
          province: shipping.province || "",
          country: shipping.country || "",
          zip: shipping.zip || "",
          phone: shipping.phone || "",
        });

        const fulfillment = (o.fulfillments && o.fulfillments[0]) || {};
        const tracking = fulfillment.tracking_number || "";
        const trackingUrl = fulfillment.tracking_url || "";
        const carrier = fulfillment.tracking_company || "";

        const customerName = o.customer
          ? `${o.customer.first_name || ""} ${o.customer.last_name || ""}`.trim() || (o.email || "")
          : (shipping.name || o.email || "");

        const total = parseFloat(o.total_price) || 0;
        const status = mapStatus(o.financial_status);
        const fStatus = mapFulfillment(o.fulfillment_status);

        // Preserve original Shopify created_at for accurate history
        const createdAt = o.created_at || new Date().toISOString();

        try {
          db.prepare(`INSERT INTO orders (
              id, site_id, user_id, order_number, customer_name, customer_email,
              items, total, shipping_name, shipping_address,
              status, fulfillment_status, tracking_number, tracking_url, carrier,
              stripe_session_id, notes, created_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(uuid(), siteId, req.userId, o.order_number || o.name || String(o.id),
              customerName, o.email || "",
              JSON.stringify(items), total,
              shipping.name || customerName, shippingAddrJson,
              status, fStatus, tracking, trackingUrl, carrier,
              externalId, `Imported from Shopify on ${new Date().toISOString().slice(0,10)}`,
              createdAt);
          imported++;
          if (status === "paid" || status === "partially_refunded") totalRevenue += total;
        } catch(insertErr) {
          console.error("[Shopify orders] insert failed for", externalId, insertErr.message);
          skipped++;
        }
      }

      // Cursor-based pagination via Link header
      const linkHeader = r.headers.get("link") || "";
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (!nextMatch) break;
      // Defense-in-depth: re-validate the URL Shopify returned still points
      // to the same Shopify domain. Prevents SSRF if Link header is ever
      // crafted to redirect us off-platform with the access token attached.
      if (!isValidShopifyPaginationUrl(nextMatch[1])) {
        console.error("[Shopify orders] pagination URL failed validation:", nextMatch[1].slice(0, 100));
        break;
      }
      url = nextMatch[1];
      pagesScanned++;

      // Rate-limit politeness: tiny pause between pages
      await new Promise(rs => setTimeout(rs, 100));
    }

    // Update migration record
    if (migrationId) {
      try {
        db.prepare("UPDATE migrations SET orders_imported=?, updated_at=datetime('now') WHERE id=? AND user_id=?")
          .run(imported, migrationId, req.userId);
      } catch(_) {
        // Column may not exist on older migrations table — add it
        try { db.exec("ALTER TABLE migrations ADD COLUMN orders_imported INTEGER DEFAULT 0"); } catch(_) {}
        try {
          db.prepare("UPDATE migrations SET orders_imported=?, updated_at=datetime('now') WHERE id=? AND user_id=?")
            .run(imported, migrationId, req.userId);
        } catch(_) {}
      }
    }

    // Log intelligence event so AI Insights picks up the historical revenue
    if (imported > 0) {
      try {
        const { logEvent } = require("./intelligence");
        logEvent(db, req.userId, "order_added", {
          count: imported, source: "shopify_import", totalRevenue,
        });
      } catch(_) {}
    }

    // Bump auto-sync state so the hourly cron doesn't re-fetch everything
    try {
      const credRow = db.prepare("SELECT meta FROM user_integration_keys WHERE user_id = ? AND service = 'shopify'").get(req.userId);
      if (credRow) {
        try { db.exec("ALTER TABLE user_integration_keys ADD COLUMN last_sync_at TEXT"); } catch(_) {}
        try { db.exec("ALTER TABLE user_integration_keys ADD COLUMN last_sync_status TEXT"); } catch(_) {}
        try { db.exec("ALTER TABLE user_integration_keys ADD COLUMN last_sync_count INTEGER"); } catch(_) {}
        try { db.exec("ALTER TABLE user_integration_keys ADD COLUMN consecutive_failures INTEGER DEFAULT 0"); } catch(_) {}
        db.prepare(`UPDATE user_integration_keys SET
                      last_used_at = datetime('now'),
                      last_sync_at = datetime('now'),
                      last_sync_status = 'ok',
                      last_sync_count = ?,
                      consecutive_failures = 0
                    WHERE user_id = ? AND service = 'shopify'`)
          .run(imported, req.userId);
      }
    } catch(_) {}

    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    res.json({
      ok: true,
      stats: {
        totalFetched, imported, skipped, pagesScanned, totalRevenue,
        elapsedSec: parseFloat(elapsedSec),
      },
    });
  } catch (e) {
    console.error("[Shopify orders] import failed:", e.message);
    res.status(500).json({ error: "Shopify order import failed" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// MAILCHIMP IMPORT — Fetch lists + import members as contacts
// ════════════════════════════════════════════════════════════════════════════
//
// Flow:
//   1. UI: user pastes their Mailchimp API key
//   2. POST /mailchimp/lists  → backend fetches their lists, returns id+name+count
//   3. UI: user picks a list
//   4. POST /mailchimp/import → backend pages through members, dedupes by email,
//                                inserts into contacts with source='mailchimp_import'
//
// API ref: https://mailchimp.com/developer/marketing/api/
// Auth   : HTTP Basic with username "anystring", password = API key
// Datacenter is the suffix of the API key (e.g. "abc123-us17" → "us17")
// ════════════════════════════════════════════════════════════════════════════

/** Extract the datacenter prefix from a Mailchimp API key.
 *  Mailchimp keys are formatted "<32 hex chars>-<dc>" e.g. "abc-us17". */
function mailchimpDatacenter(apiKey) {
  if (!apiKey || typeof apiKey !== "string") return null;
  const dash = apiKey.lastIndexOf("-");
  if (dash < 0 || dash === apiKey.length - 1) return null;
  return apiKey.slice(dash + 1);
}

/** Build Mailchimp Basic auth header */
function mailchimpAuthHeader(apiKey) {
  return "Basic " + Buffer.from("anystring:" + apiKey).toString("base64");
}

// Step 1: List the user's Mailchimp audiences
router.post("/mailchimp/lists", auth, async (req, res) => {
  try {
    let { apiKey } = req.body;

    // Fall back to saved per-user key if not in body
    if (!apiKey) {
      try {
        const { getSavedKey } = require("./user-integration-keys");
        const saved = getSavedKey(getDb(), req.userId, "mailchimp");
        if (saved?.apiKey) apiKey = saved.apiKey;
      } catch(_) {}
    }
    if (!apiKey) return res.status(400).json({ error: "Mailchimp API key required (or save it in settings)" });

    const dc = mailchimpDatacenter(apiKey);
    if (!dc) return res.status(400).json({ error: "Invalid Mailchimp API key — must end with datacenter suffix (e.g. -us17)" });

    const fetch = (await import("node-fetch")).default;
    const r = await fetch(`https://${dc}.api.mailchimp.com/3.0/lists?count=100&fields=lists.id,lists.name,lists.stats.member_count,lists.date_created`, {
      headers: { "Authorization": mailchimpAuthHeader(apiKey) },
    });
    if (!r.ok) {
      const errBody = await r.text();
      console.error("[Mailchimp] lists error:", r.status, errBody.slice(0, 200));
      if (r.status === 401) return res.status(401).json({ error: "Mailchimp API key rejected. Check the key and try again." });
      return res.status(502).json({ error: `Mailchimp API returned ${r.status}` });
    }
    const data = await r.json();
    const lists = (data.lists || []).map(l => ({
      id: l.id,
      name: l.name,
      memberCount: l.stats?.member_count || 0,
      createdAt: l.date_created,
    }));
    res.json({ ok: true, lists });
  } catch (e) {
    console.error("[Mailchimp] lists failed:", e.message);
    res.status(500).json({ error: "Could not connect to Mailchimp" });
  }
});

// Step 2: Import all members from a chosen list as contacts
router.post("/mailchimp/import", auth, importRateLimit, async (req, res) => {
  try {
    let { apiKey, listId, migrationId } = req.body;

    // If no apiKey in request body, try the saved per-user key
    if (!apiKey) {
      try {
        const { getSavedKey } = require("./user-integration-keys");
        const saved = getSavedKey(getDb(), req.userId, "mailchimp");
        if (saved?.apiKey) apiKey = saved.apiKey;
      } catch(_) {}
    }

    if (!apiKey || !listId) return res.status(400).json({ error: "apiKey and listId required (or save a Mailchimp key in settings first)" });

    const dc = mailchimpDatacenter(apiKey);
    if (!dc) return res.status(400).json({ error: "Invalid Mailchimp API key" });

    const db = getDb();
    ensureTables(db);

    const fetch = (await import("node-fetch")).default;
    const headers = { "Authorization": mailchimpAuthHeader(apiKey) };

    // Pagination — Mailchimp returns up to 1000 per page, paginate with offset
    let offset = 0;
    const pageSize = 1000;
    let totalFetched = 0;
    let imported = 0;
    let skipped = 0;
    let pagesScanned = 0;
    let mailchimpTotal = null; // total members across the whole list per Mailchimp
    let truncated = false;
    const MAX_PAGES = 50; // safety cap → 50,000 members per import

    while (pagesScanned < MAX_PAGES) {
      const url = `https://${dc}.api.mailchimp.com/3.0/lists/${encodeURIComponent(listId)}/members` +
                  `?count=${pageSize}&offset=${offset}` +
                  `&fields=members.email_address,members.merge_fields,members.status,members.tags,total_items`;
      const r = await fetch(url, { headers });
      if (!r.ok) {
        const errBody = await r.text();
        console.error("[Mailchimp] members error:", r.status, errBody.slice(0, 200));
        if (r.status === 401) return res.status(401).json({ error: "Mailchimp API key rejected mid-import" });
        if (r.status === 404) return res.status(404).json({ error: "List not found" });
        return res.status(502).json({ error: `Mailchimp API returned ${r.status}` });
      }
      const data = await r.json();
      if (mailchimpTotal === null && typeof data.total_items === "number") mailchimpTotal = data.total_items;
      const members = data.members || [];
      if (members.length === 0) break;

      for (const m of members) {
        const email = (m.email_address || "").toLowerCase().trim();
        if (!email) { skipped++; continue; }

        // Skip already-unsubscribed/cleaned by default — most users only want active subscribers
        // (caller can still import them by setting status='subscribed' downstream)
        const mcStatus = m.status || "subscribed";
        if (mcStatus !== "subscribed" && mcStatus !== "pending") { skipped++; continue; }

        // Dedupe by email
        const exists = db.prepare("SELECT id FROM contacts WHERE user_id = ? AND email = ?").get(req.userId, email);
        if (exists) { skipped++; continue; }

        const mf = m.merge_fields || {};
        const firstName = mf.FNAME || "";
        const lastName  = mf.LNAME || "";
        const fullName  = `${firstName} ${lastName}`.trim() || email.split("@")[0];
        const phone     = mf.PHONE || "";

        const tags = Array.isArray(m.tags) ? m.tags.map(t => t.name || t).filter(Boolean) : [];
        tags.unshift("mailchimp-import");

        try {
          db.prepare(`INSERT INTO contacts (id, user_id, name, email, phone, status, source, tags, notes, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`)
            .run(uuid(), req.userId, fullName, email, phone, "lead", "mailchimp_import",
              JSON.stringify(tags), `Imported from Mailchimp list ${listId}. Mailchimp status: ${mcStatus}.`);
          imported++;
        } catch(insertErr) {
          console.error("[Mailchimp] insert failed for", email, insertErr.message);
          skipped++;
        }
      }

      totalFetched += members.length;
      pagesScanned++;
      offset += pageSize;

      // Stop early if we got fewer than a full page (last page)
      if (members.length < pageSize) break;
    }

    // Update migration record if provided
    if (migrationId) {
      try {
        db.prepare("UPDATE migrations SET contacts_imported=?, updated_at=datetime('now') WHERE id=? AND user_id=?")
          .run(imported, migrationId, req.userId);
      } catch(_) {}
    }

    // Log intelligence event so AI Insights picks up the import
    if (imported > 0) {
      try {
        const { logEvent } = require("./intelligence");
        logEvent(db, req.userId, "contact_added", { count: imported, source: "mailchimp_import" });
      } catch(_) {}
    }

    // Persist listId into saved credentials' meta so the hourly auto-sync
    // cron knows which list to keep in sync. Also bump last_sync_at to "now"
    // so the cron doesn't re-fetch everything we just imported.
    try {
      const credRow = db.prepare("SELECT meta FROM user_integration_keys WHERE user_id = ? AND service = 'mailchimp'").get(req.userId);
      if (credRow) {
        let meta = {};
        try { meta = JSON.parse(credRow.meta || "{}"); } catch(_) {}
        meta.listId = listId;
        meta.lastManualImportAt = new Date().toISOString();
        // Initialize sync state columns if missing (idempotent)
        try { db.exec("ALTER TABLE user_integration_keys ADD COLUMN last_sync_at TEXT"); } catch(_) {}
        try { db.exec("ALTER TABLE user_integration_keys ADD COLUMN last_sync_status TEXT"); } catch(_) {}
        try { db.exec("ALTER TABLE user_integration_keys ADD COLUMN last_sync_count INTEGER"); } catch(_) {}
        try { db.exec("ALTER TABLE user_integration_keys ADD COLUMN consecutive_failures INTEGER DEFAULT 0"); } catch(_) {}
        db.prepare(`UPDATE user_integration_keys SET
                      meta = ?,
                      last_used_at = datetime('now'),
                      last_sync_at = datetime('now'),
                      last_sync_status = 'ok',
                      last_sync_count = ?,
                      consecutive_failures = 0
                    WHERE user_id = ? AND service = 'mailchimp'`)
          .run(JSON.stringify(meta), imported, req.userId);
      }
    } catch(_) {}

    // Detect truncation: if Mailchimp reports more members than we fetched
    truncated = (mailchimpTotal !== null) && (totalFetched < mailchimpTotal);

    res.json({
      ok: true,
      stats: {
        totalFetched, imported, skipped, pagesScanned, listId,
        mailchimpTotal, truncated,
      },
      ...(truncated && { warning: `Only imported ${totalFetched} of ${mailchimpTotal} members. Mailchimp list exceeds the 50,000 import cap.` }),
    });
  } catch (e) {
    console.error("[Mailchimp] import failed:", e.message);
    res.status(500).json({ error: "Mailchimp import failed" });
  }
});

module.exports = router;
