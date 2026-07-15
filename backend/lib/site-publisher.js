/**
 * lib/site-publisher.js
 * Regenerates a site's hosted HTML file from current DB state.
 * Used by the SEO Agent after applying changes so the live site reflects them.
 *
 *   const { republishSite } = require("./site-publisher");
 *   const result = await republishSite(db, site);
 *   // → { success, method, error?, cfNeedsRedeploy? }
 *
 * Handles: local disk write (always), S3 upload (if configured).
 * Does NOT trigger Cloudflare Pages redeploy — user must manually publish for that.
 */

const fs = require("fs");
const path = require("path");

async function republishSite(db, site) {
  const result = { success: false, method: null, error: null, cfNeedsRedeploy: false };
  if (!site || !site.id) {
    result.error = "Invalid site";
    return result;
  }

  // Lazy-require hosting so we don't create a circular dependency at module load.
  let generateSiteHTMLForPublicServe;
  try {
    const hosting = require("../routes/hosting");
    generateSiteHTMLForPublicServe = hosting.generateSiteHTMLForPublicServe;
  } catch (e) {
    result.error = "hosting renderer unavailable: " + e.message;
    return result;
  }
  if (typeof generateSiteHTMLForPublicServe !== "function") {
    result.error = "generateSiteHTMLForPublicServe not exported";
    return result;
  }

  // Re-render HTML from current DB state
  let html;
  try {
    html = generateSiteHTMLForPublicServe(site);
  } catch (e) {
    result.error = "render failed: " + e.message;
    return result;
  }

  // Strip MINE badge for Pro/Enterprise plans with show_mine_badge=0
  try {
    const owner = db.prepare("SELECT plan FROM users WHERE id=?").get(site.user_id);
    if (site.show_mine_badge === 0 && owner && ["pro", "enterprise"].indexOf(owner.plan) !== -1) {
      html = html.replace(/\n?\s*<!-- Built with MINE badge[\s\S]*?<\/script>\s*/m, "");
    }
  } catch (_) { /* non-fatal */ }

  // Write to local disk (always — even if S3-enabled, local serves as fallback)
  const hostDir = path.join(process.env.UPLOAD_DIR || "./uploads", "hosted", site.id);
  try {
    fs.mkdirSync(hostDir, { recursive: true });
    fs.writeFileSync(path.join(hostDir, "index.html"), html);
    result.method = "local";
    result.success = true;
  } catch (e) {
    result.error = "disk write failed: " + e.message;
    return result;
  }

  // S3 upload if configured
  try {
    const s3mod = require("../utils/s3");
    if (s3mod && typeof s3mod.isS3Enabled === "function" && s3mod.isS3Enabled()) {
      const s3Url = await s3mod.uploadToS3(Buffer.from(html, "utf8"), `sites/${site.id}/index.html`, "text/html");
      db.prepare("UPDATE sites SET s3_url = ? WHERE id = ?").run(s3Url, site.id);
      result.method = "local+s3";
    }
  } catch (_) {
    // S3 failure isn't fatal — local copy is still good
  }

  // Note: Cloudflare Pages redeploy not triggered automatically.
  // If the site is deployed to Cloudflare, the user must manually re-publish for CDN refresh.
  // Flag this so the agent can include it in the digest.
  try {
    const cf = db.prepare("SELECT cloudflare_project FROM sites WHERE id=?").get(site.id);
    if (cf && cf.cloudflare_project) result.cfNeedsRedeploy = true;
  } catch (_) {}

  return result;
}

module.exports = { republishSite };
