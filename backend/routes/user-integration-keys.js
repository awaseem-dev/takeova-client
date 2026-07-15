/**
 * MINE per-user integration keys
 *
 * Stores per-user API keys for third-party integrations (Mailchimp, Shopify, ...)
 * so customers don't have to re-paste their keys every time they import.
 *
 * Keys are encrypted at rest using the same AES-256-GCM pattern as
 * credential_vault. The encryption key is derived from CREDENTIAL_VAULT_KEY
 * mixed with the user's ID — meaning a leaked DB without the env var
 * does NOT yield decrypted keys.
 *
 *   GET    /api/integrations/keys/:service    — returns connection status (masked)
 *   POST   /api/integrations/keys/:service    — save key (tests it first)
 *   DELETE /api/integrations/keys/:service    — disconnect
 */
"use strict";

const express = require("express");
const router  = express.Router();
const crypto  = require("crypto");
const { auth }    = require("../middleware/auth");
const { getDb } = require("../db/init");

// Allowlist of services we support — refuse arbitrary ones
const SUPPORTED = ["mailchimp", "shopify", "easypost"];

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_integration_keys (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      service       TEXT NOT NULL,
      ciphertext    TEXT NOT NULL,
      iv            TEXT NOT NULL,
      auth_tag      TEXT NOT NULL,
      meta          TEXT,            -- JSON: e.g. { shopDomain: "..." } or { lastFour: "...", dc: "..." }
      created_at    TEXT DEFAULT (datetime('now')),
      last_used_at  TEXT,
      UNIQUE(user_id, service)
    )
  `);
}

function getEncryptionKey(userId) {
  const vaultKey = process.env.CREDENTIAL_VAULT_KEY || "";
  // Require a 64-character hex string (32 bytes of entropy) for safe AES-256
  if (!vaultKey || vaultKey.length < 64 || !/^[0-9a-fA-F]{64,}$/.test(vaultKey)) {
    throw new Error("CREDENTIAL_VAULT_KEY missing or invalid — must be a 64-character hex string (generate with: openssl rand -hex 32)");
  }
  // Derive a per-user key by HMACing the user id with the vault key
  return crypto.createHmac("sha256", Buffer.from(vaultKey.slice(0, 64), "hex"))
               .update(String(userId)).digest();
}

function encrypt(plaintext, userId) {
  const key = getEncryptionKey(userId);
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return { ciphertext: enc.toString("base64"), iv: iv.toString("base64"), authTag: tag.toString("base64") };
}

function decrypt(ct, ivB, tagB, userId) {
  const key = getEncryptionKey(userId);
  const iv  = Buffer.from(ivB, "base64");
  const tag = Buffer.from(tagB, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

function uuid() { return crypto.randomBytes(16).toString("hex"); }

// Verify a key actually works against the third-party API before saving
async function verifyKey(service, key, meta) {
  const fetch = (await import("node-fetch")).default;
  if (service === "mailchimp") {
    const dash = key.lastIndexOf("-");
    if (dash < 0 || dash === key.length - 1) return { ok: false, error: "Mailchimp key must end with -us17 or similar datacenter code" };
    const dc = key.slice(dash + 1);
    const r = await fetch(`https://${dc}.api.mailchimp.com/3.0/ping`, {
      headers: { Authorization: "Basic " + Buffer.from("anystring:" + key).toString("base64") },
    });
    if (r.status === 401) return { ok: false, error: "Mailchimp rejected the key" };
    if (!r.ok) return { ok: false, error: `Mailchimp returned ${r.status}` };
    return { ok: true, meta: { dc, lastFour: key.slice(-4) } };
  }
  if (service === "shopify") {
    const domain = (meta?.shopDomain || "").replace(/https?:\/\//, "").replace(/\/+$/, "").split("/")[0];
    if (!/^[a-zA-Z0-9][a-zA-Z0-9\-\.]{0,61}[a-zA-Z0-9]?\.[a-zA-Z]{2,}$/.test(domain)) {
      return { ok: false, error: "Invalid Shopify domain" };
    }
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|::1)/i.test(domain)) {
      return { ok: false, error: "Invalid Shopify domain" };
    }
    const r = await fetch(`https://${domain}/admin/api/2024-01/shop.json`, {
      headers: { "X-Shopify-Access-Token": key },
    });
    if (r.status === 401) return { ok: false, error: "Shopify rejected the token" };
    if (r.status === 404) return { ok: false, error: "Store not found at that domain" };
    if (!r.ok) return { ok: false, error: `Shopify returned ${r.status}` };
    return { ok: true, meta: { shopDomain: domain, lastFour: key.slice(-4) } };
  }
  if (service === "easypost") {
    // EasyPost test endpoint — fetch user profile (cheap, doesn't book anything)
    const r = await fetch("https://api.easypost.com/v2/users", {
      headers: { Authorization: "Basic " + Buffer.from(key + ":").toString("base64") },
    });
    if (r.status === 401) return { ok: false, error: "EasyPost rejected the API key" };
    if (!r.ok) return { ok: false, error: `EasyPost returned ${r.status}` };
    // Detect test vs production key from prefix
    const isTest = key.startsWith("EZTK") || key.startsWith("EZAK_test");
    return { ok: true, meta: { lastFour: key.slice(-4), mode: isTest ? "test" : "production" } };
  }
  return { ok: false, error: "Unsupported service" };
}

// ─── GET /api/integrations/keys/:service — connection status ──────────────
router.get("/:service", auth, (req, res) => {
  const service = String(req.params.service || "").toLowerCase();
  if (!SUPPORTED.includes(service)) return res.status(400).json({ error: "Unsupported service" });

  const db = getDb();
  ensureTable(db);
  // Make sure sync columns exist on the table
  try { db.exec("ALTER TABLE user_integration_keys ADD COLUMN auto_sync_enabled INTEGER DEFAULT 1"); } catch(_) {}
  try { db.exec("ALTER TABLE user_integration_keys ADD COLUMN last_sync_at TEXT"); } catch(_) {}
  try { db.exec("ALTER TABLE user_integration_keys ADD COLUMN last_sync_status TEXT"); } catch(_) {}
  try { db.exec("ALTER TABLE user_integration_keys ADD COLUMN last_sync_count INTEGER"); } catch(_) {}

  const row = db.prepare(`SELECT meta, created_at, last_used_at,
                                  auto_sync_enabled, last_sync_at, last_sync_status, last_sync_count
                           FROM user_integration_keys WHERE user_id = ? AND service = ?`)
                .get(req.userId, service);
  if (!row) return res.json({ connected: false });
  let meta = {};
  try { meta = JSON.parse(row.meta || "{}"); } catch(_) {}
  res.json({
    connected: true,
    lastFour: meta.lastFour || "",
    shopDomain: meta.shopDomain || null,
    dc: meta.dc || null,
    listId: meta.listId || null,
    connectedAt: row.created_at,
    lastUsedAt: row.last_used_at,
    autoSyncEnabled: row.auto_sync_enabled === null ? true : !!row.auto_sync_enabled,
    lastSyncAt: row.last_sync_at,
    lastSyncStatus: row.last_sync_status,
    lastSyncCount: row.last_sync_count,
  });
});

// ─── POST /api/integrations/keys/:service — save (after testing) ──────────
router.post("/:service", auth, async (req, res) => {
  const service = String(req.params.service || "").toLowerCase();
  if (!SUPPORTED.includes(service)) return res.status(400).json({ error: "Unsupported service" });

  const { apiKey, shopDomain } = req.body;
  if (!apiKey || typeof apiKey !== "string") return res.status(400).json({ error: "apiKey required" });
  if (service === "shopify" && !shopDomain) return res.status(400).json({ error: "shopDomain required for Shopify" });

  // Verify the key works against the real API before saving
  const verify = await verifyKey(service, apiKey.trim(), { shopDomain });
  if (!verify.ok) return res.status(400).json({ error: verify.error });

  const db = getDb();
  ensureTable(db);
  let enc;
  try { enc = encrypt(apiKey.trim(), req.userId); }
  catch(e) { return res.status(503).json({ error: e.message }); }

  const existing = db.prepare("SELECT id FROM user_integration_keys WHERE user_id = ? AND service = ?")
                     .get(req.userId, service);
  const metaJson = JSON.stringify(verify.meta);
  if (existing) {
    db.prepare(`UPDATE user_integration_keys SET ciphertext=?, iv=?, auth_tag=?, meta=?, created_at=datetime('now') WHERE id=?`)
      .run(enc.ciphertext, enc.iv, enc.authTag, metaJson, existing.id);
  } else {
    db.prepare(`INSERT INTO user_integration_keys (id, user_id, service, ciphertext, iv, auth_tag, meta) VALUES (?,?,?,?,?,?,?)`)
      .run(uuid(), req.userId, service, enc.ciphertext, enc.iv, enc.authTag, metaJson);
  }

  res.json({
    ok: true,
    connected: true,
    lastFour: verify.meta.lastFour,
    shopDomain: verify.meta.shopDomain || null,
    dc: verify.meta.dc || null,
  });

  // ── Fire-and-forget immediate initial sync so user doesn't wait up to 1h ──
  // For Shopify: we can sync now (we have everything we need).
  // For Mailchimp: skip until user picks a list (auto-sync function will return
  // skipped:"no list selected yet" anyway, but it costs us one API ping).
  if (service === "shopify") {
    setImmediate(async () => {
      try {
        const { runAutoSyncForUser } = require("../sync/auto-sync");
        await runAutoSyncForUser(db, req.userId, service);
      } catch(e) {
        console.error(`[auto-sync] immediate sync failed for user ${req.userId} (${service}):`, e.message);
      }
    });
  }

  // (#3) Fire-and-forget: trigger first sync immediately in background so
  // the user doesn't wait up to 60 minutes for their first auto-sync to run.
  // Wrapped in setImmediate to ensure the HTTP response is sent first.
  setImmediate(async () => {
    try {
      const { runAutoSyncForUser } = require("../sync/auto-sync");
      if (typeof runAutoSyncForUser === "function") {
        await runAutoSyncForUser(db, req.userId, service);
      }
    } catch(e) {
      console.warn("[integration-keys] post-connect sync failed (will retry on next cron tick):", e.message);
    }
  });
});

// ─── DELETE /api/integrations/keys/:service — disconnect ──────────────────
router.delete("/:service", auth, (req, res) => {
  const service = String(req.params.service || "").toLowerCase();
  if (!SUPPORTED.includes(service)) return res.status(400).json({ error: "Unsupported service" });

  const db = getDb();
  ensureTable(db);
  db.prepare("DELETE FROM user_integration_keys WHERE user_id = ? AND service = ?").run(req.userId, service);
  res.json({ ok: true, connected: false });
});

// ─── POST /api/integrations/keys/:service/auto-sync — toggle hourly sync ─
router.post("/:service/auto-sync", auth, (req, res) => {
  const service = String(req.params.service || "").toLowerCase();
  if (!SUPPORTED.includes(service)) return res.status(400).json({ error: "Unsupported service" });
  const enabled = !!req.body.enabled;

  const db = getDb();
  ensureTable(db);
  // Make sure column exists (may pre-date auto-sync feature)
  try { db.exec("ALTER TABLE user_integration_keys ADD COLUMN auto_sync_enabled INTEGER DEFAULT 1"); } catch(_) {}

  const row = db.prepare("SELECT id FROM user_integration_keys WHERE user_id = ? AND service = ?").get(req.userId, service);
  if (!row) return res.status(404).json({ error: "Not connected" });

  db.prepare("UPDATE user_integration_keys SET auto_sync_enabled = ? WHERE id = ?").run(enabled ? 1 : 0, row.id);
  res.json({ ok: true, autoSyncEnabled: enabled });
});

// ─── Internal helper for migration.js to fetch saved key during import ────
// Not exposed as a route — exported for use by sibling route files.
function getSavedKey(db, userId, service) {
  ensureTable(db);
  const row = db.prepare("SELECT ciphertext, iv, auth_tag, meta FROM user_integration_keys WHERE user_id = ? AND service = ?")
                .get(userId, service);
  if (!row) return null;
  try {
    const plaintext = decrypt(row.ciphertext, row.iv, row.auth_tag, userId);
    let meta = {};
    try { meta = JSON.parse(row.meta || "{}"); } catch(_) {}
    // Bump last_used_at
    try { db.prepare("UPDATE user_integration_keys SET last_used_at = datetime('now') WHERE user_id = ? AND service = ?").run(userId, service); } catch(_) {}
    return { apiKey: plaintext, ...meta };
  } catch(_) { return null; }
}

// Reusable save path — used by the POST /:service route's logic and by OAuth
// callbacks (e.g. Shopify). Verifies the key against the live API, stores it
// encrypted at rest, and kicks off an immediate initial sync for Shopify.
async function saveServiceKey(userId, service, apiKey, meta) {
  service = String(service || "").toLowerCase();
  if (!SUPPORTED.includes(service)) return { ok: false, error: "Unsupported service" };
  if (!apiKey || typeof apiKey !== "string") return { ok: false, error: "apiKey required" };
  const verify = await verifyKey(service, apiKey.trim(), meta || {});
  if (!verify.ok) return verify;
  const db = getDb();
  ensureTable(db);
  let enc;
  try { enc = encrypt(apiKey.trim(), userId); }
  catch (e) { return { ok: false, error: e.message }; }
  const existing = db.prepare("SELECT id FROM user_integration_keys WHERE user_id = ? AND service = ?").get(userId, service);
  const metaJson = JSON.stringify(verify.meta);
  if (existing) {
    db.prepare("UPDATE user_integration_keys SET ciphertext=?, iv=?, auth_tag=?, meta=?, created_at=datetime('now') WHERE id=?")
      .run(enc.ciphertext, enc.iv, enc.authTag, metaJson, existing.id);
  } else {
    db.prepare("INSERT INTO user_integration_keys (id, user_id, service, ciphertext, iv, auth_tag, meta) VALUES (?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), userId, service, enc.ciphertext, enc.iv, enc.authTag, metaJson);
  }
  if (service === "shopify") {
    setImmediate(async () => {
      try { const { runAutoSyncForUser } = require("../sync/auto-sync"); await runAutoSyncForUser(db, userId, service); }
      catch (e) { console.error(`[auto-sync] immediate sync failed for user ${userId} (${service}):`, e.message); }
    });
  }
  return { ok: true, meta: verify.meta };
}

module.exports = router;
module.exports.getSavedKey = getSavedKey;
module.exports.saveServiceKey = saveServiceKey;
