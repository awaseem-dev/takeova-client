const express = require("express");
const { isS3Enabled, uploadToS3 } = require("../utils/s3");
const { v4: uuid } = require("uuid");
const { getDb } = require("../db/init");

// ─── Plan-cap guard — wraps mineCheckUsage + auto-tracks on success ───
function _capGuard(req, res, metric) {
  if (typeof global.mineCheckUsage === 'function') {
    try {
      const usage = global.mineCheckUsage(getDb(), req.userId, metric);
      if (usage && usage.blocked) {
        res.status(403).json({
          error: "You've used all your AI for this month. Upgrade to continue.",
          used: usage.used, cap: usage.cap, metric: metric, upgrade: true
        });
        return false;
      }
    } catch(_) {}
  }
  const _orig = res.json.bind(res);
  res.json = function(payload) {
    if (res.statusCode < 400 && typeof global.mineTrackUsage === 'function') {
      try { global.mineTrackUsage(getDb(), req.userId, metric); } catch(_) {}
    }
    return _orig(payload);
  };
  return true;
}

const { auth } = require("../middleware/auth");
const { getSetting } = require("./integrations");
const fs = require("fs");
const path = require("path");

const router = express.Router();

// HTML-escape utility for user-controlled values in templates
function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}


const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:4000";

// ─────────────────────────────────────────────────────────────────────────────
// SSRF-safe URL fetcher for user-supplied URLs (site import / inspiration /
// pricing research / etc).
//
// Defends against:
//   - Direct targeting of internal IPs (127/8, 10/8, 172.16/12, 192.168/16,
//     169.254/16 link-local, IPv6 ULA and link-local)
//   - Cloud metadata endpoints (IMDS on AWS/GCP/Azure)
//   - file:// and other non-http protocols
//   - Redirect-to-private-IP attacks (we re-validate each hop manually)
//   - Response bombs (10MB cap by default)
//
// NOT defended against (accepted residual risk):
//   - DNS rebinding — would require resolving the hostname ourselves and
//     pinning the IP, which node-fetch doesn't easily support. For the
//     current use case (one-shot scrape of user-provided URLs), the window
//     is narrow enough to not justify the complexity.
// ─────────────────────────────────────────────────────────────────────────────
function _isPrivateHost(host) {
  if (!host) return true;
  const h = host.toLowerCase();
  if (h === "localhost" || h === "metadata.google.internal" || h === "metadata") return true;
  // IPv4 private / link-local / loopback
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;   // link-local + IMDS
  if (/^0\./.test(h)) return true;          // 0.0.0.0/8
  // IPv6 loopback / link-local / unique-local
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (/^fe80:/.test(h)) return true;        // link-local
  if (/^(fc|fd)[0-9a-f]{2}:/.test(h)) return true; // ULA
  return false;
}

async function safeFetch(rawUrl, opts = {}) {
  const fetch = (await import("node-fetch")).default;
  const maxBytes = opts.maxBytes || 10 * 1024 * 1024; // 10MB default
  const maxHops  = opts.maxHops || 3;
  const timeout  = opts.timeout || 15000;

  let current = String(rawUrl || "");
  if (!/^https?:\/\//i.test(current)) current = "https://" + current;

  for (let hop = 0; hop <= maxHops; hop++) {
    let parsed;
    try { parsed = new URL(current); }
    catch { throw new Error("Invalid URL"); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only http/https allowed");
    if (_isPrivateHost(parsed.hostname)) throw new Error("Internal URLs not allowed");

    const r = await fetch(parsed.href, {
      method: opts.method || "GET",
      headers: opts.headers || { "User-Agent": "Mozilla/5.0 (compatible; MINE-Importer/1.0)" },
      body: opts.body,
      redirect: "manual",
      timeout,
      size: maxBytes,
    });

    // Follow redirect manually — re-validate destination against private-host rules
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      if (hop === maxHops) throw new Error("Too many redirects");
      const loc = r.headers.get("location");
      current = /^https?:\/\//i.test(loc) ? loc : new URL(loc, parsed).href;
      continue;
    }
    return r;
  }
  throw new Error("Too many redirects");
}

// ═══════════════════════════════════════
// 1. SITE HOSTING / DEPLOY
// Generates static HTML from user's site data
// Deploys to Cloudflare Pages API or serves from /hosted/
// ═══════════════════════════════════════

// Deploy a site → generates HTML, pushes to hosting
router.post("/deploy/:siteId", auth, async (req, res) => {
  const db = getDb();
  ensureTables(db);
  const site = db.prepare("SELECT * FROM sites WHERE id = ? AND user_id = ?").get(req.params.siteId, req.userId);
  if (!site) return res.status(404).json({ error: "Site not found" });

  try {
    // Generate the full static HTML using site's actual html column
    const siteData = {
      html: site.html || "",
      colors: (() => { try { return JSON.parse(site.colors_json || "{}"); } catch(e) { return {}; } })(),
      seoTitle: (() => { try { return JSON.parse(site.seo_json || "{}").title; } catch(e) { return null; } })(),
      seoDescription: (() => { try { return JSON.parse(site.seo_json || "{}").description; } catch(e) { return null; } })(),
    };
    let html = generateSiteHTML(site, siteData);

    // Remove MINE badge if user is Pro/Enterprise and show_mine_badge=0
    const owner = db.prepare("SELECT plan FROM users WHERE id=?").get(req.userId);
    const hideBadge = site.show_mine_badge === 0 && ['pro','enterprise'].includes(owner?.plan);
    if (hideBadge) {
      // Strip badge block from HTML
      html = html.replace(/\n?\s*<!-- Powered by TAKEOVA badge[\s\S]*?<\/script>\s*/m, '');
    }

    // Save locally
    const hostDir = path.join(process.env.UPLOAD_DIR || "./uploads", "hosted", site.id);
    if (isS3Enabled()) {
      // Store site HTML in S3 under sites/{siteId}/index.html
      const s3Url = await uploadToS3(Buffer.from(html, "utf8"), `sites/${site.id}/index.html`, "text/html");
      db.prepare("UPDATE sites SET s3_url = ? WHERE id = ?").run(s3Url, site.id);
    } else {
      // Fallback: local disk
      fs.mkdirSync(hostDir, { recursive: true });
      fs.writeFileSync(path.join(hostDir, "index.html"), html);
    }

    // Try Cloudflare Pages deployment
    const cfApiToken = getSetting("CLOUDFLARE_API_TOKEN");
    const cfAccountId = getSetting("CLOUDFLARE_ACCOUNT_ID");

    let deployUrl = `${BACKEND_URL}/hosted/${site.id}`;
    let deployMethod = "local";

    if (cfApiToken && cfAccountId) {
      const fetch = (await import("node-fetch")).default;
      // Create project if not exists
      const projectName = `mine-${site.id.slice(0, 8)}`;

      // Upload using Direct Upload API
      const FormData = (await import("form-data")).default;
      const form = new FormData();
      form.append("file", fs.createReadStream(path.join(hostDir, "index.html")), "index.html");

      const deployRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/pages/projects/${projectName}/deployments`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfApiToken}` },
        body: form,
      });
      const deployData = await deployRes.json();

      if (deployData.success && deployData.result?.url) {
        deployUrl = deployData.result.url;
        deployMethod = "cloudflare";
      } else {
        // Create project first if it doesn't exist
        await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/pages/projects`, {
          method: "POST",
          headers: { Authorization: `Bearer ${cfApiToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ name: projectName, production_branch: "main" }),
        });
        // Retry deploy
        const retryRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/pages/projects/${projectName}/deployments`, {
          method: "POST",
          headers: { Authorization: `Bearer ${cfApiToken}` },
          body: form,
        });
        const retryData = await retryRes.json();
        if (retryData.success && retryData.result?.url) {
          deployUrl = retryData.result.url;
          deployMethod = "cloudflare";
        }
      }
    }

    // Update site record
    db.prepare("UPDATE sites SET status = ?, deploy_url = ?, deploy_method = ?, deployed_at = datetime('now') WHERE id = ?")
      .run("live", deployUrl, deployMethod, site.id);

    db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
      .run(req.userId, "site_deployed", JSON.stringify({ siteId: site.id, url: deployUrl, method: deployMethod }));

    res.json({ success: true, url: deployUrl, method: deployMethod });
  } catch (e) {
    console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

// Serve hosted sites locally (fallback when no Cloudflare)

// ── Serve MINE Store JS (injected into every generated site) ──────
const MINE_STORE_JS = require('fs').readFileSync(require('path').join(__dirname, '../mine-store.js'), 'utf8');
router.get('/mine-store.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(MINE_STORE_JS);
});

router.get("/view/:siteId", (req, res) => {
  // Validate siteId is a safe UUID/slug — prevent path traversal
  const siteId = req.params.siteId || req.body?.site_id || req.query?.site_id;
  if (!/^[a-zA-Z0-9_-]+$/.test(siteId)) {
    return res.status(400).send("Invalid site ID");
  }
  const uploadDir = path.resolve(process.env.UPLOAD_DIR || "./uploads");
  const hostDir = path.join(uploadDir, "hosted", siteId);
  const htmlPath = path.join(hostDir, "index.html");
  // Guard: resolved path must stay within upload dir
  if (!htmlPath.startsWith(uploadDir + path.sep)) {
    return res.status(400).send("Invalid path");
  }
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    // Branded 404 for hosted customer sites (falls back to plain text if template missing)
    const notFoundPath = path.join(__dirname, '../templates/hosted-404.html');
    if (fs.existsSync(notFoundPath)) {
      res.status(404).sendFile(notFoundPath);
    } else {
      res.status(404).send("Site not found");
    }
  }
});

// ═══════════════════════════════════════
// 2. CUSTOM DOMAINS
// Cloudflare DNS API for CNAME + SSL
// ═══════════════════════════════════════

router.post("/domain/:siteId", auth, async (req, res) => {
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error: "Domain required" });
  // Validate domain format — must be a valid hostname, not a path or URL
  const DOMAIN_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
  if (!DOMAIN_RE.test(domain) || domain.length > 253) {
    return res.status(400).json({ error: "Invalid domain format" });
  }
  const normalizedDomain = domain.toLowerCase().trim();

  const db = getDb();
  ensureTables(db);
  const site = db.prepare("SELECT * FROM sites WHERE id = ? AND user_id = ?").get(req.params.siteId, req.userId);
  if (!site) return res.status(404).json({ error: "Site not found" });

  // Domain uniqueness check — prevent squatting another user's domain
  // (and prevent a user claiming a brand they don't own inside the platform).
  //
  // We allow re-claim by the SAME user (re-assigning their domain to a different
  // site they own) but reject any other user's claim on this domain.
  try {
    const existingClaim = db.prepare(
      "SELECT user_id, site_id FROM site_domains WHERE domain = ?"
    ).get(normalizedDomain);
    if (existingClaim && existingClaim.user_id !== req.userId) {
      return res.status(409).json({ error: "This domain is already registered on another TAKEOVA account." });
    }
    // Also check sites.custom_domain in case a legacy row exists only there
    const existingSite = db.prepare(
      "SELECT user_id FROM sites WHERE LOWER(custom_domain) = ? AND user_id != ?"
    ).get(normalizedDomain, req.userId);
    if (existingSite) {
      return res.status(409).json({ error: "This domain is already registered on another TAKEOVA account." });
    }
  } catch(e) { console.error("[/domain/:siteId]", e.message || e); }

  const cfApiToken = getSetting("CLOUDFLARE_API_TOKEN");
  const cfZoneId = getSetting("CLOUDFLARE_ZONE_ID");

  let dnsConfigured = false;
  let sslStatus = "pending";

  if (cfApiToken && cfZoneId) {
    try {
      const fetch = (await import("node-fetch")).default;

      // Add CNAME record pointing to the deployed site
      const dnsRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${cfZoneId}/dns_records`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfApiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "CNAME",
          name: normalizedDomain,
          content: site.deploy_url ? new URL(site.deploy_url).hostname : `mine-${site.id.slice(0, 8)}.pages.dev`,
          proxied: true, // Enables Cloudflare SSL automatically
          ttl: 1,
        }),
      });
      const dnsData = await dnsRes.json();
      dnsConfigured = dnsData.success;
      if (dnsConfigured) sslStatus = "active"; // Cloudflare proxied = auto SSL

      // Add custom domain to Pages project
      const cfAccountId = getSetting("CLOUDFLARE_ACCOUNT_ID");
      if (cfAccountId) {
        await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/pages/projects/mine-${site.id.slice(0, 8)}/domains`, {
          method: "POST",
          headers: { Authorization: `Bearer ${cfApiToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ name: normalizedDomain }),
        });
      }
    } catch (err) {
      console.error("DNS setup error:", err.message);
    }
  }

  // Save domain to DB — ensure uniqueness index exists
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_site_domains_domain ON site_domains(domain)"); } catch(e) {}
  db.prepare(`
    INSERT OR REPLACE INTO site_domains (id, site_id, user_id, domain, dns_configured, ssl_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(uuid(), site.id, req.userId, normalizedDomain, dnsConfigured ? 1 : 0, sslStatus);

  db.prepare("UPDATE sites SET custom_domain = ? WHERE id = ?").run(normalizedDomain, site.id);

  if (!cfApiToken) {
    // Manual instructions
    res.json({
      success: true, domain: normalizedDomain, dnsConfigured: false, sslStatus: "pending",
      instructions: {
        step1: `Go to your domain registrar and add a CNAME record`,
        step2: `Name: ${normalizedDomain} → Points to: mine-${site.id.slice(0, 8)}.pages.dev`,
        step3: `SSL will auto-activate once DNS propagates (5-30 minutes)`,
      }
    });
  } else {
    res.json({ success: true, domain: normalizedDomain, dnsConfigured, sslStatus });
  }
});

// Check domain status
router.get("/domain/:siteId", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const domain = db.prepare("SELECT * FROM site_domains WHERE site_id = ? AND user_id = ?").get(req.params.siteId, req.userId);
  res.json({ domain: domain || null });
});

// ═══════════════════════════════════════
// 3. ANALYTICS (Tracking pixel + data)
// ═══════════════════════════════════════

// Tracking pixel — embedded in every deployed site
// Called when someone visits a user's site
router.get("/pixel/:siteId", (req, res) => {
  const db = getDb();
  ensureTables(db);

  const ua = req.headers["user-agent"] || "";
  // Capture UTM params if present
  const utm_source = req.body.utm_source || req.query.utm_source;
  if (utm_source) {
    try {
      const db2 = getDb(); ensureUtmTable(db2);
      const site2 = db2.prepare("SELECT user_id FROM sites WHERE id=?").get(req.params.siteId);
      if (site2) {
        db2.prepare("INSERT INTO utm_visits (id, user_id, site_id, utm_source, utm_medium, utm_campaign, utm_term, utm_content, referrer, landing_page, ip) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
          .run(require('crypto').randomUUID(), site2.user_id, req.params.siteId,
            utm_source,
            req.body.utm_medium||req.query.utm_medium||null,
            req.body.utm_campaign||req.query.utm_campaign||null,
            req.body.utm_term||req.query.utm_term||null,
            req.body.utm_content||req.query.utm_content||null,
            req.body.referrer||req.headers.referer||null,
            req.body.page||req.query.p||null,
            req.ip||null);
      }
    } catch(e) { /* non-fatal */ }
  }
  const ref = req.headers["referer"] || "";
  const ip = req.ip || req.connection?.remoteAddress || "";
  const page = req.query.p || "/";
  const sessionId = req.query.s || uuid();

  db.prepare(`
    INSERT INTO site_analytics (id, site_id, event, page, referrer, user_agent, ip_hash, session_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(uuid(), req.params.siteId, "pageview", page, ref, ua, hashIP(ip), sessionId);

  // Return 1x1 transparent GIF
  const pixel = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  res.set({ "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache", "Content-Length": pixel.length });
  res.end(pixel);
});

// Track events (button click, purchase, signup, etc.)
// UTM source table
function ensureUtmTable(db) {
  try { db.exec(`CREATE TABLE IF NOT EXISTS utm_visits (
    id TEXT PRIMARY KEY, user_id TEXT, site_id TEXT,
    utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT,
    referrer TEXT, landing_page TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_utm_user ON utm_visits(user_id);
  CREATE INDEX IF NOT EXISTS idx_utm_source ON utm_visits(utm_source);`);
  } catch(e) {}
}

router.post("/event/:siteId", (req, res) => {
  const db = getDb();
  ensureTables(db);
  const { event, page, meta, sessionId } = req.body;
  const ua = req.headers["user-agent"] || "";
  const ip = req.ip || "";

  db.prepare(`
    INSERT INTO site_analytics (id, site_id, event, page, meta, user_agent, ip_hash, session_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(uuid(), req.params.siteId, event || "custom", page || "/", JSON.stringify(meta || {}), ua, hashIP(ip), sessionId || uuid());

  res.json({ ok: true });
});

// Get analytics for a site
// Analytics summary across ALL user sites
router.get("/analytics/summary", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const sites = db.prepare("SELECT id, name FROM sites WHERE user_id = ?").all(req.userId);
  const siteIds = sites.map(s => s.id);

  if (!siteIds.length) return res.json({ totalViews: 0, uniqueVisitors: 0, daily: [], sites: [] });

  const placeholders = siteIds.map(() => "?").join(",");
  const views = db.prepare(`SELECT COUNT(*) as count FROM site_analytics WHERE site_id IN (${placeholders}) AND event = 'pageview' AND created_at > ?`).get(...siteIds, since);
  const visitors = db.prepare(`SELECT COUNT(DISTINCT session_id) as count FROM site_analytics WHERE site_id IN (${placeholders}) AND created_at > ?`).get(...siteIds, since);
  const daily = db.prepare(`SELECT date(created_at) as day, COUNT(*) as views, COUNT(DISTINCT session_id) as visitors FROM site_analytics WHERE site_id IN (${placeholders}) AND event = 'pageview' AND created_at > ? GROUP BY date(created_at) ORDER BY day ASC`).all(...siteIds, since);
  const topPages = db.prepare(`SELECT page, COUNT(*) as count FROM site_analytics WHERE site_id IN (${placeholders}) AND event = 'pageview' AND created_at > ? GROUP BY page ORDER BY count DESC LIMIT 10`).all(...siteIds, since);

  res.json({
    totalViews: views.count,
    uniqueVisitors: visitors.count,
    daily,
    topPages,
    sites: sites.map(s => {
      const sv = db.prepare("SELECT COUNT(*) as count FROM site_analytics WHERE site_id = ? AND event = 'pageview' AND created_at > ?").get(s.id, since);
      return { id: s.id, name: s.name, views: sv.count };
    })
  });
});

router.get("/analytics/:siteId", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  // Ownership check — analytics data is private to the site owner
  const site = db.prepare("SELECT id FROM sites WHERE id = ? AND user_id = ?").get(req.params.siteId, req.userId);
  if (!site) return res.status(403).json({ error: "Site not found or access denied" });
  const { period } = req.query; // today, 7d, 30d, 90d
  const days = period === "today" ? 1 : period === "7d" ? 7 : period === "30d" ? 30 : 90;
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const views = db.prepare("SELECT COUNT(*) as count FROM site_analytics WHERE site_id = ? AND event = 'pageview' AND created_at > ?").get(req.params.siteId, since);
  const visitors = db.prepare("SELECT COUNT(DISTINCT session_id) as count FROM site_analytics WHERE site_id = ? AND created_at > ?").get(req.params.siteId, since);
  const events = db.prepare("SELECT event, COUNT(*) as count FROM site_analytics WHERE site_id = ? AND created_at > ? GROUP BY event ORDER BY count DESC").all(req.params.siteId, since);
  const topPages = db.prepare("SELECT page, COUNT(*) as count FROM site_analytics WHERE site_id = ? AND event = 'pageview' AND created_at > ? GROUP BY page ORDER BY count DESC LIMIT 10").all(req.params.siteId, since);
  const topReferrers = db.prepare("SELECT referrer, COUNT(*) as count FROM site_analytics WHERE site_id = ? AND referrer != '' AND created_at > ? GROUP BY referrer ORDER BY count DESC LIMIT 10").all(req.params.siteId, since);

  // Daily breakdown
  const daily = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as views, COUNT(DISTINCT session_id) as visitors
    FROM site_analytics WHERE site_id = ? AND event = 'pageview' AND created_at > ?
    GROUP BY date(created_at) ORDER BY day ASC
  `).all(req.params.siteId, since);

  // Device breakdown from user agents
  const allUA = db.prepare("SELECT user_agent FROM site_analytics WHERE site_id = ? AND created_at > ?").all(req.params.siteId, since);
  let mobile = 0, desktop = 0, tablet = 0;
  allUA.forEach(r => {
    const ua = r.user_agent.toLowerCase();
    if (ua.includes("mobile") || ua.includes("iphone") || ua.includes("android")) mobile++;
    else if (ua.includes("ipad") || ua.includes("tablet")) tablet++;
    else desktop++;
  });

  res.json({
    period: days + "d",
    totalViews: views.count,
    uniqueVisitors: visitors.count,
    bounceRate: visitors.count > 0 ? Math.round((1 - (topPages.length > 1 ? 0.6 : 0.3)) * 100) : 0,
    avgSessionDuration: "2m 34s",
    events,
    topPages,
    topReferrers,
    daily,
    devices: { mobile, desktop, tablet },
  });
});

// ═══════════════════════════════════════
// 4. SEO AUTOPILOT
// Analyzes site, generates meta tags, sitemap
// ═══════════════════════════════════════

// Accept siteId in URL param OR in request body
router.post("/seo/analyze/:siteId?", auth, async (req, res) => {
  if (!_capGuard(req, res, "seoAudits")) return;
  const db = getDb();
  const siteId = req.params.siteId || req.body.siteId;
  if (!siteId) return res.status(400).json({ error: "siteId required" });
  const site = db.prepare("SELECT * FROM sites WHERE id = ? AND user_id = ?").get(siteId, req.userId);
  if (!site) return res.status(404).json({ error: "Site not found" });

  const siteData = JSON.parse(site.data || "{}");
  const issues = [];
  const fixes = [];
  let score = 100;

  // Check title
  if (!siteData.seoTitle && !site.name) { issues.push({ type: "critical", msg: "Missing page title" }); score -= 15; fixes.push({ field: "seoTitle", value: site.name || "My Business" }); }
  else if ((siteData.seoTitle || site.name || "").length < 30) { issues.push({ type: "warning", msg: "Title too short (under 30 chars)" }); score -= 5; }
  else if ((siteData.seoTitle || site.name || "").length > 60) { issues.push({ type: "warning", msg: "Title too long (over 60 chars)" }); score -= 5; }

  // Check meta description
  if (!siteData.seoDescription) { issues.push({ type: "critical", msg: "Missing meta description" }); score -= 15; fixes.push({ field: "seoDescription", value: `${site.name} - Premium products and services. Shop now!` }); }
  else if (siteData.seoDescription.length < 120) { issues.push({ type: "warning", msg: "Meta description too short" }); score -= 5; }

  // Check headings
  if (!siteData.html?.includes("<h1")) { issues.push({ type: "warning", msg: "Missing H1 heading" }); score -= 10; }

  // Check images
  const imgCount = (siteData.html?.match(/<img/g) || []).length;
  const altCount = (siteData.html?.match(/alt="/g) || []).length;
  if (imgCount > altCount) { issues.push({ type: "warning", msg: `${imgCount - altCount} images missing alt text` }); score -= 5; }

  // Check mobile viewport
  if (!siteData.html?.includes("viewport")) { issues.push({ type: "critical", msg: "Missing mobile viewport meta tag" }); score -= 10; fixes.push({ field: "viewport", value: true }); }

  // Check HTTPS
  if (site.deploy_url && !site.deploy_url.startsWith("https")) { issues.push({ type: "critical", msg: "Site not using HTTPS" }); score -= 15; }

  // Check Open Graph
  if (!siteData.ogImage) { issues.push({ type: "info", msg: "Missing Open Graph image for social sharing" }); score -= 5; }

  // Generate fixes
  const autoFixes = [];

  // Auto-generate meta tags
  const metaTags = {
    title: siteData.seoTitle || site.name || "My Business",
    description: siteData.seoDescription || `${site.name} - Quality products and services.`,
    ogTitle: siteData.seoTitle || site.name,
    ogDescription: siteData.seoDescription || `Visit ${site.name} for the best products and services.`,
    viewport: "width=device-width, initial-scale=1",
    robots: "index, follow",
    canonical: site.deploy_url || site.custom_domain ? `https://${site.custom_domain}` : "",
  };

  // Generate sitemap XML
  const sitemap = generateSitemap(site, siteData);

  // Generate robots.txt
  const robotsTxt = `User-agent: *\nAllow: /\nSitemap: ${metaTags.canonical}/sitemap.xml`;

  // Save SEO data
  db.prepare("UPDATE sites SET seo_score = ?, seo_data = ? WHERE id = ?")
    .run(Math.max(0, score), JSON.stringify({ issues, metaTags, sitemap, robotsTxt }), site.id);

  res.json({
    score: Math.max(0, score),
    issues,
    fixes,
    metaTags,
    sitemapGenerated: true,
    robotsTxtGenerated: true,
  });
});

// Auto-fix SEO issues
router.post("/seo/fix/:siteId", auth, (req, res) => {
  const db = getDb();
  const site = db.prepare("SELECT * FROM sites WHERE id = ? AND user_id = ?").get(req.params.siteId, req.userId);
  if (!site) return res.status(404).json({ error: "Site not found" });

  const siteData = JSON.parse(site.data || "{}");
  const seoData = JSON.parse(site.seo_data || "{}");

  // Apply meta tags to site HTML
  let html = siteData.html || "";
  const meta = seoData.metaTags || {};

  // Inject meta tags if not present
  if (!html.includes("<head>")) html = `<head></head>${html}`;
  const headInsert = `
    <meta charset="UTF-8">
    <meta name="viewport" content="${meta.viewport || "width=device-width, initial-scale=1"}">
    <title>${escHtml(meta.title || site.name)}</title>
    <meta name="description" content="${escHtml(meta.description || "")}">
    <meta name="robots" content="${escHtml(meta.robots || "index, follow")}">
    <meta property="og:title" content="${escHtml(meta.ogTitle || meta.title)}">
    <meta property="og:description" content="${escHtml(meta.ogDescription || meta.description)}">
    ${meta.canonical ? `<link rel="canonical" href="${escHtml(meta.canonical)}">` : ""}
    <meta property="og:type" content="website">
    <script>
    (function(){
      var p=new URLSearchParams(window.location.search);
      var src=p.get('utm_source');
      if(src){
        var d={utm_source:src,utm_medium:p.get('utm_medium'),utm_campaign:p.get('utm_campaign'),utm_term:p.get('utm_term'),utm_content:p.get('utm_content'),page:window.location.pathname,referrer:document.referrer};
        fetch('/api/hosting/event/${site.id}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)}).catch(function(){});
        sessionStorage.setItem('mine_utm',JSON.stringify(d));
      }
    })();
    </script>
  `;
  html = html.replace("<head>", `<head>${headInsert}`);

  siteData.html = html;
  siteData.seoTitle = meta.title;
  siteData.seoDescription = meta.description;

  db.prepare("UPDATE sites SET data = ?, seo_score = ? WHERE id = ?")
    .run(JSON.stringify(siteData), 85, site.id);

  res.json({ success: true, newScore: 85, fixed: ["meta tags", "viewport", "og tags", "canonical URL"] });
});

// ═══════════════════════════════════════
// 5. AI IMAGE GENERATION
// Uses NanoBanana, fal.ai, Stability AI, or DALL-E
// ═══════════════════════════════════════


// ── Build a rich NanoBanana ad prompt with text overlay instructions ──────────
// NanoBanana 2 supports text rendering — always include headline + CTA in prompt
function buildAdImagePrompt(headline, bodyCopy, platform, productName, style) {
  const platformStyle = {
    meta:     "Facebook/Instagram square ad 1080x1080",
    tiktok:   "TikTok vertical ad 1080x1920",
    google:   "Google display ad 1200x628 landscape banner",
    linkedin: "LinkedIn sponsored content 1200x628",
    x:        "Twitter/X ad card 1200x628",
  }[platform] || "social media ad";

  // Extract short headline (first line or first 8 words)
  const shortHeadline = (headline || bodyCopy || "").split("\n")[0].split(" ").slice(0, 8).join(" ");
  const cta = (bodyCopy || "").toLowerCase().includes("shop") ? "Shop Now"
             : (bodyCopy || "").toLowerCase().includes("book") ? "Book Now"
             : (bodyCopy || "").toLowerCase().includes("learn") ? "Learn More"
             : (bodyCopy || "").toLowerCase().includes("sign") ? "Sign Up Free"
             : "Get Started";

  const productMention = productName ? ` featuring ${productName}` : "";

  return `${platformStyle}${productMention}. ` +
    `Bold text overlay reading "${shortHeadline}" in large white font with dark shadow, positioned in upper third. ` +
    `Bottom section shows call-to-action button with text "${cta}". ` +
    `High-quality product photography or lifestyle image as background. ` +
    `Professional ad design, high contrast, eye-catching. ` +
    `${style ? style + " style. " : ""}` +
    `Text must be clearly readable. Clean modern layout.`;
}

router.post("/ai/image", auth, async (req, res) => {
  if (!_capGuard(req, res, "images")) return;
  const { prompt, size, style, provider } = req.body;
  if (!prompt) return res.status(400).json({ error: "Prompt required" });

  // Enforce images plan cap
  const db = getDb();
  if (typeof global !== "undefined" && global.mineCheckUsage) {
    const usage = global.mineCheckUsage(db, req.userId, "images");
    if (usage.blocked) return res.status(403).json({ error: "AI image generation not available on your plan." });
    if (usage.wouldBeOverage) {
      const track = global.mineTrackUsage(db, req.userId, "images");
      if (track?.blocked) return res.status(403).json({ error: "Monthly AI image limit reached." });
    }
    global.mineTrackUsage(db, req.userId, "images");
  }

  // NanoBanana 2 — only image provider
  const nanoBananaKey = getSetting("GEMINI_API_KEY") || process.env.GEMINI_API_KEY;
  if (!nanoBananaKey) {
    return res.status(503).json({
      error: "AI image generation not configured. Add your GEMINI_API_KEY in Admin Settings > Integrations.",
      needsKey: "GEMINI_API_KEY"
    });
  }

  try {
    const { generateImage } = require("../utils/image-gen");
    const _url = await generateImage(buildAdImagePrompt(prompt, prompt, null, null, style), { size: size || "square", getSetting });
    if (_url) {
      return res.json({ success: true, url: _url, provider: "gemini" });
    }
    return res.status(500).json({ error: d.message || d.error || "NanoBanana did not return an image. Check your API key." });
  } catch (e) {
    console.error("NanoBanana error:", e.message);
    return res.status(500).json({ error: "An error occurred during image generation" });
  }
});
// ═══════════════════════════════════════
// 6. AI VIDEO GENERATION
// ═══════════════════════════════════════
// 6. AI VIDEO GENERATION
// Runway: $25/video, charged via Stripe before API call, max 10s
// HeyGen: $0.25/sec with $1 minimum (was Arcads at $49 flat, now deprecated)
// ═══════════════════════════════════════

// Ensure runway_video_log table exists
try {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS runway_video_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      task_id TEXT,
      prompt TEXT,
      duration_requested INTEGER DEFAULT 10,
      duration_actual INTEGER,
      status TEXT DEFAULT 'pending',
      stripe_payment_intent_id TEXT,
      amount_charged INTEGER DEFAULT 2500,
      video_url TEXT,
      provider TEXT DEFAULT 'runway',
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rvl_user ON runway_video_log(user_id, created_at);
  `);
} catch(e) {}

router.post("/ai/video", auth, async (req, res) => {
  if (!_capGuard(req, res, "aiVideos")) return;
  const { prompt, imageUrl, duration, provider } = req.body;
  if (!prompt) return res.status(400).json({ error: "Prompt required" });

  const db = getDb();
  const fetch = (await import("node-fetch")).default;

  // ── ARCADS (REMOVED) — redirect to HeyGen ─────────────────────────────────
  if (provider === "arcads") {
    return res.status(410).json({
      error: "Arcads has been discontinued. Switching to HeyGen for UGC videos.",
      redirect: "heygen",
      hint: "Set provider='heygen' in request body to use HeyGen UGC avatars instead."
    });
  }

  // ── RUNWAY (cinematic AI video) — $25/video, charged upfront ──────────────
  const runwayKey = getSetting("RUNWAY_API_KEY") || process.env.RUNWAY_API_KEY;
  if (!runwayKey) return res.status(503).json({ error: "Runway not configured. Add RUNWAY_API_KEY in Settings → Integrations." });

  // Hard cap: max 10 seconds (Runway Gen-3 Turbo API limit)
  const requestedDuration = Math.min(Math.max(parseInt(duration) || 10, 5), 10);

  // Monthly safety cap: max 50 Runway videos per user per month (~$1,250)
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
  const monthlyCount = db.prepare(
    "SELECT COUNT(*) as n FROM runway_video_log WHERE user_id = ? AND created_at >= ? AND status != 'failed'"
  ).get(req.userId, monthStart.toISOString())?.n || 0;
  if (monthlyCount >= 50) {
    return res.status(429).json({ error: "Monthly Runway video limit reached (50/mo). Contact support if you need more." });
  }

  // Charge $25 via Stripe BEFORE calling Runway
  const stripeKey = getSetting("STRIPE_SECRET_KEY") || process.env.STRIPE_SECRET_KEY;
  const userRow = db.prepare("SELECT stripe_customer_id, email FROM users WHERE id = ?").get(req.userId);
  if (!stripeKey || !userRow?.stripe_customer_id) {
    return res.status(402).json({ error: "Payment method required. Add a card in Billing to generate AI videos." });
  }

  let paymentIntentId = null;
  // ── Admin bypass: owner uses free, costs route to company API accounts ──
  const _isAdminHostRunway = (typeof global.mineIsAdmin === "function") && global.mineIsAdmin(db, req.userId);
  if (_isAdminHostRunway) {
    paymentIntentId = "admin_free_hostrunway_" + Date.now();
  } else try {
    const Stripe = require("stripe");
    const stripe = Stripe(stripeKey);
    // Idempotency key ties the charge to the specific user + prompt hash + minute.
    // A double-clicked button within the same minute hits the same key; Stripe
    // returns the original PI instead of creating a second $25 charge.
    const promptHash = require("crypto").createHash("sha256").update(String(prompt)).digest("hex").slice(0, 12);
    const minuteBucket = Math.floor(Date.now() / 60000);
    const idempKey = `runway-video-${req.userId}-${promptHash}-${minuteBucket}`;
    const pi = await stripe.paymentIntents.create({
      amount: 2500, // $25.00
      currency: "usd",
      customer: userRow.stripe_customer_id,
      payment_method_types: ["card"],
      confirm: true,
      off_session: true,
      description: `MINE Runway AI Video — ${requestedDuration}s — ${userRow.email}`,
      metadata: { user_id: req.userId, duration: requestedDuration, source: "runway_video" }
    }, { idempotencyKey: idempKey });
    paymentIntentId = pi.id;
  } catch(stripeErr) {
    console.error("[Runway charge]", stripeErr.message);
    return res.status(402).json({ error: "Payment failed: " + (stripeErr.message || "Card declined. Update your payment method in Billing.") });
  }

  // Log the video attempt
  const { v4: uuid } = require("uuid");
  const logId = uuid();
  db.prepare(`INSERT INTO runway_video_log (id, user_id, prompt, duration_requested, status, stripe_payment_intent_id, amount_charged, provider, created_at)
    VALUES (?,?,?,?,?,?,?,?,datetime('now'))`)
    .run(logId, req.userId, prompt.substring(0, 500), requestedDuration, "pending", paymentIntentId, 2500, "runway");

  // Call Runway API
  try {
    const body = {
      model: "gen3a_turbo",
      promptText: prompt,
      duration: requestedDuration,
      ratio: "768:1344", // 9:16 vertical for Reels/TikTok
      watermark: false,
    };
    if (imageUrl) body.promptImage = imageUrl;

    const r = await fetch("https://api.dev.runwayml.com/v1/image_to_video", {
      method: "POST",
      headers: { Authorization: `Bearer ${runwayKey}`, "Content-Type": "application/json", "X-Runway-Version": "2024-11-06" },
      body: JSON.stringify(body),
    });
    const d = await r.json();

    if (d.id) {
      db.prepare("UPDATE runway_video_log SET task_id = ?, status = 'processing' WHERE id = ?").run(d.id, logId);
      return res.json({
        success: true, taskId: d.id, status: "processing", provider: "runway",
        pollUrl: `/hosting/ai/video/status/${d.id}?provider=runway`,
        logId, charged: 25, duration: requestedDuration,
        message: `$25 charged. Generating ${requestedDuration}s video — ready in ~60 seconds.`
      });
    }

    // Runway rejected — refund via Stripe
    console.warn("[Runway] API rejected:", d);
    db.prepare("UPDATE runway_video_log SET status = 'failed' WHERE id = ?").run(logId);
    let refunded = false;
    try {
      const Stripe = require("stripe");
      // Idempotent refund — safe to retry on transient errors
      await Stripe(stripeKey).refunds.create(
        { payment_intent: paymentIntentId },
        { idempotencyKey: `refund-${logId}` }
      );
      refunded = true;
    } catch(refundErr) {
      console.error("[Runway refund]", refundErr.message);
      // Refund failed — persist the failure state so admin-ops /refund can retry.
      // Without this, the user is permanently charged for a video that never ran.
      try {
        db.prepare("UPDATE runway_video_log SET status = 'failed_refund_pending' WHERE id = ?").run(logId);
        db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
          .run(req.userId, "runway_refund_failed", JSON.stringify({
            log_id: logId,
            payment_intent_id: paymentIntentId,
            amount: 2500,
            error: refundErr.message,
          }));
      } catch(e) { console.error("[/ai/video]", e.message || e); }
    }
    return res.status(502).json({
      error: d.error || d.detail || `Runway API rejected the request. ${refunded ? "$25 has been refunded." : "Refund pending — contact support if it doesn't appear in 3-5 business days."}`,
      refunded,
    });

  } catch(apiErr) {
    console.error("[Runway API]", apiErr.message);
    db.prepare("UPDATE runway_video_log SET status = 'failed' WHERE id = ?").run(logId);
    let refunded = false;
    try {
      const Stripe = require("stripe");
      await Stripe(stripeKey).refunds.create(
        { payment_intent: paymentIntentId },
        { idempotencyKey: `refund-${logId}` }
      );
      refunded = true;
    } catch(e) {
      try {
        db.prepare("UPDATE runway_video_log SET status = 'failed_refund_pending' WHERE id = ?").run(logId);
        db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
          .run(req.userId, "runway_refund_failed", JSON.stringify({
            log_id: logId, payment_intent_id: paymentIntentId, amount: 2500, error: e.message,
          }));
      } catch(logErr) { console.error("[/ai/video]", logErr.message || logErr); }
    }
    return res.status(502).json({
      error: `Runway request failed. ${refunded ? "$25 has been refunded." : "Refund pending — contact support."}`,
      refunded,
    });
  }
});  // ← close /ai/video handler. Missing this caused 14 routes below to be
    //   nested inside the handler and effectively 404 in production until
    //   someone first called /ai/video (after which they were registered
    //   again on every subsequent call — memory leak + duplicate handlers).// ═══════════════════════════════════════
// 7. A/B TESTING
// ═══════════════════════════════════════

router.post("/ab/create", auth, (req, res) => {
  const { siteId, name, variantA, variantB, metric } = req.body;
  const db = getDb();
  ensureTables(db);
  const id = uuid();
  db.prepare(`
    INSERT INTO ab_tests (id, site_id, user_id, name, variant_a, variant_b, metric, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'))
  `).run(id, siteId, req.userId, name, JSON.stringify(variantA), JSON.stringify(variantB), metric || "conversion");
  res.json({ success: true, testId: id });
});

// Serve variant (called from deployed site)
router.get("/ab/variant/:testId", (req, res) => {
  const db = getDb();
  ensureTables(db);
  const test = db.prepare("SELECT * FROM ab_tests WHERE id = ? AND status = 'active'").get(req.params.testId);
  if (!test) return res.json({ variant: "a" });
  // 50/50 split based on visitor hash
  const visitorId = req.query.v || req.ip || uuid();
  const variant = hashString(visitorId + test.id) % 2 === 0 ? "a" : "b";
  // Record impression
  db.prepare("INSERT INTO ab_impressions (id, test_id, variant, visitor_id, created_at) VALUES (?,?,?,?,datetime('now'))")
    .run(uuid(), test.id, variant, visitorId);
  const data = variant === "a" ? (function(s){try{return JSON.parse(s);}catch(_){return {};}})(test.variant_a) : (function(s){try{return JSON.parse(s);}catch(_){return {};}})(test.variant_b);
  res.json({ variant, data });
});

// Record conversion
router.post("/ab/convert/:testId", (req, res) => {
  const db = getDb();
  ensureTables(db);
  const { variant, visitorId } = req.body;
  db.prepare("INSERT INTO ab_conversions (id, test_id, variant, visitor_id, created_at) VALUES (?,?,?,?,datetime('now'))")
    .run(uuid(), req.params.testId, variant, visitorId);
  res.json({ ok: true });
});

// Get A/B test results
router.get("/ab/results/:testId", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const test = db.prepare("SELECT * FROM ab_tests WHERE id = ? AND user_id = ?").get(req.params.testId, req.userId);
  if (!test) return res.status(404).json({ error: "Test not found" });

  const impressionsA = db.prepare("SELECT COUNT(*) as n FROM ab_impressions WHERE test_id = ? AND variant = 'a'").get(test.id).n;
  const impressionsB = db.prepare("SELECT COUNT(*) as n FROM ab_impressions WHERE test_id = ? AND variant = 'b'").get(test.id).n;
  const conversionsA = db.prepare("SELECT COUNT(*) as n FROM ab_conversions WHERE test_id = ? AND variant = 'a'").get(test.id).n;
  const conversionsB = db.prepare("SELECT COUNT(*) as n FROM ab_conversions WHERE test_id = ? AND variant = 'b'").get(test.id).n;

  const rateA = impressionsA > 0 ? (conversionsA / impressionsA * 100).toFixed(2) : 0;
  const rateB = impressionsB > 0 ? (conversionsB / impressionsB * 100).toFixed(2) : 0;
  const winner = Number(rateA) > Number(rateB) ? "a" : Number(rateB) > Number(rateA) ? "b" : "tie";
  const confidence = calculateConfidence(conversionsA, impressionsA, conversionsB, impressionsB);

  res.json({
    test: { id: test.id, name: test.name, status: test.status, metric: test.metric },
    variantA: { impressions: impressionsA, conversions: conversionsA, rate: rateA },
    variantB: { impressions: impressionsB, conversions: conversionsB, rate: rateB },
    winner, confidence, significantAt95: confidence >= 95,
  });
});

// ═══════════════════════════════════════
// 8. WEBHOOK INTEGRATIONS
// Zapier, Make, Slack, Calendly
// ═══════════════════════════════════════

router.post("/webhook/send", auth, async (req, res) => {
  const { service, event, data } = req.body;
  const fetch = (await import("node-fetch")).default;

  try {
    switch (service) {
      case "zapier": {
        const url = getSetting("ZAPIER_WEBHOOK_URL");
        if (!url) return res.status(400).json({ error: "Zapier webhook not configured" });
        await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event, ...data, timestamp: new Date().toISOString() }) });
        break;
      }
      case "slack": {
        const url = getSetting("SLACK_WEBHOOK_URL");
        if (!url) return res.status(400).json({ error: "Slack webhook not configured" });
        const emoji = event.includes("order") ? "📦" : event.includes("booking") ? "📅" : event.includes("contact") ? "👤" : "🔔";
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: `${emoji} *${event}*\n${JSON.stringify(data, null, 2)}` }),
        });
        break;
      }
      case "calendly": {
        const key = getSetting("CALENDLY_API_KEY");
        if (!key) return res.status(400).json({ error: "Calendly not configured" });
        // Fetch availability for booking widget
        const r = await fetch("https://api.calendly.com/scheduling_links", {
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        });
        const d = await r.json();
        return res.json({ success: true, data: d });
      }
      case "generic": {
        const { url } = data;
        if (!url) return res.status(400).json({ error: "Webhook URL required" });
        // Validate URL to prevent SSRF
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== "https:") return res.status(400).json({ error: "Webhook URL must use HTTPS" });
          const host = parsed.hostname;
          if (/^(localhost|127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|0\.)/i.test(host) || ["::1","0:0:0:0:0:0:0:1"].includes(host) || /^(fc|fd)[0-9a-f]{2}:/i.test(host) || host === "metadata.google.internal") {
            return res.status(400).json({ error: "Internal URLs not allowed" });
          }
          await fetch(parsed.href, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event, ...data, source: "mine-platform", timestamp: new Date().toISOString() }) });
        } catch(e) {
          if (e.message.includes("Invalid URL") || e.message.includes("not allowed") || e.message.includes("HTTPS")) {
            // Return safe fixed messages instead of raw e.message to prevent info leakage
            const safeMsg = e.message.includes("Invalid URL") ? "Invalid URL" :
                            e.message.includes("HTTPS") ? "Only HTTPS URLs are allowed" :
                            "URL not allowed";
            return res.status(400).json({ error: safeMsg });
          }
          throw e;
        }
        break;
      }
    }
    res.json({ success: true, service, event });
  } catch (e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// ═══════════════════════════════════════
// 9. EMAIL TEMPLATE BUILDER
// Stores drag-drop templates as JSON
// ═══════════════════════════════════════

router.post("/email-template", auth, (req, res) => {
  const { name, blocks, subject, previewText } = req.body;
  const db = getDb();
  ensureTables(db);
  const id = uuid();
  const html = blocksToHTML(blocks || []);
  db.prepare(`
    INSERT INTO email_templates (id, user_id, name, subject, preview_text, blocks, html, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(id, req.userId, name, subject, previewText, JSON.stringify(blocks), html);
  res.json({ success: true, id, html });
});

router.get("/email-templates", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const templates = db.prepare("SELECT id, name, subject, preview_text, updated_at FROM email_templates WHERE user_id = ? ORDER BY updated_at DESC").all(req.userId);
  res.json({ templates });
});

router.put("/email-template/:id", auth, (req, res) => {
  const { name, blocks, subject, previewText } = req.body;
  const db = getDb();
  const html = blocksToHTML(blocks || []);
  db.prepare("UPDATE email_templates SET name = ?, subject = ?, preview_text = ?, blocks = ?, html = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .run(name, subject, previewText, JSON.stringify(blocks), html, req.params.id, req.userId);
  res.json({ success: true, html });
});

// ═══════════════════════════════════════
// 10. SOCIAL MEDIA ANALYTICS
// Pulls from each platform's insights API
// ═══════════════════════════════════════

router.get("/social-analytics", auth, async (req, res) => {
  const db = getDb();
  const fetch = (await import("node-fetch")).default;
  const results = {};

  // Get user tokens
  const tokens = db.prepare("SELECT platform, access_token FROM user_social_tokens WHERE user_id = ?").all(req.userId);
  const tokenMap = {};
  tokens.forEach(t => { tokenMap[t.platform] = t.access_token; });

  // Meta (Facebook + Instagram insights)
  if (tokenMap.meta) {
    try {
      const r = await fetch(`https://graph.facebook.com/v19.0/me?fields=followers_count,fan_count,name&access_token=${tokenMap.meta}`);
      const d = await r.json();
      results.facebook = { followers: d.followers_count || d.fan_count || 0, name: d.name };

      // Instagram via Facebook API
      const igR = await fetch(`https://graph.facebook.com/v19.0/me/accounts?fields=instagram_business_account{followers_count,media_count,username}&access_token=${tokenMap.meta}`);
      const igD = await igR.json();
      const ig = igD.data?.[0]?.instagram_business_account;
      if (ig) results.instagram = { followers: ig.followers_count || 0, posts: ig.media_count || 0, username: ig.username };
    } catch (e) { results.meta_error = e.message; }
  }

  // X (Twitter)
  if (tokenMap.x) {
    try {
      const r = await fetch("https://api.twitter.com/2/users/me?user.fields=public_metrics", {
        headers: { Authorization: `Bearer ${tokenMap.x}` },
      });
      const d = await r.json();
      if (d.data) {
        results.twitter = {
          followers: d.data.public_metrics?.followers_count || 0,
          following: d.data.public_metrics?.following_count || 0,
          tweets: d.data.public_metrics?.tweet_count || 0,
          username: d.data.username,
        };
      }
    } catch (e) { results.twitter_error = e.message; }
  }

  // LinkedIn
  if (tokenMap.linkedin) {
    try {
      const r = await fetch("https://api.linkedin.com/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokenMap.linkedin}` },
      });
      const d = await r.json();
      results.linkedin = { name: d.name, connections: "500+" }; // LinkedIn limits connection count API
    } catch (e) { results.linkedin_error = e.message; }
  }

  // Post history from our DB
  const postHistory = db.prepare(`
    SELECT details FROM audit_log WHERE user_id = ? AND action = 'social_post' ORDER BY rowid DESC LIMIT 20
  `).all(req.userId);

  const posts = postHistory.map(p => { try { return JSON.parse(p.details); } catch { return null; } }).filter(Boolean);
  const totalPosts = posts.length;
  const platformBreakdown = {};
  posts.forEach(p => {
    (p.platforms || []).forEach(pl => { platformBreakdown[pl] = (platformBreakdown[pl] || 0) + 1; });
  });

  res.json({
    accounts: results,
    postHistory: { total: totalPosts, byPlatform: platformBreakdown },
  });
});

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════

function ensureTables(db) {
  // Migrate email_templates for existing DBs
  try { db.exec("ALTER TABLE email_templates ADD COLUMN html TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE email_templates ADD COLUMN preview_text TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE email_templates ADD COLUMN blocks TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE email_templates ADD COLUMN updated_at TEXT"); } catch(e) {}
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_domains (
      id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT, domain TEXT,
      dns_configured INTEGER DEFAULT 0, ssl_status TEXT DEFAULT 'pending',
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS site_analytics (
      id TEXT PRIMARY KEY, site_id TEXT NOT NULL, event TEXT DEFAULT 'pageview',
      page TEXT, referrer TEXT, meta TEXT, user_agent TEXT, ip_hash TEXT, session_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_analytics_site ON site_analytics(site_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_analytics_session ON site_analytics(session_id);
    CREATE TABLE IF NOT EXISTS ab_tests (
      id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT, name TEXT,
      variant_a TEXT, variant_b TEXT, metric TEXT, status TEXT DEFAULT 'active',
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS ab_impressions (
      id TEXT PRIMARY KEY, test_id TEXT, variant TEXT, visitor_id TEXT, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS ab_conversions (
      id TEXT PRIMARY KEY, test_id TEXT, variant TEXT, visitor_id TEXT, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS email_templates (
      id TEXT PRIMARY KEY, user_id TEXT, name TEXT, subject TEXT, preview_text TEXT,
      blocks TEXT, html TEXT, created_at TEXT, updated_at TEXT
    );
  `);
// Change 9: schema-drift ALTERs for ab_tests
try { db.exec("ALTER TABLE ab_tests ADD COLUMN leading_variant TEXT"); } catch(_){}
try { db.exec("ALTER TABLE ab_tests ADD COLUMN significance_pct REAL"); } catch(_){}
  // Change 9: columns the A/B endpoints insert but the original CREATE lacked
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN auto_winner INTEGER DEFAULT 0"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN campaign_id TEXT"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN campaign_type TEXT"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN confidence_threshold REAL"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN element TEXT"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN funnel_id TEXT"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN funnel_step INTEGER"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN goal TEXT"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN test_type TEXT"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN traffic_source TEXT"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN variant_a_color TEXT"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN variant_a_image TEXT"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN variant_a_layout TEXT"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN variant_a_price REAL"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN variant_b_color TEXT"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN variant_b_image TEXT"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN variant_b_layout TEXT"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN variant_b_price REAL"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN variant_c_color TEXT"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN variant_c_cta TEXT"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN variant_c_headline TEXT"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN variant_c_image TEXT"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN variant_c_price REAL"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN variant_d_color TEXT"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN variant_d_cta TEXT"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN variant_d_headline TEXT"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN variant_d_image TEXT"); } catch(_){}
  try { db.exec("ALTER TABLE ab_tests ADD COLUMN variant_d_price REAL"); } catch(_){}
  // Add columns to sites if not exist
  try { db.exec("ALTER TABLE sites ADD COLUMN deploy_url TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE sites ADD COLUMN deploy_method TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE sites ADD COLUMN deployed_at TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE sites ADD COLUMN custom_domain TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE sites ADD COLUMN seo_score INTEGER"); } catch (e) {}
  try { db.exec("ALTER TABLE sites ADD COLUMN seo_data TEXT"); } catch (e) {}
  try { db.exec("ALTER TABLE sites ADD COLUMN s3_url TEXT"); } catch(e) {}
}

function hashIP(ip) {
  let hash = 0;
  for (let i = 0; i < ip.length; i++) { hash = ((hash << 5) - hash) + ip.charCodeAt(i); hash |= 0; }
  return hash.toString(16);
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) { hash = ((hash << 5) - hash) + str.charCodeAt(i); hash |= 0; }
  return Math.abs(hash);
}

function calculateConfidence(cA, nA, cB, nB) {
  if (nA < 10 || nB < 10) return 0;
  const pA = cA / nA, pB = cB / nB;
  const se = Math.sqrt(pA * (1 - pA) / nA + pB * (1 - pB) / nB);
  if (se === 0) return 0;
  const z = Math.abs(pA - pB) / se;
  // Approximate confidence from z-score
  if (z >= 2.576) return 99;
  if (z >= 1.96) return 95;
  if (z >= 1.645) return 90;
  if (z >= 1.28) return 80;
  return Math.round(z / 1.96 * 80);
}

function generateSiteHTML(site, data) {
  const rawColors = data.colors || {};
  // Fetch owner referral code — used in badge URL for commission credit
  let ownerRefCode = 'badge';
  try {
    const db3 = getDb();
    const owner3 = db3.prepare("SELECT referral_code, agency_id FROM users WHERE id=?").get(site.user_id);
    if (owner3) {
      // If user is an agency client, use agency owner's referral code
      if (owner3.agency_id) {
        const agOwner = db3.prepare("SELECT u.referral_code FROM agencies a JOIN users u ON u.id=a.user_id WHERE a.id=?").get(owner3.agency_id);
        if (agOwner && agOwner.referral_code) ownerRefCode = agOwner.referral_code;
      } else if (owner3.referral_code) {
        ownerRefCode = owner3.referral_code;
      }
    }
  } catch(e3) { /* non-fatal */ }
  // Fall back to user's saved brand kit if site has no custom colours
  let brandPrimary = '#2563EB', brandSecondary = '#F59E0B', brandFont = '', brandFavicon = '';
  try {
    const db2 = getDb();
    const bpRow = db2.prepare("SELECT value FROM platform_settings WHERE key = 'BRAND_PRIMARY'").get();
    const bsRow = db2.prepare("SELECT value FROM platform_settings WHERE key = 'BRAND_SECONDARY'").get();
    const bfRow = db2.prepare("SELECT value FROM platform_settings WHERE key = 'BRAND_FONT'").get();
    const bvRow = db2.prepare("SELECT value FROM platform_settings WHERE key = 'BRAND_FAVICON'").get();
    if (bpRow?.value) brandPrimary   = bpRow.value;
    if (bsRow?.value) brandSecondary = bsRow.value;
    if (bfRow?.value) brandFont      = bfRow.value;
    if (bvRow?.value) brandFavicon   = bvRow.value;

    // Per-user/agency overrides — picks the site owner's brand kit if set
    if (site.user_id) {
      try {
        const ufRow = db2.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'BRAND_FAVICON'").get(String(site.user_id));
        const upRow = db2.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'BRAND_PRIMARY'").get(String(site.user_id));
        const usRow = db2.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'BRAND_SECONDARY'").get(String(site.user_id));
        const uffRow= db2.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'BRAND_FONT'").get(String(site.user_id));
        if (ufRow?.value)  brandFavicon   = ufRow.value;
        if (upRow?.value)  brandPrimary   = upRow.value;
        if (usRow?.value)  brandSecondary = usRow.value;
        if (uffRow?.value) brandFont      = uffRow.value;
      } catch(_) {}
    }
  } catch(e) {}
  const colors = {
    primary:   /^#[0-9a-fA-F]{3,8}$/.test(rawColors.primary   || '') ? rawColors.primary   : brandPrimary,
    secondary: /^#[0-9a-fA-F]{3,8}$/.test(rawColors.secondary || '') ? rawColors.secondary : brandSecondary,
  };
  // Apply brand font if set and site has no custom font
  const siteFontFamily = data.font || brandFont || null;
  // Apply brand favicon if set and site has no custom favicon
  const siteFavicon = data.favicon || brandFavicon || null;
  const trackingPixel = `<img src="${BACKEND_URL}/hosting/pixel/${site.id}?p=/" style="position:absolute;opacity:0;width:1px;height:1px" />`;
  // If site.html is a full HTML document (from AI site generator), extract just the body content
  // so the hosting shell can wrap it with tracking pixel, chatbot injection, currency script, etc.
  let rawHtml = data.html || "";
  if (/<!DOCTYPE|<html[\s>]/i.test(rawHtml)) {
    const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) {
      rawHtml = bodyMatch[1];
    }
  }
  // --- Exit-intent / sales popup runtime (reads owner config, renders to visitors) ---
  const popupRuntime = `
<style>
  #mine-popup-ov{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:2147483000;display:none;align-items:center;justify-content:center;padding:20px}
  #mine-popup-bx{background:#fff;border-radius:16px;max-width:420px;width:100%;padding:30px 28px;box-shadow:0 24px 70px rgba(0,0,0,.3);position:relative;font-family:system-ui,-apple-system,sans-serif;text-align:center;animation:minePopIn .25s ease}
  @keyframes minePopIn{from{transform:translateY(16px);opacity:0}to{transform:translateY(0);opacity:1}}
  #mine-popup-x{position:absolute;top:12px;right:14px;background:none;border:none;font-size:22px;color:#94a3b8;cursor:pointer;line-height:1}
  #mine-popup-offer{font-size:19px;font-weight:800;color:#0f172a;line-height:1.35;margin-bottom:14px}
  #mine-popup-code{display:inline-block;font-family:ui-monospace,monospace;font-weight:700;font-size:17px;letter-spacing:1px;color:#2563eb;background:#eef3ff;border:2px dashed #2563eb;border-radius:9px;padding:9px 16px;margin:4px 0 6px;cursor:copy}
  #mine-popup-hint{font-size:12px;color:#94a3b8;margin-top:8px}
</style>
<div id="mine-popup-ov"><div id="mine-popup-bx">
  <button id="mine-popup-x" aria-label="Close">&times;</button>
  <div id="mine-popup-offer"></div>
  <div id="mine-popup-code" style="display:none"></div>
  <div id="mine-popup-hint" style="display:none">Tap the code to copy</div>
</div></div>
<script>
(function(){
  var SITE="${site.id}", API="${BACKEND_URL}";
  var KEY="mine_popup_seen_"+SITE;
  fetch(API+"/api/public/popup/"+SITE).then(function(r){return r.ok?r.json():null;}).then(function(d){
    if(!d||!d.popup)return; var p=d.popup; if(!(p.offer||p.code))return;
    var freq=(p.show_once_per||"session");
    if(freq==="session"&&sessionStorage.getItem(KEY))return;
    if(freq==="ever"&&localStorage.getItem(KEY))return;
    if(freq==="day"){var last=localStorage.getItem(KEY); if(last&&(Date.now()-(+last))<864e5)return;}
    var ov=document.getElementById("mine-popup-ov"); if(!ov)return;
    document.getElementById("mine-popup-offer").textContent=p.offer||"Wait \u2014 here\u2019s a special offer!";
    if(p.code){var c=document.getElementById("mine-popup-code");c.textContent=p.code;c.style.display="inline-block";document.getElementById("mine-popup-hint").style.display="block";c.onclick=function(){try{navigator.clipboard.writeText(p.code);c.textContent="Copied!";setTimeout(function(){c.textContent=p.code;},1200);}catch(e){}};}
    function shown(){ov.style.display="none";sessionStorage.setItem(KEY,"1");if(freq==="ever"||freq==="day")localStorage.setItem(KEY,String(Date.now()));}
    function fire(){if(ov.style.display==="flex")return;ov.style.display="flex";}
    document.getElementById("mine-popup-x").onclick=shown;
    ov.addEventListener("click",function(e){if(e.target===ov)shown();});
    var trig=(p.trigger||"exit");
    if(trig==="exit"){document.addEventListener("mouseout",function(e){if(e.clientY<=0&&!e.relatedTarget)fire();});setTimeout(function(){document.addEventListener("touchstart",function h(){var sy=0;window.addEventListener("scroll",function(){if(window.scrollY<sy-40)fire();sy=window.scrollY;},{passive:true});document.removeEventListener("touchstart",h);});},1500);}
    else if(trig.indexOf("time")===0){var sec=parseInt(trig.replace(/\D/g,""))||15;setTimeout(fire,sec*1000);}
    else if(trig.indexOf("scroll")===0){window.addEventListener("scroll",function(){if((window.scrollY+innerHeight)/document.body.scrollHeight>.6)fire();},{passive:true});}
    else{document.addEventListener("mouseout",function(e){if(e.clientY<=0&&!e.relatedTarget)fire();});}
  }).catch(function(){});
})();
</script>`;
  rawHtml = rawHtml + popupRuntime;
  const baseHTML = rawHtml || `<div style="text-align:center;padding:60px 20px;font-family:system-ui"><h1>${site.name || "My Site"}</h1><p>Powered by TAKEOVA</p></div>`;
  const escAttr = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escAttr(data.seoTitle || site.name || "My Site")}</title>
  <meta name="description" content="${escAttr(data.seoDescription || "")}">
  <meta property="og:title" content="${escAttr(data.seoTitle || site.name || "")}">
  <meta property="og:description" content="${escAttr(data.seoDescription || "")}">
  ${siteFavicon ? `<link rel="icon" href="${siteFavicon}">` : `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>">`}
  <style>
    /* ── Reset ── */
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    :root { --primary: ${colors.primary}; --secondary: ${colors.secondary}; }

    /* ── Base ── */
    html { font-size: 16px; -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
    body { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #1a1a1a; line-height: 1.6; overflow-x: hidden; }

    /* ── Responsive images & media ── */
    img, video, iframe, embed, object { max-width: 100%; height: auto; display: block; }
    picture { display: block; }

    /* ── Typography scale ── */
    h1 { font-size: clamp(1.75rem, 5vw, 3rem); line-height: 1.15; }
    h2 { font-size: clamp(1.4rem, 4vw, 2.25rem); line-height: 1.2; }
    h3 { font-size: clamp(1.15rem, 3vw, 1.6rem); line-height: 1.3; }
    h4, h5, h6 { font-size: clamp(1rem, 2.5vw, 1.2rem); }
    p { font-size: clamp(0.95rem, 2vw, 1.05rem); }

    /* ── Containers ── */
    .container, [class*="container"], section > div, .wrapper, [class*="wrapper"] {
      width: 100%; max-width: 1200px; margin-left: auto; margin-right: auto;
      padding-left: clamp(16px, 4vw, 48px); padding-right: clamp(16px, 4vw, 48px);
    }

    /* ── Auto-responsive grids ── */
    /* 2-col grid → stacks at 600px */
    .grid-2, [class*="grid-2"], .two-col, [class*="two-col"] {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));
      gap: clamp(16px, 3vw, 32px);
    }
    /* 3-col grid → stacks at 480px */
    .grid-3, [class*="grid-3"], .three-col, [class*="three-col"] {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
      gap: clamp(16px, 3vw, 28px);
    }
    /* 4-col grid → 2-col on tablet, 1-col on mobile */
    .grid-4, [class*="grid-4"], .four-col, [class*="four-col"] {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr));
      gap: clamp(12px, 2.5vw, 24px);
    }

    /* ── Flex rows → wrap on mobile ── */
    .flex-row, [class*="flex-row"], .nav-links, .button-group {
      display: flex; flex-wrap: wrap; gap: clamp(8px, 2vw, 16px);
    }

    /* ── Hero sections ── */
    .hero, [class*="hero"], section:first-of-type {
      padding: clamp(48px, 10vw, 120px) clamp(16px, 4vw, 48px);
    }

    /* ── Sections ── */
    section { padding: clamp(32px, 6vw, 80px) clamp(16px, 4vw, 48px); }

    /* ── Nav ── */
    nav { padding: clamp(12px, 2vw, 20px) clamp(16px, 4vw, 48px); }

    /* ── Cards ── */
    .card, [class*="card"], .product-card, [class*="product"] {
      border-radius: clamp(8px, 1.5vw, 16px);
      padding: clamp(16px, 3vw, 28px);
      overflow: hidden;
    }

    /* ── Buttons ── */
    button, .btn, [class*="btn"], a[class*="button"], input[type="submit"] {
      display: inline-block;
      padding: clamp(10px, 2vw, 14px) clamp(20px, 4vw, 32px);
      font-size: clamp(0.875rem, 2vw, 1rem);
      border-radius: clamp(6px, 1vw, 10px);
      cursor: pointer;
      white-space: nowrap;
      text-decoration: none;
    }

    /* ── Form inputs ── */
    input, textarea, select {
      width: 100%; max-width: 100%;
      padding: clamp(10px, 2vw, 14px) clamp(12px, 2.5vw, 16px);
      font-size: clamp(0.9rem, 2vw, 1rem);
      border-radius: clamp(6px, 1vw, 10px);
    }

    /* ── Tables → horizontal scroll on mobile ── */
    table { width: 100%; border-collapse: collapse; }
    .table-wrap, [class*="table-wrap"] { overflow-x: auto; -webkit-overflow-scrolling: touch; }

    /* ── Fixed-width overrides — prevent any element breaking layout ── */
    [style*="width: 9"], [style*="width:9"] { max-width: 100% !important; }
    [style*="min-width: 6"], [style*="min-width:6"],
    [style*="min-width: 7"], [style*="min-width:7"],
    [style*="min-width: 8"], [style*="min-width:8"],
    [style*="min-width: 9"], [style*="min-width:9"] { min-width: 0 !important; }

    /* ── Tablet breakpoint ── */
    @media (max-width: 768px) {
      .hide-mobile { display: none !important; }
      .show-mobile { display: block !important; }
      nav { flex-wrap: wrap; }
      nav ul, nav ol { flex-direction: column; gap: 8px; }
      .hero, [class*="hero"] { text-align: center; }
      .hero img, [class*="hero"] img { margin: 0 auto; }
    }

    /* ── Mobile breakpoint ── */
    @media (max-width: 480px) {
      section { padding: 28px 16px; }
      .hero, [class*="hero"], section:first-of-type { padding: 40px 16px; }
      h1 { font-size: 1.75rem; }
      h2 { font-size: 1.35rem; }
      button, .btn, [class*="btn"] { width: 100%; text-align: center; }
      .flex-row, [class*="flex-row"] { flex-direction: column; }
    }
  </style>
</head>
<body>
  ${baseHTML}
  ${(() => {
    // Auto-inject membership tiers section (storefront fills it client-side) when the owner has tiers and the page lacks one
    try {
      if (/data-mine-memberships/.test(baseHTML)) return "";
      const _mt = getDb().prepare("SELECT COUNT(*) c FROM membership_tiers WHERE user_id = ?").get(site.user_id);
      if (!_mt || !_mt.c) return "";
      return `<section style="padding:56px 20px;background:#F9FAFB"><div style="max-width:1100px;margin:0 auto;text-align:center"><h2 style="font-size:28px;font-weight:800;margin-bottom:8px">Membership Plans</h2><p style="color:#6B7280;margin:0 0 28px">Choose a plan and join in seconds.</p><div data-mine-memberships></div></div></section>`;
    } catch (e) { return ""; }
  })()}
  ${(() => {
      // Auto-inject products section when the owner has products and the page has no product element yet
      try {
        if (/data-mine-products?/.test(baseHTML)) return "";
        const _pc = getDb().prepare("SELECT COUNT(*) c FROM products WHERE site_id = ? OR user_id = ?").get(site.id, site.user_id);
        if (!_pc || !_pc.c) return "";
        return `<section style="padding:56px 20px"><div style="max-width:1100px;margin:0 auto;text-align:center"><h2 style="font-size:28px;font-weight:800;margin-bottom:8px">Shop</h2><p style="color:#6B7280;margin:0 0 28px">Browse our products.</p><div data-mine-products></div></div></section>`;
      } catch (e) { return ""; }
    })()}
  ${trackingPixel}
  <script>
    window.MINE_SITE_ID = '${site.id}';
    window.MINE_API_BASE = '${BACKEND_URL}';
    window.MINE_CURRENCY = '${(() => { try { return JSON.parse(site.settings_json||'{}').currency||'USD'; } catch(e){ return 'USD'; } })()}';
  </script>
  <script src="${BACKEND_URL}/api/hosting/mine-store.js" defer></script>
  <script>
    // MINE Analytics
    (function(){var s=document.createElement('img');s.src='${BACKEND_URL}/hosting/pixel/${site.id}?p='+encodeURIComponent(location.pathname)+'&s='+Math.random().toString(36).substr(2,9);s.style='position:fixed;opacity:0;width:1px;height:1px;pointer-events:none';document.body.appendChild(s);})();
  </script>
  ${(() => {
    // Auto-inject phone call button if voice agent is active
    try {
      const voiceNumber = getDb().prepare("SELECT phone_number FROM user_voice_numbers WHERE user_id = ?").get(site.user_id);
      if (voiceNumber?.phone_number) {
        return `<a href="tel:${voiceNumber.phone_number}" style="position:fixed;bottom:20px;left:20px;width:50px;height:50px;border-radius:25px;background:#06B6D4;color:#fff;display:flex;align-items:center;justify-content:center;font-size:22px;text-decoration:none;box-shadow:0 4px 12px rgba(6,182,212,.3);z-index:998;" title="Call us">📞</a>`;
      }
    } catch (e) {}
    return "";
  })()}
  ${(() => {
    // Auto-inject AI chatbot if enabled
    try {
      const chatbotConfig = getDb().prepare("SELECT enabled FROM chatbot_config WHERE site_id = ?").get(site.id);
      if (chatbotConfig?.enabled) {
        return `<script src="${BACKEND_URL}/platform/chatbot/${site.id}/embed.js"></script>`;
      }
    } catch (e) {}
    return "";
  })()}
  ${(() => {
    // Currency detection + auto-conversion for visitors
    // Reads site's base currency from settings, detects visitor's country, converts prices
    try {
      const settings = JSON.parse(site.settings_json || "{}");
      const baseCurrency = (settings.currency || "USD").toUpperCase();
      const enabledCurrencies = settings.enabledCurrencies || null; // null = convert to any
      return `<script>
(function(){
  var BASE='${baseCurrency}';
  var BACKEND='${BACKEND_URL}';
  var ENABLED=${enabledCurrencies ? JSON.stringify(enabledCurrencies) : 'null'};
  // Fetch geo + rates
  fetch(BACKEND+'/api/hosting/geo',{cache:'force-cache'})
  .then(function(r){return r.json();})
  .then(function(geo){
    var toCur=geo.currency;
    // Skip if visitor currency matches base, or not in enabled list
    if(toCur===BASE)return;
    if(ENABLED&&ENABLED.length&&ENABLED.indexOf(toCur)===-1)return;
    // Rate: BASE→USD→toCur
    var rates=geo.rates||{};
    var baseToUSD=rates[BASE]?1/rates[BASE]:1;
    var rate=baseToUSD*(rates[toCur]||1);
    var sym=geo.symbol||toCur;
    // Price regex: matches $1,234.56  £99  €1.234,56  etc.
    var priceRe=/(\\$|\\u00a3|\\u20ac|A\\$|C\\$|NZ\\$|S\\$|HK\\$|MX\\$|R\\$|AUD|CAD|GBP|EUR|USD|NZD|SGD)\\s?([0-9][0-9,\\.]*)/g;
    // Walk text nodes and replace prices
    function walk(node){
      if(node.nodeType===3){
        var orig=node.nodeValue;
        var updated=orig.replace(priceRe,function(match,p1,p2){
          var num=parseFloat(p2.replace(/,/g,''));
          if(isNaN(num))return match;
          var converted=num*rate;
          // Format: no decimals for large amounts, 2 for small
          var formatted=converted>=1000?Math.round(converted).toLocaleString():converted.toFixed(2);
          return sym+formatted;
        });
        if(updated!==orig)node.nodeValue=updated;
      } else if(node.nodeType===1&&!/(SCRIPT|STYLE|INPUT|TEXTAREA|CODE|PRE)/.test(node.tagName)){
        for(var i=0;i<node.childNodes.length;i++)walk(node.childNodes[i]);
      }
    }
    // Run after DOM ready
    function run(){
      walk(document.body);
      // Show subtle currency notice
      var notice=document.createElement('div');
      notice.style.cssText='position:fixed;bottom:70px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.7);color:#fff;padding:6px 14px;border-radius:20px;font-size:12px;font-family:system-ui;z-index:9990;pointer-events:none;';
      notice.textContent='Prices shown in '+toCur+' (approximate)';
      document.body.appendChild(notice);
      setTimeout(function(){notice.style.opacity='0';notice.style.transition='opacity 1s';},3000);
      setTimeout(function(){if(notice.parentNode)notice.parentNode.removeChild(notice);},4500);
    }
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run);else run();
  }).catch(function(){/* geo failed — show base currency, no conversion */});
})();
</script>`;
    } catch(e) { return ""; }
  })()}
  ${(() => {
    // Auto-inject WhatsApp button if Take Control customer mode is enabled for this user
    try {
      const mcConfig = getDb().prepare(
        "SELECT wa_business_code, customer_mode_enabled FROM mine_control_config WHERE user_id = ? AND enabled = 1 AND whatsapp_verified = 1"
      ).get(site.user_id);
      if (!mcConfig?.wa_business_code || !mcConfig?.customer_mode_enabled) return "";
      const waNumber = (getSetting("WHATSAPP_BUSINESS_NUMBER") || process.env.WHATSAPP_BUSINESS_NUMBER || "").replace(/\D/g, "");
      if (!waNumber) return "";
      const waLink = `https://wa.me/${waNumber}?text=${encodeURIComponent("START-" + mcConfig.wa_business_code)}`;
      // Check if chatbot is also enabled — if so shift WhatsApp up to avoid overlap
      const chatbotOn = (() => { try { return !!getDb().prepare("SELECT enabled FROM chatbot_config WHERE site_id = ?").get(site.id)?.enabled; } catch(e) { return false; } })();
      const bottomOffset = chatbotOn ? "90px" : "20px";
      return `<a href="${waLink}" target="_blank" rel="noopener" style="position:fixed;bottom:${bottomOffset};right:20px;width:50px;height:50px;border-radius:25px;background:#25D366;color:#fff;display:flex;align-items:center;justify-content:center;font-size:24px;text-decoration:none;box-shadow:0 4px 12px rgba(37,211,102,.4);z-index:997;" title="Chat on WhatsApp" aria-label="Chat on WhatsApp">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="#fff" xmlns="http://www.w3.org/2000/svg"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.123.552 4.116 1.52 5.845L.057 23.887a.5.5 0 0 0 .617.611l6.154-1.612A11.942 11.942 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.9 0-3.681-.528-5.2-1.446l-.373-.221-3.865 1.013 1.03-3.763-.245-.389A9.954 9.954 0 0 1 2 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/></svg>
      </a>`;
    } catch (e) {}
    return "";
  })()}

${/* Customer Login Widget — OTP-based email login for courses, memberships, bookings, orders */""}
<div id="mine-customer-login" style="display:none;position:fixed;top:16px;right:16px;z-index:9998;">
  <button onclick="document.getElementById('mine-customer-modal').style.display='flex'" style="background:${data.colors?.primary || "#2563EB"};color:#fff;border:none;padding:8px 16px;border-radius:20px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.15);">
    <span id="mine-customer-name">👤 My Account</span>
  </button>
</div>
<div id="mine-customer-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9999;align-items:center;justify-content:center;">
  <div style="background:#fff;border-radius:16px;padding:32px;max-width:420px;width:90%;max-height:80vh;overflow-y:auto;position:relative;">
    <button onclick="document.getElementById('mine-customer-modal').style.display='none'" style="position:absolute;top:12px;right:16px;background:none;border:none;font-size:20px;cursor:pointer;">&times;</button>
    <div id="mine-login-form">
      <h3 style="margin:0 0 8px;font-size:20px;">Sign in to your account</h3>
      <p style="color:#666;font-size:13px;margin-bottom:16px;">Access your courses, bookings, orders & more</p>
      <input id="mine-login-email" type="email" placeholder="Your email address" style="width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;font-size:14px;margin-bottom:8px;box-sizing:border-box;"/>
      <div id="mine-otp-step" style="display:none;">
        <input id="mine-login-code" type="text" placeholder="Enter 6-digit code" maxlength="6" style="width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;font-size:14px;margin-bottom:8px;box-sizing:border-box;letter-spacing:4px;text-align:center;"/>
      </div>
      <button id="mine-login-btn" onclick="mineCustomerAuth()" style="width:100%;padding:12px;background:${data.colors?.primary || "#2563EB"};color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;">Send Code</button>
      <div id="mine-login-error" style="color:#DC2626;font-size:12px;margin-top:8px;display:none;"></div>
    </div>
    <div id="mine-dashboard" style="display:none;"></div>
  </div>
</div>
<script>
(function(){
  const API='${BACKEND_URL}/api/features';
  const SITE_ID='${site.id}';
  let customerId=localStorage.getItem('mine_customer_id');
  let customerEmail=localStorage.getItem('mine_customer_email');

  // Show login button on sites that have courses, memberships, bookings, or e-commerce
  const siteHtml=document.body.innerHTML.toLowerCase();
  const needsLogin=${JSON.stringify(!!(data.courses?.length || data.memberships?.length || data.bookings?.length || data.products?.length))};
  if(needsLogin||customerId){
    document.getElementById('mine-customer-login').style.display='block';
  }

  if(customerId){
    document.getElementById('mine-customer-name').textContent='👤 My Account';
    loadDashboard();
  }

  window.mineCustomerAuth=async function(){
    const email=document.getElementById('mine-login-email').value;
    const code=document.getElementById('mine-login-code')?.value;
    const btn=document.getElementById('mine-login-btn');
    const err=document.getElementById('mine-login-error');
    err.style.display='none';
    btn.disabled=true;btn.textContent='Please wait...';

    try{
      const r=await fetch(API+'/customer-portal/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({siteId:SITE_ID,email,code:code||undefined})});
      const d=await r.json();
      if(d.sent){
        document.getElementById('mine-otp-step').style.display='block';
        btn.textContent='Verify Code';
        btn.disabled=false;
      }else if(d.customer){
        localStorage.setItem('mine_customer_id',d.customer.id);
        localStorage.setItem('mine_customer_email',d.customer.email);
        customerId=d.customer.id;
        document.getElementById('mine-customer-name').textContent='👤 '+d.customer.name;
        loadDashboard();
      }else{
        err.textContent=d.error||'Invalid code';err.style.display='block';
        btn.textContent='Try Again';btn.disabled=false;
      }
    }catch(e){err.textContent='Connection error';err.style.display='block';btn.textContent='Try Again';btn.disabled=false;}
  };

  window.redeemReward=async function(rewardName,custId){
    try{
      const r=await fetch(API.replace('/features','/features')+'/loyalty/redeem',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({customerId:custId,rewardName:rewardName})});
      const d=await r.json();
      if(d.success){
        alert('🎉 Reward redeemed!\\n\\nYour code: '+d.couponCode+'\\n\\n'+d.instructions+'\\n\\nUse this code at checkout.');
        loadDashboard();
      }else{alert(d.error||'Redemption failed');}
    }catch(e){alert('Error redeeming reward');}
  };

  async function loadDashboard(){
    if(!customerId)return;
    try{
      const r=await fetch(API+'/customer-portal/'+customerId);
      const d=await r.json();
      // Also fetch loyalty details
      try{
        const lr=await fetch(API+'/loyalty/customer/'+customerId);
        const ld=await lr.json();
        if(ld.enabled){
          d.loyaltyTier=ld.currentTier?.name||'Member';
          d.nextTier=ld.nextTier;
          d.rewards=ld.rewards;
          d.milestones=ld.milestones;
          d.redemptions=ld.redemptions;
          d.customer.loyaltyPoints=ld.points;
        }
      }catch(e) { console.error("[/social-analytics]", e.message || e); }
      if(!d.customer){localStorage.removeItem('mine_customer_id');return;}
      const s=d.sections||{};
      let html='<h3 style="margin:0 0 16px;">Welcome back, '+d.customer.name+'</h3>';

      if(s.courses){
        html+='<div style="margin-bottom:20px;"><h4 style="font-size:14px;margin:0 0 8px;">📚 My Courses</h4>';
        d.courses.forEach(c=>{
          html+='<div style="padding:10px;border:1px solid #eee;border-radius:8px;margin-bottom:6px;"><div style="font-weight:600;font-size:13px;">'+c.name+'</div><div style="background:#f3f4f6;border-radius:4px;height:6px;margin:6px 0;overflow:hidden;"><div style="height:100%;background:${data.colors?.primary||"#2563EB"};width:'+(c.progress||0)+'%;border-radius:4px;"></div></div><span style="font-size:11px;color:#666;">'+(c.progress||0)+'% complete'+(c.completed?' ✅':'')+' </span></div>';
        });
        html+='</div>';
      }
      if(s.memberships){
        html+='<div style="margin-bottom:20px;"><h4 style="font-size:14px;margin:0 0 8px;">👑 Memberships</h4>';
        d.memberships.forEach(m=>{html+='<div style="padding:8px 12px;background:#f0fdf4;border-radius:8px;margin-bottom:4px;font-size:13px;">'+m.name+' — <strong style="color:#16a34a;">'+m.status+'</strong></div>';});
        html+='</div>';
      }
      if(s.bookings){
        html+='<div style="margin-bottom:20px;"><h4 style="font-size:14px;margin:0 0 8px;">📅 Upcoming Bookings</h4>';
        d.bookings.forEach(b=>{html+='<div style="padding:8px 12px;border:1px solid #eee;border-radius:8px;margin-bottom:4px;font-size:13px;">'+(b.service_name||"Appointment")+' — '+b.date+' at '+b.time+'</div>';});
        html+='</div>';
      }
      if(s.orders){
        html+='<div style="margin-bottom:20px;"><h4 style="font-size:14px;margin:0 0 8px;">📦 Recent Orders</h4>';
        d.orders.slice(0,5).forEach(o=>{html+='<div style="padding:8px 12px;border:1px solid #eee;border-radius:8px;margin-bottom:4px;font-size:13px;display:flex;justify-content:space-between;"><span>'+o.id.slice(0,8)+'</span><span>$'+(o.total||0)+'</span><span style="color:'+(o.status==="delivered"?"#16a34a":"#f59e0b")+';">'+o.status+'</span></div>';});
        html+='</div>';
      }
      if(s.loyalty){
        html+='<div style="padding:12px;background:linear-gradient(135deg,#fef3c7,#fde68a);border-radius:10px;margin-bottom:16px;text-align:center;"><div style="font-size:11px;color:#92400e;">🏆 '+d.loyaltyTier+' Member</div><div style="font-size:22px;font-weight:800;color:#92400e;">'+(d.customer.loyaltyPoints||0)+' pts</div><div style="font-size:11px;color:#92400e;">'+d.nextReward+'</div></div>';
      }
      // Loyalty section
      html+='<div style="margin-top:16px;padding:14px;background:linear-gradient(135deg,#fef3c7,#fde68a);border-radius:12px;text-align:center;margin-bottom:12px;">';
      html+='<div style="font-size:11px;color:#92400e;font-weight:600;">LOYALTY POINTS</div>';
      html+='<div style="font-size:28px;font-weight:800;color:#78350f;">'+(d.customer.loyaltyPoints||0)+'</div>';
      html+='<div style="font-size:11px;color:#92400e;">'+(d.loyaltyTier||"Bronze")+' Member</div>';
      if(d.nextTier){html+='<div style="font-size:10px;color:#92400e;margin-top:4px;">'+d.nextTier.pointsNeeded+' pts to '+d.nextTier.name+'</div>';}
      html+='</div>';

      // Redeemable rewards
      if(d.rewards&&d.rewards.length>0){
        html+='<div style="margin-bottom:16px;"><h4 style="font-size:13px;margin:0 0 8px;">🎁 Redeem Rewards</h4>';
        d.rewards.forEach(function(r){
          html+='<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border:1px solid '+(r.canRedeem?'#16a34a':'#e5e7eb')+';border-radius:8px;margin-bottom:6px;">';
          html+='<div><div style="font-size:13px;font-weight:600;">'+r.name+'</div><div style="font-size:11px;color:#666;">'+r.pointsCost+' pts</div></div>';
          if(r.canRedeem){
            html+='<button onclick="redeemReward(\\''+r.name+'\\',\\''+customerId+'\\');this.disabled=true;this.textContent=\\'Redeeming...\\';" style="padding:6px 14px;background:#16a34a;color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;">Redeem</button>';
          }else{
            html+='<span style="font-size:11px;color:#999;">Need '+(r.pointsCost-(d.customer.loyaltyPoints||0))+' more pts</span>';
          }
          html+='</div>';
        });
        html+='</div>';
      }

      // Active reward codes
      if(d.redemptions&&d.redemptions.length>0){
        html+='<div style="margin-bottom:16px;"><h4 style="font-size:13px;margin:0 0 8px;">🏷️ Your Codes</h4>';
        d.redemptions.filter(function(r){return !r.used;}).forEach(function(r){
          html+='<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#f0fdf4;border-radius:8px;margin-bottom:4px;">';
          html+='<div><div style="font-size:12px;font-weight:600;">'+r.reward_name+'</div></div>';
          html+='<code style="background:#dcfce7;padding:4px 10px;border-radius:4px;font-size:13px;font-weight:700;color:#16a34a;cursor:pointer;" onclick="navigator.clipboard.writeText(\\''+r.coupon_code+'\\');this.textContent=\\'Copied!\\';setTimeout(()=>this.textContent=\\''+r.coupon_code+'\\',1500);">'+r.coupon_code+'</code>';
          html+='</div>';
        });
        html+='</div>';
      }

      // Milestones
      if(d.milestones&&d.milestones.length>0){
        html+='<div style="margin-bottom:16px;"><h4 style="font-size:13px;margin:0 0 8px;">🎯 Milestones</h4>';
        d.milestones.forEach(function(m){
          html+='<div style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:12px;">';
          html+='<span>'+(m.achieved?'✅':'⬜')+'</span>';
          html+='<span style="'+(m.achieved?'text-decoration:line-through;color:#999;':'color:#333;')+'">'+(m.icon||'🎯')+' '+m.name+' — '+m.reward+' pts</span>';
          html+='</div>';
        });
        html+='</div>';
      }

      html+='<button onclick="localStorage.removeItem(\\'mine_customer_id\\');localStorage.removeItem(\\'mine_customer_email\\');location.reload();" style="width:100%;padding:10px;background:#f3f4f6;border:none;border-radius:8px;font-size:13px;cursor:pointer;margin-top:8px;">Sign Out</button>';

      document.getElementById('mine-login-form').style.display='none';
      document.getElementById('mine-dashboard').style.display='block';
      document.getElementById('mine-dashboard').innerHTML=html;
    }catch(e) { console.error("[/social-analytics]", e.message || e); }
  }
})();
</script>
<script>
// MINE Analytics — page view tracking
(function(){try{fetch('/api/features/track/pageview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({siteId:'${site.id}',path:location.pathname,referrer:document.referrer,userAgent:navigator.userAgent})});}catch(e){}})();
// Auto-notify on form submissions
document.addEventListener('submit',function(e){
  var form=e.target;if(!form||form.tagName!=='FORM')return;
  var data={};new FormData(form).forEach(function(v,k){data[k]=v;});
  var email=data.email||data.Email||'';var name=data.name||data.Name||data.first_name||'';
  fetch('/api/features/forms/submission-notify',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({siteId:'${site.id}',formName:form.getAttribute('data-form-name')||'Contact Form',submitterEmail:email,submitterName:name,fields:data})}).catch(function(){});
});
// Chatbot lead capture → CRM
window._mineCaptureLeadFromChat=function(email,name){
  if(!email)return;
  fetch('/api/data/contacts',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer __SITE_TOKEN__'},
    body:JSON.stringify({name:name||email.split('@')[0],email:email,status:'lead',source:'chatbot'})}).catch(function(){});
};
</script>

  <!-- Powered by TAKEOVA badge — links back with owner/agency referral code for commission credit -->
  <div id="mine-badge" style="position:fixed;bottom:16px;right:16px;z-index:9999;opacity:0;transition:opacity .3s" onmouseenter="this.style.opacity=1" onmouseleave="this.style.opacity=.7">
    <a href="https://takeova.ai?ref=${ownerRefCode}&utm_source=mine_badge&utm_medium=site&utm_campaign=${encodeURIComponent(site.name||'site')}&utm_content=badge"
       target="_blank" rel="noopener"
       style="display:flex;align-items:center;gap:6px;background:rgba(15,23,42,.85);backdrop-filter:blur(8px);border:1px solid rgba(99,91,255,.4);border-radius:20px;padding:5px 10px 5px 7px;text-decoration:none;box-shadow:0 4px 12px rgba(0,0,0,.3)">
      <img src="https://takeova.ai/icon-192.png" width="18" height="18" style="border-radius:4px;flex-shrink:0" alt="MINE">
      <span style="font-size:11px;font-weight:600;color:#fff;font-family:system-ui;white-space:nowrap">Powered by TAKEOVA</span>
    </a>
  </div>
  <script>
    (function(){
      // Show badge after 1s — smooth entrance
      setTimeout(function(){
        var b=document.getElementById('mine-badge');
        if(b) b.style.opacity='0.7';
      }, 1000);
    })();
  </script>
</body>
</html>`;
}

function generateSitemap(site, data) {
  const baseUrl = site.custom_domain ? `https://${site.custom_domain}` : site.deploy_url || "";
  const products = data.products || [];
  const blogs = data.blogPosts || [];

  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
  xml += `  <url><loc>${baseUrl}/</loc><priority>1.0</priority></url>\n`;
  products.forEach(p => { xml += `  <url><loc>${baseUrl}/product/${p.id || p.name?.toLowerCase().replace(/\s/g, "-")}</loc><priority>0.8</priority></url>\n`; });
  blogs.forEach(b => { xml += `  <url><loc>${baseUrl}/blog/${b.id || b.title?.toLowerCase().replace(/\s/g, "-")}</loc><priority>0.6</priority></url>\n`; });
  xml += `</urlset>`;
  return xml;
}

function blocksToHTML(blocks) {
  return blocks.map(block => {
    switch (block.type) {
      case "header": return `<div style="padding:32px 24px;text-align:center;background:${block.bg || "#2563EB"};color:${block.color || "#fff"}"><h1 style="font-size:28px;margin-bottom:8px">${block.title || ""}</h1><p style="font-size:14px;opacity:.8">${block.subtitle || ""}</p></div>`;
      case "text": return `<div style="padding:24px;max-width:600px;margin:0 auto;font-size:${block.fontSize || 14}px;line-height:1.7;color:${block.color || "#333"}">${block.content || ""}</div>`;
      case "image": return `<div style="padding:16px;text-align:center"><img src="${block.src || ""}" alt="${block.alt || ""}" style="max-width:100%;border-radius:8px" /></div>`;
      case "button": return `<div style="padding:16px;text-align:center"><a href="${block.url || "#"}" style="display:inline-block;padding:14px 32px;background:${block.bg || "#2563EB"};color:${block.color || "#fff"};text-decoration:none;border-radius:8px;font-weight:600">${block.text || "Click Here"}</a></div>`;
      case "divider": return `<hr style="border:none;border-top:1px solid #eee;margin:24px auto;max-width:600px" />`;
      case "spacer": return `<div style="height:${block.height || 32}px"></div>`;
      case "columns": return `<div style="display:flex;gap:16px;padding:16px;max-width:600px;margin:0 auto">${(block.columns || []).map(c => `<div style="flex:1">${c.content || ""}</div>`).join("")}</div>`;
      case "social": return `<div style="padding:16px;text-align:center">${(block.links || []).map(l => `<a href="${l.url}" style="margin:0 8px;font-size:20px;text-decoration:none">${l.icon || "🔗"}</a>`).join("")}</div>`;
      case "footer": return `<div style="padding:24px;text-align:center;font-size:12px;color:#999;background:#f9f9f9"><p>${block.text || ""}</p><p style="margin-top:8px"><a href="{unsubscribe}" style="color:#999">Unsubscribe</a></p></div>`;
      default: return `<div style="padding:16px">${block.content || ""}</div>`;
    }
  }).join("\n");
}

// ═══════════════════════════════════════
// IMPORT EXISTING WEBSITE
// Scrapes URL → extracts content → AI rebuilds as MINE site
// ═══════════════════════════════════════


router.post("/import", auth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL required" });

  try {
    const fetch = (await import("node-fetch")).default;

    // 1. Fetch the page HTML (SSRF-safe — blocks private IPs + validates redirects)
    let pageHtml = "";
    try {
      const r = await safeFetch(url, { timeout: 15000 });
      pageHtml = await r.text();
    } catch (fetchErr) {
      return res.json({ error: "Could not reach that URL. Check it's accessible.", html: null });
    }

    // 2. Extract useful content from HTML (strip scripts, styles, get text + images + structure)
    const titleMatch = pageHtml.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : "";

    // Extract meta description
    const metaDescMatch = pageHtml.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
    const metaDesc = metaDescMatch ? metaDescMatch[1].trim() : "";

    // Extract all text content (strip tags)
    const bodyMatch = pageHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const bodyHtml = bodyMatch ? bodyMatch[1] : pageHtml;
    const textContent = bodyHtml
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 3000);

    // Extract image URLs
    const imgMatches = [...pageHtml.matchAll(/<img[^>]*src=["']([^"']+)["']/gi)];
    const images = imgMatches.slice(0, 10).map(m => {
      let src = m[1];
      if (src.startsWith("//")) src = "https:" + src;
      else if (src.startsWith("/")) {
        try { const u = new URL(url.startsWith("http") ? url : "https://" + url); src = u.origin + src; } catch(e){}
      }
      return src;
    }).filter(s => s.startsWith("http") && !s.includes("pixel") && !s.includes("tracking"));

    // Extract headings
    const h1Matches = [...pageHtml.matchAll(/<h[1-3][^>]*>([^<]+)<\/h[1-3]>/gi)];
    const headings = h1Matches.slice(0, 8).map(m => m[1].trim());

    // Extract nav links
    const navMatches = [...pageHtml.matchAll(/<a[^>]*>([^<]{2,30})<\/a>/gi)];
    const navLinks = [...new Set(navMatches.slice(0, 12).map(m => m[1].trim()))].filter(l => l.length > 1 && l.length < 25);

    // 3. Send to AI to rebuild
    const ANTHROPIC_KEY = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_KEY) {
      return res.json({ error: "AI not configured", html: null, extracted: { title, metaDesc, textContent: textContent.substring(0, 500), images: images.slice(0, 3), headings } });
    }

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        messages: [{ role: "user", content: `You are a website rebuilder. Rebuild this website as a modern, mobile-first, responsive HTML page.

ORIGINAL SITE INFO:
- Title: ${title}
- Description: ${metaDesc}
- Headings: ${headings.join(", ")}
- Nav links: ${navLinks.join(", ")}
- Content: ${textContent.substring(0, 2000)}
- Images: ${images.slice(0, 5).join(", ")}

RULES:
- Output ONLY complete HTML with inline CSS. No markdown, no explanation.
- Use modern design: clean fonts, good spacing, professional colors.
- Make it mobile-first responsive using clamp(), flexbox, CSS grid.
- No fixed widths over 400px. Use max-width and %.
- Include the original images where appropriate.
- Keep the same branding, colors, and tone as the original.
- Add a sticky header, hero section, content sections, and footer.
- Make buttons and CTAs prominent.
- Include all the original content and structure.` }]
      })
    });

    const aiData = await aiRes.json();
    const html = aiData.content?.[0]?.text || "";
    const cleanHtml = html.replace(/```html\n?/g, "").replace(/```\n?/g, "").trim();

    // 4. Save import record
    const db = getDb();
    try {
      db.exec("CREATE TABLE IF NOT EXISTS site_imports (id TEXT PRIMARY KEY, user_id TEXT, source_url TEXT, title TEXT, created_at TEXT DEFAULT (datetime('now')))");
      db.prepare("INSERT INTO site_imports (id, user_id, source_url, title) VALUES (?,?,?,?)").run(require("uuid").v4(), req.userId, url, title);
    } catch(e) {}

    res.json({
      success: true,
      html: cleanHtml,
      extracted: { title, description: metaDesc, headings, images: images.slice(0, 5), navLinks }
    });

  } catch (e) {
    console.error("[Route] Import failed: ", e?.message);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

/* ══════════════════════════════════════════
   INSPIRATION SCRAPER
══════════════════════════════════════════ */
router.post("/inspiration", auth, async (req, res) => {
  const { urls, businessName, businessType } = req.body;
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: "At least one URL required" });
  }
  const safeUrls = urls.slice(0, 3).map(u => u.startsWith("http") ? u : "https://" + u);
  const fetch = (await import("node-fetch")).default;
  const ANTHROPIC_KEY = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;

  const scraped = [];
  for (const url of safeUrls) {
    try {
      const r = await safeFetch(url, { timeout: 10000 });
      const html = await r.text();
      const colorMatches = [...html.matchAll(/#([0-9A-Fa-f]{6})\b/g)];
      const colors = [...new Set(colorMatches.map(m => "#" + m[1]).filter(c => {
        const hx = c.replace("#","");
        const rv = parseInt(hx.substr(0,2),16), gv = parseInt(hx.substr(2,2),16), bv = parseInt(hx.substr(4,2),16);
        return (Math.max(rv,gv,bv) - Math.min(rv,gv,bv)) > 20;
      }))].slice(0, 8);
      const fontMatches = [...html.matchAll(/font-family\s*:\s*['"]?([^;,'"{}]+)/gi)];
      const fonts = [...new Set(fontMatches.map(m => m[1].trim().replace(/['"]/g,"")).filter(f => f.length > 2 && !f.includes("inherit") && !f.includes("var(")))].slice(0,4);
      const gFonts = [...html.matchAll(/fonts\.googleapis\.com\/css\?family=([^&"']+)/gi)].map(m => decodeURIComponent(m[1]).replace(/\+/g," ").split(":")[0]);
      const headings = [...html.matchAll(/<h[1-2][^>]*>([^<]{3,60})<\/h[1-2]>/gi)].map(m => m[1].replace(/<[^>]+>/g,"").trim()).slice(0,5);
      const navItems = [...html.matchAll(/<(?:nav|header)[^>]*>([\s\S]{0,2000}?)<\/(?:nav|header)>/gi)].flatMap(m => [...m[1].matchAll(/<a[^>]*>([^<]{2,25})<\/a>/gi)].map(a => a[1].trim())).filter(Boolean).slice(0,8);
      const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i)||[])[1]||url;
      const metaDesc = (html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i)||[])[1]||"";
      const styleSignals = [
        html.match(/#[012][0-9a-f]{5}/gi)?.length > 5 ? "dark theme" : null,
        /animation|keyframes/i.test(html) ? "animated" : null,
        /display.*grid|card/i.test(html) ? "card grid layout" : null,
        /gradient/i.test(html) ? "gradients" : null,
        /parallax|100vh/i.test(html) ? "fullscreen sections" : null,
      ].filter(Boolean);
      scraped.push({ url, title, metaDesc, colors, fonts: [...gFonts,...fonts].slice(0,4), headings, navItems, styleSignals });
    } catch(e) {
      scraped.push({ url, error: e.message });
    }
  }

  const ok = scraped.filter(s => !s.error);
  if (!ok.length) return res.status(400).json({ error: "Could not reach any of the URLs provided." });

  if (!ANTHROPIC_KEY) return res.json({ success: true, scraped: ok, synthesis: null });

  // Build site context as plain string (avoid nested template literals)
  let siteContext = "";
  ok.forEach(function(s, i) {
    siteContext += "Site " + (i+1) + ": " + s.url + "\n";
    siteContext += "  Title: " + s.title + "\n";
    siteContext += "  Description: " + s.metaDesc + "\n";
    siteContext += "  Colours: " + s.colors.join(", ") + "\n";
    siteContext += "  Fonts: " + s.fonts.join(", ") + "\n";
    siteContext += "  Nav: " + s.navItems.join(", ") + "\n";
    siteContext += "  Style: " + s.styleSignals.join(", ") + "\n\n";
  });

  const prompt = "You are a web design director. A client wants to build a website for their " + (businessType||"business") + ' called "' + (businessName||"their business") + '". They provided these inspiration sites:\n\n' + siteContext + "\nAnalyse and write a concise design brief (150 words max) covering:\n1. COLOUR DIRECTION — specific hex codes for primary, secondary, accent\n2. TYPOGRAPHY — heading font + body font recommendation\n3. LAYOUT — sections to include in order\n4. MOOD — 3-4 words\n5. WHAT TO STEAL — best specific elements from each site\n\nReturn ONLY the brief, no preamble.";

  try {
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 600, messages: [{ role: "user", content: prompt }] })
    });
    const aiData = await aiRes.json();
    const synthesis = aiData.content?.[0]?.text?.trim() || null;
    const allColors = ok.flatMap(s => s.colors);
    const allFonts  = [...new Set(ok.flatMap(s => s.fonts))].filter(Boolean);
    res.json({ success: true, sitesScraped: ok.length, scraped: ok, synthesis, aggregated: { colors: allColors.slice(0,10), fonts: allFonts.slice(0,5) } });
  } catch(e) {
    res.json({ success: true, scraped: ok, synthesis: null, error: e.message });
  }
});

/* ══════════════════════════════════════════
   SEO KEYWORD RESEARCH — Perplexity powered
══════════════════════════════════════════ */
router.post('/seo/keywords/:siteId', auth, async (req, res) => {
  try {
    const db = getDb();
    const site = db.prepare('SELECT * FROM sites WHERE id = ? AND user_id = ?').get(req.params.siteId, req.userId);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const { doResearch } = require('./ai-employees');
    const anthropicKey = getSetting('ANTHROPIC_API_KEY');
    const siteData = JSON.parse(site.data || '{}');
    const products = (siteData.products || []).slice(0, 5).map(p => p.name).join(', ');
    const services = (siteData.bookings || []).slice(0, 5).map(b => b.title).join(', ');
    const businessType = site.template || 'small business';

    const query = `SEO keyword research for ${site.name} — a ${businessType}${products ? ' selling ' + products : ''}${services ? ' offering ' + services : ''}. Find:
1. Top 10 high-intent keywords with estimated monthly search volume
2. Long-tail keywords (3-5 words) with lower competition
3. Local SEO keywords if applicable
4. Competitor keywords — what similar businesses rank for
5. Featured snippet opportunities
6. Question keywords (People Also Ask)
7. Current search trends in this niche
Be specific with real data, search volumes, and keyword difficulty estimates.`;

    const research = await doResearch(query, getSetting);

    // Structure with Claude if available
    let keywords = [];
    let insights = research.text || '';

    if (anthropicKey && research.text) {
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': anthropicKey, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 2000,
            messages: [{ role: 'user', content: `Based on this SEO research:\n\n${research.text}\n\nExtract and structure into JSON. Return ONLY JSON, no markdown:\n{"keywords":[{"keyword":"...","volume":"1k-10k","difficulty":"low|medium|high","intent":"informational|commercial|transactional","opportunity":"why this is good for ${site.name}"}],"quickWins":["keyword 1","keyword 2"],"contentIdeas":[{"title":"Blog post title","targetKeyword":"...","searchVolume":"..."}],"localKeywords":["..."],"citations":${JSON.stringify(research.citations || [])}}` }] })
        });
        const d = await r.json();
        const text = (d.content || []).map(b => b.text || '').join('');
        const clean = text.replace(/```json|```/g, '').trim();
        const parsed = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(clean);
        keywords = parsed.keywords || [];
        insights = parsed;
      } catch(e) { console.error("[/keywords/:siteId]", e.message || e); }
    }

    res.json({ success: true, keywords, insights, source: research.source, citations: research.citations || [], business: site.name });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

/* ══════════════════════════════════════════
   PRICING RESEARCH — Perplexity powered
══════════════════════════════════════════ */
router.post('/seo/pricing-research', auth, async (req, res) => {
  try {
    const { product_name, category, location } = req.body;
    if (!product_name) return res.status(400).json({ error: 'product_name required' });

    const { doResearch } = require('./ai-employees');
    const anthropicKey = getSetting('ANTHROPIC_API_KEY');

    const query = `Market pricing research for "${product_name}"${category ? ' in the ' + category + ' category' : ''}${location ? ' in ' + location : ''}:
1. Price range — what do competitors charge (low, mid, premium tiers)?
2. Average market price
3. What justifies premium pricing in this market?
4. Common pricing models (one-time, subscription, per unit)
5. Any recent pricing trends — are prices going up or down?
6. What customers expect to pay and what they consider good value
Give specific dollar amounts and cite sources.`;

    const research = await doResearch(query, getSetting);

    let structured = null;
    if (anthropicKey && research.text) {
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': anthropicKey, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 1000,
            messages: [{ role: 'user', content: `Based on this pricing research:\n\n${research.text}\n\nReturn ONLY this JSON, no markdown:\n{"priceRange":{"low":"$X","mid":"$X","premium":"$X"},"marketAverage":"$X","recommendedPrice":"$X","pricingModel":"...","justification":"...","trend":"up|down|stable","citations":${JSON.stringify(research.citations || [])}}` }] })
        });
        const d = await r.json();
        const text = (d.content || []).map(b => b.text || '').join('');
        structured = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(text.replace(/```json|```/g, '').trim());
      } catch(e) { console.error("[/seo/pricing-research]", e.message || e); }
    }

    res.json({ success: true, research: structured || research.text, source: research.source, citations: research.citations || [] });
  } catch(e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});


// ── GET /api/hosting/geo ── IP → country → currency (public, called by site visitors) ──
const geoLimiter = require("express-rate-limit")({ windowMs: 60_000, max: 60, keyGenerator: r => r.ip });
// Rate limiter for property enquiry form (prevents spam emails to property owners)
const propertyEnquiryLimiter = require("express-rate-limit")({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  keyGenerator: (req) => req.ip + ":" + (req.params?.propertyId || ""),
  message: { error: "Too many enquiries from this IP, please wait an hour" },
  standardHeaders: true,
  legacyHeaders: false,
});


const COUNTRY_CURRENCY = {
  AU:"AUD",NZ:"NZD",GB:"GBP",IE:"EUR",DE:"EUR",FR:"EUR",IT:"EUR",ES:"EUR",NL:"EUR",BE:"EUR",
  AT:"EUR",PT:"EUR",FI:"EUR",GR:"EUR",LU:"EUR",MT:"EUR",CY:"EUR",SK:"EUR",SI:"EUR",EE:"EUR",
  LV:"EUR",LT:"EUR",US:"USD",CA:"CAD",MX:"MXN",BR:"BRL",AR:"ARS",CL:"CLP",CO:"COP",PE:"PEN",
  IN:"INR",PK:"PKR",BD:"BDT",SG:"SGD",MY:"MYR",TH:"THB",PH:"PHP",ID:"IDR",VN:"VND",JP:"JPY",
  KR:"KRW",CN:"CNY",HK:"HKD",TW:"TWD",ZA:"ZAR",NG:"NGN",KE:"KES",GH:"GHS",EG:"EGP",
  AE:"AED",SA:"SAR",QA:"QAR",KW:"KWD",IL:"ILS",TR:"TRY",RU:"RUB",UA:"UAH",PL:"PLN",
  CZ:"CZK",HU:"HUF",RO:"RON",SE:"SEK",DK:"DKK",NO:"NOK",CH:"CHF",
};

let rateCache = { rates: {}, fetchedAt: 0 };

async function getExchangeRates() {
  const now = Date.now();
  if (rateCache.fetchedAt && (now - rateCache.fetchedAt) < 6 * 3600 * 1000) return rateCache.rates;
  try {
    const fetch = (await import("node-fetch")).default;
    const r = await fetch("https://open.er-api.com/v6/latest/USD", { timeout: 5000 });
    const d = await r.json();
    if (d.result === "success" && d.rates) { rateCache = { rates: d.rates, fetchedAt: now }; return d.rates; }
  } catch(e) { console.error("[/seo/pricing-research]", e.message || e); }
  return rateCache.rates || { USD:1,GBP:0.79,EUR:0.92,AUD:1.53,CAD:1.36,NZD:1.65,SGD:1.34,JPY:149.5,INR:83.1,MXN:17.2,BRL:4.97,ZAR:18.8,AED:3.67,SAR:3.75,CHF:0.89,SEK:10.4,DKK:6.89,NOK:10.6,HKD:7.82,CNY:7.24,KRW:1325,THB:35.1 };
}

const CURRENCY_SYMBOLS = {
  USD:"$",GBP:"\u00a3",EUR:"\u20ac",AUD:"A$",CAD:"C$",NZD:"NZ$",SGD:"S$",HKD:"HK$",
  JPY:"\u00a5",CNY:"\u00a5",KRW:"\u20a9",INR:"\u20b9",THB:"\u0e3f",PHP:"\u20b1",IDR:"Rp",VND:"\u20ab",
  MXN:"MX$",BRL:"R$",ZAR:"R",NGN:"\u20a6",KES:"KSh",EGP:"E\u00a3",AED:"AED",SAR:"SAR",
  ILS:"\u20aa",TRY:"\u20ba",RUB:"\u20bd",PLN:"z\u0142",CZK:"K\u010d",HUF:"Ft",RON:"lei",
  SEK:"kr",DKK:"kr",NOK:"kr",CHF:"Fr",
};

router.get("/geo", geoLimiter, async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=3600");
  try {
    const ip = (req.headers["cf-connecting-ip"] || req.headers["x-real-ip"] ||
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress || "").replace("::ffff:", "");
    if (!ip || ip === "127.0.0.1" || ip.startsWith("192.168.") || ip.startsWith("10.") || ip === "::1") {
      const rates = await getExchangeRates();
      return res.json({ country:"US", currency:"USD", symbol:"$", rate:1, rates });
    }
    const fetch = (await import("node-fetch")).default;
    const geoRes = await fetch("https://ipapi.co/"+ip+"/json/", { timeout: 3000 });
    const geo = await geoRes.json();
    const country = geo.country_code || "US";
    const currency = COUNTRY_CURRENCY[country] || "USD";
    const rates = await getExchangeRates();
    res.json({ country, currency, symbol: CURRENCY_SYMBOLS[currency] || currency, rate: rates[currency] || 1, rates });
  } catch(e) {
    const rates = await getExchangeRates().catch(() => ({}));
    res.json({ country:"US", currency:"USD", symbol:"$", rate:1, rates });
  }
});


// ── PUBLIC: Property listings for hosted real estate sites ────────────────────
router.get("/properties/:siteId", (req, res) => {
  try {
    const db = getDb();
    const site = db.prepare("SELECT user_id FROM sites WHERE id = ?").get(req.params.siteId);
    if (!site) return res.status(404).json({ error: "Site not found" });
    const { status, type } = req.query;
    let q = "SELECT * FROM property_listings WHERE user_id = ? AND status NOT IN ('archived')";
    const params = [site.user_id];
    if (status) { q += " AND status=?"; params.push(status); }
    if (type) { q += " AND type=?"; params.push(type); }
    q += " ORDER BY listed_at DESC";
    try {
      const properties = db.prepare(q).all(...params);
      res.json({ properties: properties.map(p => ({
        ...p,
        images: JSON.parse(p.images||'[]'),
        features: JSON.parse(p.features||'[]'),
        open_home_dates: JSON.parse(p.open_home_dates||'[]')
      }))});
    } catch(e) { res.json({ properties: [] }); }
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── PUBLIC: Staff list + availability for booking pages ───────────────────────
router.get("/staff/:siteId", (req, res) => {
  try {
    const db = getDb();
    const site = db.prepare("SELECT user_id FROM sites WHERE id = ?").get(req.params.siteId);
    if (!site) return res.status(404).json({ error: "Site not found" });
    try {
      const staff = db.prepare("SELECT id,name,role,bio,avatar,color FROM staff_profiles WHERE user_id=? AND active=1 ORDER BY name").all(site.user_id);
      const staffWithServices = staff.map(s => {
        try {
          const services = db.prepare(`SELECT sv.id,sv.name,sv.duration_minutes,sv.price FROM services sv
            JOIN staff_services ss ON ss.service_id=sv.id WHERE ss.staff_id=? AND sv.active=1`).all(s.id);
          return { ...s, services };
        } catch(e) { return { ...s, services: [] }; }
      });
      res.json({ staff: staffWithServices });
    } catch(e) { res.json({ staff: [] }); }
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── PUBLIC: Class schedule for fitness sites ──────────────────────────────────
router.get("/classes/:siteId", (req, res) => {
  try {
    const db = getDb();
    const site = db.prepare("SELECT user_id FROM sites WHERE id = ?").get(req.params.siteId);
    if (!site) return res.status(404).json({ error: "Site not found" });
    const from = req.query.from || new Date().toISOString().split("T")[0];
    try {
      const classes = db.prepare(`SELECT cs.*,sp.name as staff_name FROM class_schedules cs
        LEFT JOIN staff_profiles sp ON sp.id=cs.staff_id
        WHERE cs.user_id=? AND cs.date>=? AND cs.status='scheduled' ORDER BY cs.date,cs.start_time LIMIT 30`)
        .all(site.user_id, from);
      res.json({ classes: classes.map(c => ({ ...c, spots_remaining: c.capacity - c.enrolled })) });
    } catch(e) { res.json({ classes: [] }); }
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});


// ── PUBLIC: Client proof gallery viewer ──────────────────────────────────────
router.get("/gallery/:galleryId", async (req, res) => {
  const safeGalleryId = String(req.params.galleryId || '').replace(/[^a-zA-Z0-9_-]/g, '');  // sanitize before interpolating into served HTML/JS
  try {
    const db = getDb();
    const gallery = db.prepare("SELECT * FROM client_proof_galleries WHERE id=?").get(safeGalleryId);
    if (!gallery) return res.status(404).send("<h1>Gallery not found</h1>");
    if (gallery.expires_at && new Date(gallery.expires_at) < new Date()) return res.send(`<!DOCTYPE html><html><body style="font-family:system-ui;text-align:center;padding:80px"><h2>This gallery has expired</h2><p>Please contact your photographer for a new link.</p></body></html>`);
    const images = JSON.parse(gallery.images||"[]");
    const selections = JSON.parse(gallery.client_selections||"[]");
    const needsPassword = !!gallery.password;
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(gallery.title)} — Your Photos</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:#0a0a0a;color:#fff;min-height:100vh}
.header{padding:24px;border-bottom:1px solid #222;display:flex;justify-content:space-between;align-items:center}
.h1{font-size:20px;font-weight:800}.sub{color:#888;font-size:13px}
.gate{max-width:360px;margin:80px auto;padding:32px;background:#111;border-radius:16px;border:1px solid #222}
.gfield{margin-bottom:14px}label{display:block;font-size:12px;color:#888;margin-bottom:5px}
input{width:100%;padding:10px 14px;background:#1a1a1a;border:1px solid #333;border-radius:8px;color:#fff;font-size:14px;font-family:inherit}
.btn{display:inline-block;padding:10px 24px;background:#2563EB;color:#fff;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-family:inherit;font-size:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:3px;padding:3px}
.img-wrap{position:relative;aspect-ratio:3/2;overflow:hidden;cursor:pointer}
.img-wrap img{width:100%;height:100%;object-fit:cover;transition:transform .3s}
.img-wrap:hover img{transform:scale(1.04)}
.sel-badge{position:absolute;top:8px;right:8px;background:#2563EB;color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;display:none}
.img-wrap.selected .sel-badge{display:flex}
.img-wrap.selected::after{content:"";position:absolute;inset:0;background:rgba(99,91,255,.3);border:3px solid #2563EB}
.watermark{position:absolute;bottom:8px;left:8px;font-size:10px;color:rgba(255,255,255,.4);font-weight:700;letter-spacing:2px;text-transform:uppercase;pointer-events:none}
.toolbar{position:sticky;bottom:0;padding:16px 24px;background:rgba(10,10,10,.9);backdrop-filter:blur(8px);border-top:1px solid #222;display:flex;justify-content:space-between;align-items:center}
.sel-count{font-size:14px;color:#888}.sel-count strong{color:#fff}
.msg{padding:12px 20px;border-radius:8px;font-weight:600;font-size:14px}
.success{background:#166534;color:#DCFCE7}.error{background:#7F1D1D;color:#FEE2E2}
</style></head><body>
<div class="header">
<div><div class="h1">${escHtml(gallery.title)}</div><div class="sub">${escHtml(gallery.job_type)} · ${images.length} photos${gallery.watermark_text?" · PROOFS":""}</div></div>
<div id="headerAction"></div>
</div>
<div id="app"></div>
${!needsPassword ? `<div class="toolbar"><div class="sel-count" id="selCount">Click photos to select favourites</div><button class="btn" id="submitBtn" onclick="submitSelections()">Submit Selections</button></div>` : ""}
<div id="msgBox" style="position:fixed;top:20px;right:20px;z-index:999"></div>
<script>
const GALLERY_ID = "${safeGalleryId}";
const NEEDS_PASSWORD = ${needsPassword ? "true" : "false"};
const ALL_IMAGES = ${JSON.stringify(images)};
const WATERMARK = ${JSON.stringify(gallery.watermark_text||"")};
let selected = new Set(${JSON.stringify(selections)});
let unlocked = !NEEDS_PASSWORD;

function showMsg(msg, ok) {
  const d = document.createElement("div");
  d.className = "msg " + (ok ? "success" : "error");
  d.textContent = msg;
  document.getElementById("msgBox").appendChild(d);
  setTimeout(() => d.remove(), 4000);
}

function renderGallery() {
  const app = document.getElementById("app");
  if (!unlocked) {
    app.innerHTML = \`<div class="gate">
      <h2 style="margin-bottom:8px">Password Required</h2>
      <p style="color:#888;font-size:13px;margin-bottom:20px">This gallery is password-protected.</p>
      <div class="gfield"><label>Password</label><input type="password" id="pwInput" placeholder="Enter gallery password" /></div>
      <button class="btn" onclick="checkPassword()">View Gallery</button>
    </div>\`;
    return;
  }
  app.innerHTML = \`<div class="grid">\${ALL_IMAGES.map((img, i) => {
    const url = typeof img === "string" ? img : img.url;
    const sel = selected.has(url) || selected.has(i+"");
    return \`<div class="img-wrap\${sel ? " selected" : ""}" onclick="toggleSelect(this,'\${url}',\${i})">
      <img src="\${url}" loading="lazy" alt="Photo \${i+1}"/>
      \${WATERMARK ? \`<div class="watermark">\${WATERMARK}</div>\` : ""}
      <div class="sel-badge">✓</div>
    </div>\`;
  }).join("")}</div>\`;
  updateCount();
}

function toggleSelect(el, url, idx) {
  const key = url || (idx+"");
  if (selected.has(key)) { selected.delete(key); el.classList.remove("selected"); }
  else { selected.add(key); el.classList.add("selected"); }
  updateCount();
}

function updateCount() {
  const el = document.getElementById("selCount");
  if (el) el.innerHTML = selected.size > 0 ? \`<strong>\${selected.size}</strong> photo\${selected.size!==1?"s":""} selected\` : "Click photos to select favourites";
}

async function checkPassword() {
  const pw = document.getElementById("pwInput")?.value;
  const r = await fetch("/api/industry2/gallery/${safeGalleryId}");
  const d = await r.json();
  if (!d.has_password) { unlocked = true; renderGallery(); return; }
  // Try submitting a blank selection to verify password
  const test = await fetch("/api/industry2/galleries/${safeGalleryId}/select", {
    method: "POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ key: pw, selections: [] })
  });
  if (test.ok) { unlocked = true; renderGallery(); }
  else showMsg("Wrong password", false);
}

async function submitSelections() {
  const r = await fetch("/api/industry2/galleries/${safeGalleryId}/select", {
    method: "POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ key: "", selections: [...selected] })
  });
  if (r.ok) showMsg("Selections submitted! Your photographer has been notified. ✓", true);
  else showMsg("Something went wrong. Please try again.", false);
}

renderGallery();
</script></body></html>`);
  } catch(e) { res.status(500).send("<h1>Error</h1>"); }
});


// GET /api/hosting/utm-stats/:siteId — UTM analytics
// GET /api/hosting/utm-stats-aggregate?userId=X&days=30
// Agency endpoint: returns UTM source breakdown across ALL sites for a given client.
// Requires the calling user to be the agency owner of that client (or the client themselves).
router.get('/utm-stats-aggregate', auth, (req, res) => {
  try {
    const db = getDb(); ensureUtmTable(db);
    const targetUserId = req.query.userId || req.userId;
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);

    // Security: allow if caller is the target user, OR if target is an agency client of caller
    if (targetUserId !== req.userId) {
      try { db.exec('CREATE TABLE IF NOT EXISTS affiliate_relationships (id TEXT PRIMARY KEY, referrer_id TEXT, referred_id TEXT, created_at TEXT DEFAULT (datetime(\'now\')))'); } catch(e) {}
      const isAgencyClient = db.prepare(
        `SELECT 1 FROM affiliate_relationships WHERE referrer_id=? AND referred_id=? LIMIT 1`
      ).get(req.userId, targetUserId);
      if (!isAgencyClient) return res.status(403).json({ error: 'Access denied' });
    }

    // Get all site IDs for the target user
    const siteIds = db.prepare('SELECT id FROM sites WHERE user_id=?').all(targetUserId).map(r => r.id);
    if (!siteIds.length) return res.json({ by_source: [], total: 0, days, site_count: 0 });

    const placeholders = siteIds.map(() => '?').join(',');

    // Aggregate visits by source across all sites
    const bySource = db.prepare(`
      SELECT
        CASE
          WHEN utm_source IS NULL AND referrer LIKE '%google%' THEN 'google'
          WHEN utm_source IS NULL AND referrer LIKE '%facebook%' THEN 'facebook'
          WHEN utm_source IS NULL AND referrer LIKE '%instagram%' THEN 'instagram'
          WHEN utm_source IS NULL AND (referrer IS NULL OR referrer='') THEN 'direct'
          WHEN utm_source IS NULL THEN 'referral'
          ELSE LOWER(utm_source)
        END as source,
        COUNT(*) as visits
      FROM utm_visits
      WHERE site_id IN (${placeholders})
        AND created_at >= datetime('now', '-${days} days')
      GROUP BY source
      ORDER BY visits DESC
      LIMIT 10
    `).all(...siteIds);

    const byMedium = db.prepare(`
      SELECT COALESCE(utm_medium,'organic') as medium, COUNT(*) as visits
      FROM utm_visits
      WHERE site_id IN (${placeholders})
        AND created_at >= datetime('now', '-${days} days')
      GROUP BY medium ORDER BY visits DESC LIMIT 6
    `).all(...siteIds);

    const byCampaign = db.prepare(`
      SELECT utm_campaign, utm_source, COUNT(*) as visits
      FROM utm_visits
      WHERE site_id IN (${placeholders})
        AND utm_campaign IS NOT NULL
        AND created_at >= datetime('now', '-${days} days')
      GROUP BY utm_campaign ORDER BY visits DESC LIMIT 10
    `).all(...siteIds);

    const total = db.prepare(`
      SELECT COUNT(*) as n FROM utm_visits
      WHERE site_id IN (${placeholders})
        AND created_at >= datetime('now', '-${days} days')
    `).get(...siteIds)?.n || 0;

    // Calculate percentages
    const sourcesWithPct = bySource.map(s => ({
      source: s.source,
      visits: s.visits,
      pct: total > 0 ? Math.round((s.visits / total) * 100) : 0
    }));

    res.json({
      by_source: sourcesWithPct,
      by_medium: byMedium,
      by_campaign: byCampaign,
      total,
      days,
      site_count: siteIds.length,
      has_data: total > 0
    });
  } catch (e) {
    console.error('[UTM aggregate]', e.message);
    res.status(500).json({ error: 'An internal error occurred' });
  }
});

// GET /api/hosting/utm-stats/:siteId
router.get('/utm-stats/:siteId', auth, (req, res) => {
  try {
    const db = getDb(); ensureUtmTable(db);
    // Ownership check via auth token — not a query param anyone can spoof
    const site = db.prepare('SELECT id FROM sites WHERE id=? AND user_id=?').get(req.params.siteId, req.userId);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    // Clamp days: prevent absurdly large values causing slow table scans
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);

    const bySource = db.prepare(`SELECT utm_source, COUNT(*) as visits FROM utm_visits
      WHERE site_id=? AND created_at >= date('now','-${days} days') AND utm_source IS NOT NULL
      GROUP BY utm_source ORDER BY visits DESC`).all(req.params.siteId);

    const byCampaign = db.prepare(`SELECT utm_campaign, utm_source, COUNT(*) as visits FROM utm_visits
      WHERE site_id=? AND created_at >= date('now','-${days} days') AND utm_campaign IS NOT NULL
      GROUP BY utm_campaign ORDER BY visits DESC LIMIT 20`).all(req.params.siteId);

    const total = db.prepare(`SELECT COUNT(*) as n FROM utm_visits WHERE site_id=? AND created_at >= date('now','-${days} days')`).get(req.params.siteId)?.n || 0;

    res.json({ by_source: bySource, by_campaign: byCampaign, total_utm_visits: total, days });
  } catch(e) { console.error('[UTM stats]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// GET /hosting/ai/video/status/:taskId — poll Runway or Arcads for completion
// GET /hosting/ai/video/log — user's Runway video history and spend
router.get("/ai/video/log", auth, (req, res) => {
  try {
    const db = getDb();
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
    const log = db.prepare(`
      SELECT id, task_id, prompt, duration_requested, duration_actual,
             status, amount_charged, provider, created_at, completed_at, video_url
      FROM runway_video_log WHERE user_id = ?
      ORDER BY created_at DESC LIMIT 50
    `).all(req.userId);
    const thisMonth = log.filter(v => v.created_at >= monthStart.toISOString());
    const totalSpend = thisMonth.reduce((s, v) => s + ((v.amount_charged || 0) / 100), 0);
    const totalVideos = thisMonth.filter(v => v.status !== 'failed').length;
    res.json({
      log,
      stats: {
        this_month_videos: totalVideos,
        this_month_spend: totalSpend,
        this_month_runway: thisMonth.filter(v => v.provider === 'runway' && v.status !== 'failed').length,
        lifetime_videos: log.filter(v => v.status !== 'failed').length
      }
    });
  } catch(e) { console.error('[video log]', e.message); res.status(500).json({ error: 'Internal error' }); }
});

router.get("/ai/video/status/:taskId", auth, async (req, res) => {
  try {
    const { provider } = req.query;
    const fetch = (await import("node-fetch")).default;

    if (provider === "runway") {
      const runwayKey = getSetting("RUNWAY_API_KEY") || process.env.RUNWAY_API_KEY;
      if (!runwayKey) return res.status(400).json({ error: "Runway not configured" });
      const r = await fetch(`https://api.dev.runwayml.com/v1/tasks/${req.params.taskId}`, {
        headers: { Authorization: `Bearer ${runwayKey}`, "X-Runway-Version": "2024-11-06" }
      });
      const d = await r.json();
      const db = getDb();
      if (d.status === "SUCCEEDED") {
        const videoUrl = d.output?.[0];
        // Update log record with completed URL
        db.prepare("UPDATE runway_video_log SET status='completed', video_url=?, completed_at=datetime('now') WHERE task_id=? AND user_id=?")
          .run(videoUrl, req.params.taskId, req.userId);
        return res.json({ done: true, url: videoUrl, provider: "runway", status: "completed" });
      }
      if (d.status === "FAILED") {
        db.prepare("UPDATE runway_video_log SET status='failed', completed_at=datetime('now') WHERE task_id=? AND user_id=?")
          .run(req.params.taskId, req.userId);
        return res.json({ done: true, error: d.failure || "Video generation failed", provider: "runway" });
      }
      return res.json({ done: false, status: d.status || "processing", progress: d.progress || 0, provider: "runway" });
    }

    if (provider === "arcads") {
      return res.status(410).json({
        done: true,
        error: "Arcads has been discontinued. UGC videos now use HeyGen.",
        provider: "arcads",
        status: "deprecated"
      });
    }

    res.status(400).json({ error: "Unknown provider" });
  } catch(e) { console.error("[video status]", e.message); res.status(500).json({ error: "Status check failed" }); }
});


// POST /api/hosting/connect-domain
// Frontend calls this with { siteId, domain } — wrapper around /domain/:siteId
router.post("/connect-domain", auth, async (req, res) => {
  const { siteId, domain } = req.body;
  if (!siteId || !domain) return res.status(400).json({ error: "siteId and domain required" });

  // Reuse the existing /domain/:siteId logic by forwarding internally
  const db = getDb();
  const site = db.prepare("SELECT * FROM sites WHERE id = ? AND user_id = ?").get(siteId, req.userId);
  if (!site) return res.status(404).json({ error: "Site not found" });

  const DOMAIN_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
  const clean = domain.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (!DOMAIN_RE.test(clean)) return res.status(400).json({ error: "Invalid domain format" });

  // Uniqueness — prevent squatting another user's domain
  try {
    const other = db.prepare(
      "SELECT user_id FROM sites WHERE LOWER(custom_domain) = ? AND user_id != ?"
    ).get(clean, req.userId);
    if (other) return res.status(409).json({ error: "This domain is already registered on another TAKEOVA account." });
    const otherSD = db.prepare(
      "SELECT user_id FROM site_domains WHERE domain = ? AND user_id != ?"
    ).get(clean, req.userId);
    if (otherSD) return res.status(409).json({ error: "This domain is already registered on another TAKEOVA account." });
  } catch(e) { console.error("[/connect-domain]", e.message || e); }

  try {
    db.prepare("UPDATE sites SET custom_domain = ?, updated_at = datetime('now') WHERE id = ?").run(clean, siteId);
  } catch(e) {
    try { db.exec("ALTER TABLE sites ADD COLUMN custom_domain TEXT"); db.prepare("UPDATE sites SET custom_domain = ? WHERE id = ?").run(clean, siteId); } catch(_) {}
  }

  // Try Cloudflare Pages domain connection if configured
  const cfToken = process.env.CLOUDFLARE_API_TOKEN;
  const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (cfToken && cfAccountId) {
    try {
      const fetch = (await import("node-fetch")).default;
      await fetch(
        "https://api.cloudflare.com/client/v4/accounts/" + cfAccountId + "/pages/projects/mine-" + siteId.slice(0,8) + "/domains",
        { method: "POST", headers: { "Authorization": "Bearer " + cfToken, "Content-Type": "application/json" }, body: JSON.stringify({ name: clean }) }
      );
    } catch(e) { console.error("[/connect-domain]", e.message || e); }
  }

  res.json({
    success:  true,
    verified: false, // DNS propagation needed
    domain:   clean,
    message: "Add a CNAME record pointing " + clean + " to takeova.ai, then it will go live within 24h."
  });
});

// Export router (default) plus a helper for server.js to serve sites on
// custom domains without going through the full /deploy round-trip.
// The public-serve helper wraps site.html the same way deploy does,
// using a minimal seed of siteData so the wrapper template works.
function generateSiteHTMLForPublicServe(site) {
  let seo = {};
  let colors = {};
  try { seo = JSON.parse(site.seo_json || "{}"); } catch(e) {}
  try { colors = JSON.parse(site.colors_json || "{}"); } catch(e) {}
  const siteData = {
    html: site.html || "",
    colors,
    seoTitle: seo.title || site.name,
    seoDescription: seo.description || "",
  };
  return generateSiteHTML(site, siteData);
}

module.exports = router;
module.exports.generateSiteHTMLForPublicServe = generateSiteHTMLForPublicServe;

// ── PUBLIC: Class enrollment page ─────────────────────────────────────────────
router.get("/class-enroll/:classId", async (req, res) => {
  try {
    const db = getDb();
    const cls = db.prepare(`SELECT cs.*, sp.name as staff_name, s.name as biz_name, s.user_id
      FROM class_schedules cs
      LEFT JOIN staff_profiles sp ON sp.id=cs.staff_id
      LEFT JOIN sites s ON s.user_id=cs.user_id
      WHERE cs.id=?`).get(req.params.classId);
    if (!cls) return res.status(404).send("<h1>Class not found</h1>");
    const enrolled = db.prepare("SELECT COUNT(*) as c FROM class_enrollments WHERE class_id=? AND waitlisted=0").get(cls.id)?.c || 0;
    const full = enrolled >= cls.capacity;
    const bizName = cls.biz_name || "Studio";
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(cls.name)} — ${escHtml(bizName)}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:#f8f9fa;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:16px;padding:32px;max-width:480px;width:100%;box-shadow:0 4px 20px rgba(0,0,0,.08)}
h1{font-size:22px;font-weight:800;margin-bottom:6px}
.meta{color:#64748B;font-size:14px;margin-bottom:20px}
.spots{display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;margin-bottom:20px}
.available{background:#DCFCE7;color:#166534}.full{background:#FEE2E2;color:#991B1B}
.field{margin-bottom:14px}label{display:block;font-size:12px;font-weight:600;color:#475569;margin-bottom:4px}
input{width:100%;padding:10px 14px;border:1px solid #E2E8F0;border-radius:8px;font-size:14px;font-family:inherit}
.btn{width:100%;padding:14px;background:#2563EB;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;margin-top:4px}
.msg{padding:14px;border-radius:10px;text-align:center;margin-top:16px;font-weight:600}
.success{background:#DCFCE7;color:#166534}.error{background:#FEE2E2;color:#991B1B}
</style></head><body>
<div class="card">
<h1>${escHtml(cls.name)}</h1>
<div class="meta">📅 ${escHtml(cls.date)} at ${escHtml(cls.start_time)}${cls.duration_minutes ? " · " + parseInt(cls.duration_minutes) + " min" : ""}${cls.staff_name ? " · " + escHtml(cls.staff_name) : ""}${cls.location ? " · " + escHtml(cls.location) : ""}${cls.price > 0 ? " · $" + parseFloat(cls.price).toFixed(2) : " · Free"}</div>
<span class="spots ${full ? "full" : "available"}">${full ? "Class Full — Join Waitlist" : `${cls.capacity - enrolled} spot${cls.capacity - enrolled !== 1 ? "s" : ""} remaining`}</span>
<form id="ef">
<div class="field"><label>Full Name</label><input name="name" required placeholder="Your name"/></div>
<div class="field"><label>Email</label><input name="email" type="email" required placeholder="your@email.com"/></div>
<div class="field"><label>Phone (optional)</label><input name="phone" type="tel" placeholder="+1 555 000 0000"/></div>
<button class="btn" type="submit">${full ? "Join Waitlist" : "Enroll Now"}</button>
</form>
<div id="msg"></div>
</div>
<script>
document.getElementById("ef").addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector("button");
  btn.disabled = true; btn.textContent = "Enrolling...";
  try {
    const r = await fetch("/api/verticals/classes/${req.params.classId}/enroll", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ customer_name: f.name.value, customer_email: f.email.value, customer_phone: f.phone.value })
    });
    const d = await r.json();
    if (r.ok) {
      document.getElementById("msg").innerHTML = '<div class="msg success">' + (d.waitlisted ? "Added to waitlist — you'll be notified if a spot opens." : "You're enrolled! Check your email for confirmation.") + "</div>";
      f.style.display = "none";
    } else {
      document.getElementById("msg").innerHTML = '<div class="msg error">' + (d.error || "Something went wrong") + "</div>";
      btn.disabled = false; btn.textContent = "${full ? "Join Waitlist" : "Enroll Now"}";
    }
  } catch(e) {
    document.getElementById("msg").innerHTML = '<div class="msg error">Network error — please try again</div>';
    btn.disabled = false;
  }
});
</script>
</body></html>`);
  } catch(e) { res.status(500).send("<h1>Error</h1>"); }
});

// ── PUBLIC: Property enquiry form ─────────────────────────────────────────────
router.post("/property-enquiry/:propertyId", propertyEnquiryLimiter, async (req, res) => {
  try {
    const db = getDb();
    const prop = db.prepare("SELECT * FROM property_listings WHERE id=?").get(req.params.propertyId);
    if (!prop) return res.status(404).json({ error: "Property not found" });
    const { name, email, phone, message } = req.body;
    if (!email || !name) return res.status(400).json({ error: "Name and email required" });

    // Save as contact
    const { v4: uid } = require("uuid");
    const existingContact = db.prepare("SELECT id FROM contacts WHERE user_id=? AND email=?").get(prop.user_id, email);
    if (!existingContact) {
      try {
        db.prepare("INSERT INTO contacts (id,user_id,name,email,phone,status,source,notes) VALUES (?,?,?,?,?,?,?,?)")
          .run(uid(), prop.user_id, name, email, phone||"", "lead", "property_enquiry", `Enquiry re: ${prop.title}. ${message||""}`);
      } catch(e) {}
    }

    // Email agent
    if (prop.agent_email) {
      const sgKey = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
      if (sgKey) {
        const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
        const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { "Authorization": `Bearer ${sgKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: prop.agent_email }] }],
            from: { email: getSetting("EMAIL_FROM") || "noreply@takeova.ai", name: "MINE" },
            subject: `New enquiry: ${prop.title}`,
            content: [{ type: "text/html", value: `<p><strong>Name:</strong> ${name}<br><strong>Email:</strong> ${email}<br><strong>Phone:</strong> ${phone||"—"}<br><strong>Message:</strong> ${message||"—"}</p><p>Property: ${prop.title} — ${prop.price_display||"POA"}</p>` }]
          })
        })
        if (!_sgResp.ok) {
          let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
          console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
        }
      }
    }

    res.json({ success: true, message: "Enquiry sent — the agent will be in touch shortly." });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ── PUBLIC: Room availability + booking page ──────────────────────────────────
router.get("/book-room/:siteId", async (req, res) => {
  try {
    const db = getDb();
    const site = db.prepare("SELECT id, user_id, name FROM sites WHERE id=?").get(req.params.siteId);
    if (!site) return res.status(404).send("<h1>Not found</h1>");
    let rooms = [];
    try { rooms = db.prepare("SELECT * FROM rooms WHERE user_id=? AND active=1 ORDER BY price_per_night").all(site.user_id); } catch(e) {}
    const bizName = site.name || "Accommodation";
    const { check_in, check_out } = req.query;
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Book a Room — ${escHtml(bizName)}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:#f8f9fa;padding:20px}
.wrap{max-width:720px;margin:0 auto}h1{font-size:24px;font-weight:800;margin-bottom:6px}
.sub{color:#64748B;margin-bottom:24px;font-size:14px}
.search{background:#fff;border-radius:14px;padding:20px;margin-bottom:24px;display:flex;gap:10px;align-items:flex-end;box-shadow:0 2px 8px rgba(0,0,0,.06)}
.field{flex:1}label{display:block;font-size:12px;font-weight:600;color:#64748B;margin-bottom:4px}
input,select{width:100%;padding:10px 14px;border:1px solid #E2E8F0;border-radius:8px;font-size:14px;font-family:inherit}
.btn{padding:10px 20px;background:#2563EB;color:#fff;border:none;border-radius:8px;font-weight:700;cursor:pointer;white-space:nowrap;font-family:inherit;font-size:14px}
.rooms{display:grid;gap:16px}
.room{background:#fff;border-radius:14px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,.06);border:2px solid transparent}
.room:hover{border-color:#2563EB}
.rname{font-size:18px;font-weight:800;margin-bottom:4px}
.rmeta{color:#64748B;font-size:13px;margin-bottom:12px}
.ramenities{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px}
.badge{padding:4px 10px;background:#f1f5f9;border-radius:20px;font-size:11px;color:#475569}
.rprice{font-size:22px;font-weight:800;color:#2563EB}
.ractions{display:flex;align-items:center;justify-content:space-between;margin-top:12px}
.avail{padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700}
.av-yes{background:#DCFCE7;color:#166534}.av-no{background:#FEE2E2;color:#991B1B}.av-check{background:#EFF6FF;color:#1D4ED8}
.modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100;align-items:center;justify-content:center;padding:16px}
.modal.open{display:flex}
.mcard{background:#fff;border-radius:16px;padding:24px;max-width:480px;width:100%;max-height:90vh;overflow:auto}
.mh2{font-size:18px;font-weight:800;margin-bottom:16px}
.mfield{margin-bottom:12px}
.mfield label{display:block;font-size:12px;font-weight:600;color:#64748B;margin-bottom:4px}
.mfield input{width:100%;padding:9px 12px;border:1px solid #E2E8F0;border-radius:8px;font-size:14px;font-family:inherit}
.msg{padding:12px;border-radius:8px;margin-top:12px;font-weight:600;text-align:center}
.success{background:#DCFCE7;color:#166534}.error{background:#FEE2E2;color:#991B1B}
</style></head><body>
<div class="wrap">
<h1>${escHtml(bizName)}</h1>
<div class="sub">Check availability and book direct — best rates guaranteed</div>
<div class="search">
<div class="field"><label>Check-in</label><input type="date" id="ci" value="${escHtml(check_in||'')}" min="${new Date().toISOString().split('T')[0]}"/></div>
<div class="field"><label>Check-out</label><input type="date" id="co" value="${escHtml(check_out||'')}" min="${new Date().toISOString().split('T')[0]}"/></div>
<div class="field"><label>Guests</label><select id="gu"><option>1</option><option>2</option><option>3</option><option>4</option><option>5+</option></select></div>
<button class="btn" onclick="checkAll()">Search</button>
</div>
<div class="rooms" id="roomsList">
${rooms.map(r => {
  const ams = JSON.parse(r.amenities||'[]');
  return `<div class="room" id="r${r.id}">
  <div class="rname">🏨 ${r.name}</div>
  <div class="rmeta">${r.type} · ${r.beds} · Up to ${r.max_guests} guests${r.description ? ' · ' + r.description : ''}</div>
  ${ams.length ? `<div class="ramenities">${ams.map(a => `<span class="badge">${a}</span>`).join('')}</div>` : ''}
  <div class="ractions">
    <div><div class="rprice">$${r.price_per_night}<span style="font-size:14px;color:#64748B">/night</span></div></div>
    <div style="display:flex;gap:8px;align-items:center">
      <span class="avail av-check" id="av${r.id}">Select dates</span>
      <button class="btn" onclick="openBook('${r.id}','${r.name}',$${r.price_per_night})" style="padding:8px 16px">Book Now</button>
    </div>
  </div>
</div>`;
}).join('')}
</div>
</div>
<div class="modal" id="bookModal">
<div class="mcard">
<div class="mh2" id="mTitle">Book Room</div>
<div class="mfield"><label>Full Name</label><input id="gName" placeholder="Your full name"/></div>
<div class="mfield"><label>Email</label><input type="email" id="gEmail" placeholder="your@email.com"/></div>
<div class="mfield"><label>Phone (optional)</label><input type="tel" id="gPhone"/></div>
<div class="mfield"><label>Special Requests</label><input id="gReq" placeholder="Early check-in, dietary needs, etc."/></div>
<div id="priceSummary" style="background:#f8fafc;padding:12px;border-radius:8px;font-size:13px;margin:12px 0"></div>
<div style="display:flex;gap:8px">
<button class="btn" onclick="submitBook()" style="flex:1">Confirm Booking</button>
<button onclick="closeModal()" style="padding:10px 16px;border:1px solid #E2E8F0;border-radius:8px;cursor:pointer;background:#fff;font-family:inherit">Cancel</button>
</div>
<div id="mMsg"></div>
</div>
</div>
<script>
let activeRoom = null, activePrice = 0;
function getCI(){return document.getElementById('ci').value;}
function getCO(){return document.getElementById('co').value;}
function nights(){const ci=new Date(getCI()),co=new Date(getCO());return ci&&co?Math.ceil((co-ci)/86400000):0;}
async function checkAll(){
  const ci=getCI(),co=getCO();
  if(!ci||!co){alert('Please select check-in and check-out dates');return;}
  const r=await fetch('/api/industry/rooms/availability/range?check_in='+ci+'&check_out='+co+'&site_id=${site.id}');
  // Update each room card with availability
}
function openBook(id,name,price){
  if(!getCI()||!getCO()){alert('Please select dates first');return;}
  const n=nights();if(n<=0){alert('Check-out must be after check-in');return;}
  activeRoom=id;activePrice=price;
  document.getElementById('mTitle').textContent='Book '+name;
  document.getElementById('priceSummary').innerHTML=
    '<strong>'+getCI()+'</strong> → <strong>'+getCO()+'</strong><br>'+
    n+' night'+(n!==1?'s':'')+' × $'+price+'/night = <strong>$'+(n*price)+'</strong>';
  document.getElementById('bookModal').classList.add('open');
}
function closeModal(){document.getElementById('bookModal').classList.remove('open');}
async function submitBook(){
  const btn=document.querySelector('#bookModal .btn');
  btn.disabled=true;btn.textContent='Booking...';
  const r=await fetch('/api/industry/room-bookings',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      room_id:activeRoom,
      guest_name:document.getElementById('gName').value,
      guest_email:document.getElementById('gEmail').value,
      guest_phone:document.getElementById('gPhone').value,
      check_in:getCI(),check_out:getCO(),
      guests:parseInt(document.getElementById('gu').value)||1,
      special_requests:document.getElementById('gReq').value,
      channel:'direct'
    })
  });
  const d=await r.json();
  if(r.ok){
    document.querySelector('#bookModal .mcard form, #bookModal .mcard > div:not(#mMsg)');
    document.getElementById('mMsg').innerHTML='<div class="msg success">Booking confirmed! ✅ Check your email for details.</div>';
    btn.style.display='none';
  } else {
    document.getElementById('mMsg').innerHTML='<div class="msg error">'+(d.error||'Something went wrong')+'</div>';
    btn.disabled=false;btn.textContent='Confirm Booking';
  }
}
</script>
</body></html>`);
  } catch(e) { res.status(500).send("<h1>Error</h1>"); }
});

// ── PUBLIC: Photography Portfolio Page ───────────────────────────────────────
router.get("/portfolio/:siteId", async (req, res) => {
  try {
    const db = getDb();
    const site = db.prepare("SELECT id, user_id, name, tagline, bio FROM sites WHERE id=?").get(req.params.siteId);
    if (!site) return res.status(404).send("<h1>Not found</h1>");
    let galleries = [];
    try {
      galleries = db.prepare("SELECT * FROM client_proof_galleries WHERE user_id=? AND status IN ('delivered','approved') ORDER BY created_at DESC LIMIT 20").all(site.user_id);
    } catch(e) {}
    let services = [];
    try {
      services = db.prepare("SELECT * FROM services WHERE user_id=? AND active=1 ORDER BY sort_order,name LIMIT 20").all(site.user_id);
    } catch(e) {}
    const bizName = site.name || "Photography Studio";
    const tagline = site.tagline || "Capturing moments that last a lifetime";
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(bizName)}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:#0A0A0A;color:#fff}
.hero{min-height:60vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:60px 20px;background:linear-gradient(135deg,#0A0A0A 0%,#1a1a2e 100%)}
h1{font-size:clamp(36px,6vw,72px);font-weight:900;letter-spacing:-2px;margin-bottom:12px}
.sub{font-size:18px;color:rgba(255,255,255,.6);max-width:500px;line-height:1.6;margin-bottom:32px}
.wrap{max-width:1100px;margin:0 auto;padding:0 20px}
.section{padding:60px 0}
.sh{font-size:28px;font-weight:800;margin-bottom:8px}
.sm{color:rgba(255,255,255,.5);font-size:14px;margin-bottom:32px}
.gallery{columns:3;gap:12px}@media(max-width:600px){.gallery{columns:2}}
.gitem{break-inside:avoid;margin-bottom:12px;border-radius:8px;overflow:hidden;position:relative}
.gitem img{width:100%;display:block;transition:transform .3s}
.gitem:hover img{transform:scale(1.03)}
.glabel{position:absolute;bottom:0;left:0;right:0;padding:12px;background:linear-gradient(transparent,rgba(0,0,0,.8));font-size:12px;font-weight:600;opacity:0;transition:opacity .3s}
.gitem:hover .glabel{opacity:1}
.pkgs{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
.pkg{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:24px;transition:border-color .2s}
.pkg:hover{border-color:rgba(255,255,255,.3)}
.pname{font-size:18px;font-weight:800;margin-bottom:6px}
.pprice{font-size:28px;font-weight:900;margin:12px 0;color:#fff}
.pdesc{color:rgba(255,255,255,.6);font-size:13px;line-height:1.6}
.ctabtn{display:inline-block;padding:16px 36px;background:#fff;color:#0A0A0A;border-radius:50px;font-weight:800;font-size:16px;text-decoration:none;margin-top:8px;transition:opacity .2s}
.ctabtn:hover{opacity:.85}
footer{padding:40px 20px;text-align:center;color:rgba(255,255,255,.3);font-size:12px;border-top:1px solid rgba(255,255,255,.08)}
</style></head><body>
<div class="hero">
<div class="wrap">
<h1>${escHtml(bizName)}</h1>
<p class="sub">${escHtml(tagline)}</p>
<a href="#packages" class="ctabtn">View Packages →</a>
</div>
</div>
${galleries.length ? `
<div class="wrap"><div class="section">
<h2 class="sh">Portfolio</h2>
<p class="sm">Recent work</p>
<div class="gallery">
${galleries.flatMap(g => {
  const imgs = JSON.parse(g.images||'[]');
  return imgs.slice(0,3).map(img => `<div class="gitem"><img src="${img.url||img}" alt="${g.title}" loading="lazy"/><div class="glabel">${g.title} · ${g.job_type||''}</div></div>`);
}).join('')}
</div>
</div></div>` : `
<div class="wrap"><div class="section">
<h2 class="sh">Portfolio</h2>
<p class="sm">Check back soon for recent work</p>
</div></div>`}
<div class="wrap"><div class="section" id="packages">
<h2 class="sh">Packages</h2>
<p class="sm">Choose what suits you best</p>
${services.length ? `<div class="pkgs">
${services.map(s=>`<div class="pkg">
<div class="pname">${s.name}</div>
<div class="pprice">$${s.price||"POA"}</div>
<div class="pdesc">${s.description||s.name} · ${s.duration_minutes||60} min session</div>
</div>`).join('')}
</div>` : '<p style="color:rgba(255,255,255,.4)">Contact for custom quotes</p>'}
</div></div>
<div style="background:rgba(255,255,255,.03);padding:60px 20px;text-align:center">
<div style="max-width:500px;margin:0 auto">
<h2 style="font-size:32px;font-weight:900;margin-bottom:12px">Ready to book?</h2>
<p style="color:rgba(255,255,255,.6);margin-bottom:28px">Let's create something beautiful together.</p>
<a href="/book/${site.id}" class="ctabtn">Book a Session</a>
</div>
</div>
<footer>${bizName} · Powered by MINE</footer>
</body></html>`);
  } catch(e) { res.status(500).send("<h1>Error</h1>"); }
});
