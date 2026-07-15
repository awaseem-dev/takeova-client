// MINE — Shopify two-way sync engine.
//
// Makes Take Control operate on the merchant's REAL Shopify data:
//   Shopify → MINE : initial backfill + live webhooks upsert into TAKEOVA's
//                    products / contacts / orders tables.
//   MINE → Shopify : a reconciler pushes MINE product/contact changes back to
//                    the Shopify store (products + customers).
//
// Loop prevention: a content HASH is stored per mapped object. Inbound writes the
// hash of what it just applied; the outbound reconciler skips any row whose hash
// still matches the map — so a change only ever flows once. Round-trip stability
// depends on the normalized field set in productSig()/contactSig().
//
// HONEST: written to documented Shopify Admin REST/GraphQL + webhook shapes;
// verified at compile/load level only — NOT run against a live store. Two-way
// sync MUST be validated + tuned against a real shop (hash round-trip stability,
// pagination, rate limits), and customer read/write needs Shopify's protected-
// customer-data approval. Orders are one-way (Shopify → MINE).

const express = require("express");
const crypto = require("crypto");
const { v4: uuid } = require("uuid");

const webhookRouter = express.Router();
webhookRouter.use(express.raw({ type: "*/*", limit: "2mb" }));

function getDb() { return require("../db/init").getDb(); }
function getSetting(k) {
  try { return getDb().prepare("SELECT value FROM platform_settings WHERE key = ?").get(k)?.value || process.env[k] || ""; }
  catch { return process.env[k] || ""; }
}
const REST = "2024-10";
const APP_URL = () => (getSetting("APP_URL") || getSetting("BACKEND_URL") || "https://app.takeova.ai").replace(/\/+$/, "");

function ensureSync(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS shopify_sync_map (
    shop_domain TEXT, kind TEXT, shopify_id TEXT, shopify_variant_id TEXT,
    mine_id TEXT, hash TEXT, updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (shop_domain, kind, shopify_id)
  )`);
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_ssm_mine ON shopify_sync_map (kind, mine_id)"); } catch (_) {}
}

// ── HMAC / shop helpers ──
function safeEqual(a, b) { const A = Buffer.from(String(a || ""), "utf8"), B = Buffer.from(String(b || ""), "utf8"); return A.length === B.length && crypto.timingSafeEqual(A, B); }
function verifyHmac(raw, h) { const s = getSetting("SHOPIFY_API_SECRET"); if (!s) return false; return safeEqual(crypto.createHmac("sha256", s).update(raw).digest("base64"), h); }
function cleanShop(shop) { const s = String(shop || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "").split("/")[0]; return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s) ? s : ""; }
function guard(req, res) { if (!verifyHmac(req.body, req.get("X-Shopify-Hmac-Sha256"))) { res.status(401).send("hmac"); return false; } return true; }
function body(req) { try { return JSON.parse(req.body.toString("utf8")); } catch { return {}; } }
function installForShop(db, shop) { try { return db.prepare("SELECT * FROM shopify_installs WHERE shop_domain = ?").get(shop) || null; } catch { return null; } }

// ── Admin API ──
const _fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));
function adminFetch(shop, token, url, opts) {
  return _fetch(url, Object.assign({}, opts, { headers: Object.assign({ "X-Shopify-Access-Token": token, "Content-Type": "application/json" }, (opts && opts.headers) || {}) }));
}
async function paginate(shop, token, path, key) {
  let url = `https://${shop}/admin/api/${REST}/${path}`;
  const out = []; let pages = 0;
  while (url && pages < 25) {
    const r = await adminFetch(shop, token, url);
    const j = await r.json().catch(() => ({}));
    const arr = (j && j[key]) || []; for (const x of arr) out.push(x);
    let next = null; const link = r.headers && r.headers.get && r.headers.get("link");
    if (link) { const m = /<([^>]+)>;\s*rel="next"/.exec(link); if (m) next = m[1]; }
    url = next; pages++;
  }
  return out;
}
async function restCreate(shop, token, path, payload) { const r = await adminFetch(shop, token, `https://${shop}/admin/api/${REST}/${path}`, { method: "POST", body: JSON.stringify(payload) }); return r.json().catch(() => ({})); }
async function restPut(shop, token, path, payload) { const r = await adminFetch(shop, token, `https://${shop}/admin/api/${REST}/${path}`, { method: "PUT", body: JSON.stringify(payload) }); return r.json().catch(() => ({})); }
async function shopifyGraphQL(shop, token, query) { const r = await adminFetch(shop, token, `https://${shop}/admin/api/${REST}/graphql.json`, { method: "POST", body: JSON.stringify({ query }) }); return r.json().catch(() => ({})); }

// ── hashing / normalized signatures (keep small for round-trip stability) ──
function hashOf(o) { return crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 32); }
function productSig(p) { return { n: String(p.name || "").trim(), p: Number(p.price || 0).toFixed(2), s: String(p.sku || "").trim(), st: p.status === "active" ? "active" : "draft", d: String(p.description || "").trim().slice(0, 600) }; }
function contactSig(c) { return { n: String(c.name || "").trim(), e: String(c.email || "").trim().toLowerCase(), p: String(c.phone || "").replace(/[^\d]/g, "") }; }

// ── map helpers ──
function mapByShopify(db, shop, kind, sid) { try { return db.prepare("SELECT * FROM shopify_sync_map WHERE shop_domain=? AND kind=? AND shopify_id=?").get(shop, kind, String(sid)); } catch { return null; } }
function mapByMine(db, kind, mid) { try { return db.prepare("SELECT * FROM shopify_sync_map WHERE kind=? AND mine_id=?").get(kind, String(mid)); } catch { return null; } }
function setMap(db, shop, kind, sid, mid, hash, vid) {
  db.prepare(`INSERT INTO shopify_sync_map (shop_domain,kind,shopify_id,shopify_variant_id,mine_id,hash,updated_at)
    VALUES (?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(shop_domain,kind,shopify_id) DO UPDATE SET mine_id=excluded.mine_id, shopify_variant_id=excluded.shopify_variant_id, hash=excluded.hash, updated_at=datetime('now')`)
    .run(shop, kind, String(sid), vid != null ? String(vid) : null, String(mid), hash);
}

// ── INBOUND: Shopify → MINE ──
function upsertProductFromShopify(db, inst, sp) {
  if (!sp || sp.id == null) return;
  const v0 = (sp.variants && sp.variants[0]) || {};
  const fields = {
    name: sp.title || "",
    description: String(sp.body_html || "").replace(/<[^>]+>/g, "").trim(),
    price: parseFloat(v0.price) || 0,
    sku: v0.sku || "",
    stock: (sp.variants || []).reduce((a, v) => a + (v.inventory_quantity || 0), 0),
    status: sp.status === "active" ? "active" : "draft",
    images_json: JSON.stringify((sp.images || []).map(i => i.src)),
    variants_json: JSON.stringify(sp.variants || []),
  };
  const hash = hashOf(productSig(fields));
  const ex = mapByShopify(db, inst.shop_domain, "product", sp.id);
  if (ex) {
    if (ex.hash === hash) return; // unchanged → no echo
    db.prepare("UPDATE products SET name=?, description=?, price=?, sku=?, stock=?, status=?, images_json=?, variants_json=? WHERE id=?")
      .run(fields.name, fields.description, fields.price, fields.sku, fields.stock, fields.status, fields.images_json, fields.variants_json, ex.mine_id);
    setMap(db, inst.shop_domain, "product", sp.id, ex.mine_id, hash, v0.id);
  } else {
    const id = uuid();
    db.prepare("INSERT INTO products (id, user_id, name, description, price, sku, stock, status, images_json, variants_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?, datetime('now'))")
      .run(id, inst.user_id, fields.name, fields.description, fields.price, fields.sku, fields.stock, fields.status, fields.images_json, fields.variants_json);
    setMap(db, inst.shop_domain, "product", sp.id, id, hash, v0.id);
  }
}
function archiveProductFromShopify(db, inst, sp) {
  const ex = mapByShopify(db, inst.shop_domain, "product", sp && sp.id);
  if (!ex) return;
  try { db.prepare("UPDATE products SET status='archived' WHERE id=?").run(ex.mine_id); } catch (_) {}
  try { db.prepare("DELETE FROM shopify_sync_map WHERE shop_domain=? AND kind='product' AND shopify_id=?").run(inst.shop_domain, String(sp.id)); } catch (_) {}
}
function upsertCustomerFromShopify(db, inst, sc) {
  if (!sc || sc.id == null) return;
  const fields = { name: ((sc.first_name || "") + " " + (sc.last_name || "")).trim(), email: sc.email || "", phone: sc.phone || "" };
  const hash = hashOf(contactSig(fields));
  const ex = mapByShopify(db, inst.shop_domain, "customer", sc.id);
  if (ex) {
    if (ex.hash === hash) return;
    db.prepare("UPDATE contacts SET name=?, email=?, phone=?, updated_at=datetime('now') WHERE id=?").run(fields.name, fields.email, fields.phone, ex.mine_id);
    setMap(db, inst.shop_domain, "customer", sc.id, ex.mine_id, hash);
  } else {
    const id = uuid();
    db.prepare("INSERT INTO contacts (id, user_id, name, email, phone, status, source, created_at) VALUES (?,?,?,?,?, 'lead', 'shopify', datetime('now'))")
      .run(id, inst.user_id, fields.name, fields.email, fields.phone);
    setMap(db, inst.shop_domain, "customer", sc.id, id, hash);
  }
}
function upsertOrderFromShopify(db, inst, so) {
  if (!so || so.id == null) return;
  const cust = so.customer || {};
  const name = ((cust.first_name || "") + " " + (cust.last_name || "")).trim() || (so.shipping_address && so.shipping_address.name) || "";
  const items = JSON.stringify((so.line_items || []).map(li => ({ title: li.title, qty: li.quantity, price: li.price })));
  const status = so.cancelled_at ? "cancelled" : (so.financial_status === "paid" ? "paid" : (so.financial_status || "pending"));
  const ex = mapByShopify(db, inst.shop_domain, "order", so.id);
  if (ex) {
    db.prepare("UPDATE orders SET status=?, fulfillment_status=?, total=?, tracking_number=?, tracking_url=? WHERE id=?")
      .run(status, so.fulfillment_status || "unfulfilled", parseFloat(so.total_price) || 0,
        ((so.fulfillments && so.fulfillments[0] && so.fulfillments[0].tracking_number) || ""),
        ((so.fulfillments && so.fulfillments[0] && so.fulfillments[0].tracking_url) || ""), ex.mine_id);
  } else {
    const id = uuid();
    db.prepare("INSERT INTO orders (id, user_id, order_number, customer_name, customer_email, items, total, status, fulfillment_status, created_at) VALUES (?,?,?,?,?,?,?,?,?, datetime('now'))")
      .run(id, inst.user_id, so.name || ("#" + (so.order_number || so.number || "")), name, (cust.email || so.email || ""), items, parseFloat(so.total_price) || 0, status, so.fulfillment_status || "unfulfilled");
    setMap(db, inst.shop_domain, "order", so.id, id, hashOf({ id: so.id }));
  }
}

// ── OUTBOUND: MINE → Shopify (products + customers) ──
async function pushProduct(db, inst, mineId) {
  const shop = inst.shop_domain, token = inst.access_token; if (!token) return;
  const p = db.prepare("SELECT * FROM products WHERE id=?").get(mineId); if (!p) return;
  const hash = hashOf(productSig(p));
  const m = mapByMine(db, "product", mineId);
  if (m && m.hash === hash) return; // unchanged since last sync → echo guard
  if (m && m.shopify_id) {
    await restPut(shop, token, `products/${m.shopify_id}.json`, { product: { id: Number(m.shopify_id), title: p.name || "", body_html: p.description || "", status: p.status === "active" ? "active" : "draft" } });
    if (m.shopify_variant_id) await restPut(shop, token, `variants/${m.shopify_variant_id}.json`, { variant: { id: Number(m.shopify_variant_id), price: Number(p.price || 0).toFixed(2), sku: p.sku || "" } });
    setMap(db, shop, "product", m.shopify_id, mineId, hash, m.shopify_variant_id);
  } else {
    const res = await restCreate(shop, token, "products.json", { product: { title: p.name || "Untitled", body_html: p.description || "", status: p.status === "active" ? "active" : "draft", variants: [{ price: Number(p.price || 0).toFixed(2), sku: p.sku || "" }] } });
    const sp = res && res.product;
    if (sp && sp.id) setMap(db, shop, "product", sp.id, mineId, hash, sp.variants && sp.variants[0] && sp.variants[0].id);
  }
}
async function pushCustomer(db, inst, mineId) {
  const shop = inst.shop_domain, token = inst.access_token; if (!token) return;
  const c = db.prepare("SELECT * FROM contacts WHERE id=?").get(mineId); if (!c || !c.email) return;
  const hash = hashOf(contactSig(c));
  const m = mapByMine(db, "customer", mineId);
  if (m && m.hash === hash) return;
  const parts = String(c.name || "").trim().split(/\s+/);
  const first = parts.shift() || ""; const last = parts.join(" ");
  if (m && m.shopify_id) {
    await restPut(shop, token, `customers/${m.shopify_id}.json`, { customer: { id: Number(m.shopify_id), first_name: first, last_name: last, email: c.email, phone: c.phone || undefined } });
    setMap(db, shop, "customer", m.shopify_id, mineId, hash);
  } else {
    const res = await restCreate(shop, token, "customers.json", { customer: { first_name: first, last_name: last, email: c.email, phone: c.phone || undefined } });
    const sc = res && res.customer;
    if (sc && sc.id) setMap(db, shop, "customer", sc.id, mineId, hash);
  }
}
async function reconcileOutbound(db) {
  ensureSync(db);
  let installs = [];
  try { installs = db.prepare("SELECT * FROM shopify_installs WHERE access_token IS NOT NULL AND status IN ('installed','active','pending_approval')").all() || []; } catch (_) {}
  for (const inst of installs) {
    if (!inst.user_id) continue;
    let prods = []; try { prods = db.prepare("SELECT id FROM products WHERE user_id=?").all(inst.user_id) || []; } catch (_) {}
    for (const r of prods) { try { await pushProduct(db, inst, r.id); } catch (e) { console.error("[sync push product]", e.message); } }
    let cons = []; try { cons = db.prepare("SELECT id FROM contacts WHERE user_id=? AND email IS NOT NULL AND email<>''").all(inst.user_id) || []; } catch (_) {}
    for (const r of cons) { try { await pushCustomer(db, inst, r.id); } catch (e) { console.error("[sync push customer]", e.message); } }
  }
}

// ── backfill (run on install + on demand) ──
async function backfillFromShopify(db, shop) {
  ensureSync(db);
  const inst = installForShop(db, shop); if (!inst || !inst.access_token) return;
  const token = inst.access_token;
  try { (await paginate(shop, token, "products.json?limit=250", "products")).forEach(sp => upsertProductFromShopify(db, inst, sp)); } catch (e) { console.error("[backfill products]", e.message); }
  try { (await paginate(shop, token, "customers.json?limit=250", "customers")).forEach(sc => upsertCustomerFromShopify(db, inst, sc)); } catch (e) { console.error("[backfill customers]", e.message); }
  try { (await paginate(shop, token, "orders.json?status=any&limit=250", "orders")).forEach(so => upsertOrderFromShopify(db, inst, so)); } catch (e) { console.error("[backfill orders]", e.message); }
}

// ── register the sync webhook topics (called on install) ──
async function registerSyncWebhooks(shop, token) {
  const topics = [
    ["PRODUCTS_CREATE", "/api/shopify/webhooks/sync_products_create"],
    ["PRODUCTS_UPDATE", "/api/shopify/webhooks/sync_products_update"],
    ["PRODUCTS_DELETE", "/api/shopify/webhooks/sync_products_delete"],
    ["CUSTOMERS_CREATE", "/api/shopify/webhooks/sync_customers_create"],
    ["CUSTOMERS_UPDATE", "/api/shopify/webhooks/sync_customers_update"],
    ["ORDERS_CREATE", "/api/shopify/webhooks/sync_orders_create"],
    ["ORDERS_UPDATED", "/api/shopify/webhooks/sync_orders_updated"],
    ["ORDERS_CANCELLED", "/api/shopify/webhooks/sync_orders_cancelled"],
  ];
  for (const [t, p] of topics) {
    const cb = `${APP_URL()}${p}`;
    const m = `mutation { webhookSubscriptionCreate(topic: ${t}, webhookSubscription: { callbackUrl: "${cb}", format: JSON }) { userErrors { message } webhookSubscription { id } } }`;
    try { await shopifyGraphQL(shop, token, m); } catch (_) {}
  }
}

// ── INBOUND webhook receivers (ack fast, then upsert) ──
function recv(handler) {
  return (req, res) => {
    if (!guard(req, res)) return;
    res.sendStatus(200);
    try {
      const db = getDb(); ensureSync(db);
      const inst = installForShop(db, cleanShop(req.get("X-Shopify-Shop-Domain")));
      if (!inst || !inst.user_id) return;
      handler(db, inst, body(req));
    } catch (e) { console.error("[shopify sync recv]", e.message); }
  };
}
webhookRouter.post("/sync_products_create", recv(upsertProductFromShopify));
webhookRouter.post("/sync_products_update", recv(upsertProductFromShopify));
webhookRouter.post("/sync_products_delete", recv(archiveProductFromShopify));
webhookRouter.post("/sync_customers_create", recv(upsertCustomerFromShopify));
webhookRouter.post("/sync_customers_update", recv(upsertCustomerFromShopify));
webhookRouter.post("/sync_orders_create", recv(upsertOrderFromShopify));
webhookRouter.post("/sync_orders_updated", recv(upsertOrderFromShopify));
webhookRouter.post("/sync_orders_cancelled", recv(upsertOrderFromShopify));

// ── outbound reconcile scheduler ──
let _timer = null;
function startSyncScheduler(db) {
  if (_timer) return;
  const everyMs = Math.max(2, parseInt(getSetting("SHOPIFY_SYNC_POLL_MIN") || "10", 10)) * 60000;
  _timer = setInterval(() => { reconcileOutbound(db).catch(() => {}); }, everyMs);
  if (_timer.unref) _timer.unref();
}

// ── commerce write-backs invoked by Take Control (origin='shopify' branch) ──
async function restGet(shop, token, path) { const r = await adminFetch(shop, token, `https://${shop}/admin/api/${REST}/${path}`); return r.json().catch(() => ({})); }
function installByUser(db, userId) { try { return db.prepare("SELECT * FROM shopify_installs WHERE user_id = ?").get(userId) || null; } catch { return null; } }
async function primaryLocationId(shop, token) { const j = await restGet(shop, token, "locations.json"); const locs = (j && j.locations) || []; const a = locs.find(l => l.active !== false) || locs[0]; return a ? a.id : null; }

async function editProduct(db, userId, input) {
  ensureSync(db);
  const inst = installByUser(db, userId); if (!inst) return { message: "No Shopify store connected." };
  const q = input.product_name || input.name; if (!q) return { message: "Which product? Give me the product name." };
  const p = db.prepare("SELECT * FROM products WHERE user_id = ? AND name LIKE ? LIMIT 1").get(userId, `%${q}%`);
  if (!p) return { message: `Couldn't find a product matching "${q}".` };
  const sets = [], vals = [];
  if (input.new_name) { sets.push("name=?"); vals.push(input.new_name); }
  if (input.price !== undefined) { sets.push("price=?"); vals.push(input.price); }
  if (input.description !== undefined) { sets.push("description=?"); vals.push(input.description); }
  if (input.status) { sets.push("status=?"); vals.push(input.status === "active" ? "active" : "draft"); }
  if (!sets.length) return { message: "Tell me the new price, name, or description." };
  vals.push(p.id);
  db.prepare(`UPDATE products SET ${sets.join(", ")} WHERE id=?`).run(...vals);
  try { await pushProduct(db, inst, p.id); } catch (e) { return { message: `Updated in MINE, but the Shopify push failed: ${e.message}` }; }
  return { message: `✓ Updated "${input.new_name || p.name}" and synced it to Shopify.` };
}

async function addProduct(db, userId, input) {
  ensureSync(db);
  const inst = installByUser(db, userId); if (!inst) return { message: "No Shopify store connected." };
  const id = uuid();
  const stock = input.stock !== undefined ? input.stock : 0;
  db.prepare("INSERT INTO products (id, user_id, name, price, description, stock, status, created_at) VALUES (?,?,?,?,?,?, 'active', datetime('now'))")
    .run(id, userId, input.name, input.price, input.description || "", stock);
  try { await pushProduct(db, inst, id); } catch (e) { return { message: `Added in MINE, but the Shopify push failed: ${e.message}` }; }
  return { message: `✓ Added "${input.name}" at $${input.price} and pushed it to your Shopify store.` };
}

async function setInventory(db, inst, mineId, qty) {
  const m = mapByMine(db, "product", mineId); if (!m || !m.shopify_variant_id) return { ok: false, reason: "no Shopify variant mapping" };
  const shop = inst.shop_domain, token = inst.access_token;
  const vj = await restGet(shop, token, `variants/${m.shopify_variant_id}.json`);
  const invItem = vj && vj.variant && vj.variant.inventory_item_id; if (!invItem) return { ok: false, reason: "no inventory item" };
  try { await restPut(shop, token, `variants/${m.shopify_variant_id}.json`, { variant: { id: Number(m.shopify_variant_id), inventory_management: "shopify" } }); } catch (_) {}
  const loc = await primaryLocationId(shop, token); if (!loc) return { ok: false, reason: "no location" };
  const res = await restCreate(shop, token, "inventory_levels/set.json", { location_id: loc, inventory_item_id: invItem, available: Math.round(qty) });
  if (res && res.errors) return { ok: false, reason: JSON.stringify(res.errors) };
  return { ok: true };
}

async function stockTool(db, userId, input) {
  ensureSync(db);
  const inst = installByUser(db, userId); if (!inst) return { message: "No Shopify store connected." };
  if (input.product_name && input.update_stock !== undefined) {
    const p = db.prepare("SELECT * FROM products WHERE user_id = ? AND name LIKE ? LIMIT 1").get(userId, `%${input.product_name}%`);
    if (!p) return { message: `Couldn't find a product matching "${input.product_name}".` };
    db.prepare("UPDATE products SET stock=? WHERE id=?").run(input.update_stock, p.id);
    const r = await setInventory(db, inst, p.id, input.update_stock);
    if (!r.ok) return { message: `Stock set to ${input.update_stock} in MINE, but the Shopify inventory update failed: ${r.reason}.` };
    return { message: `✓ Stock for "${p.name}" set to ${input.update_stock} and synced to Shopify.` };
  }
  const rows = input.product_name
    ? db.prepare("SELECT name, price, stock, status FROM products WHERE user_id = ? AND name LIKE ? LIMIT 5").all(userId, `%${input.product_name}%`)
    : db.prepare("SELECT name, price, stock, status FROM products WHERE user_id = ? ORDER BY stock ASC LIMIT 10").all(userId);
  if (!rows.length) return { message: "No products in your synced Shopify catalog yet." };
  const low = rows.filter(p => p.stock !== null && p.stock < 10);
  return { products: rows.map(p => ({ name: p.name, price: `$${p.price}`, stock: p.stock, status: p.status })), low_stock_alert: low.length ? `⚠️ ${low.map(p => `${p.name} (${p.stock} left)`).join(", ")}` : null };
}

async function createDiscount(db, userId, input) {
  const inst = installByUser(db, userId); if (!inst) return { message: "No Shopify store connected." };
  const shop = inst.shop_domain, token = inst.access_token;
  const code = (input.code || ("MINE" + Math.random().toString(36).slice(2, 6).toUpperCase())).toUpperCase();
  const valueType = input.percent_off ? "percentage" : "fixed_amount";
  const value = input.percent_off ? (-Math.abs(input.percent_off)).toString() : (-Math.abs(input.amount_off || 0)).toString();
  const ends = input.expires_days ? new Date(Date.now() + input.expires_days * 86400000).toISOString() : null;
  const pr = await restCreate(shop, token, "price_rules.json", { price_rule: { title: code, target_type: "line_item", target_selection: "all", allocation_method: "across", value_type: valueType, value, customer_selection: "all", starts_at: new Date().toISOString(), ends_at: ends, usage_limit: input.max_uses || null } });
  const rule = pr && pr.price_rule; if (!rule || !rule.id) return { message: `Couldn't create the discount in Shopify${pr && pr.errors ? ": " + JSON.stringify(pr.errors) : ""}.` };
  const dc = await restCreate(shop, token, `price_rules/${rule.id}/discount_codes.json`, { discount_code: { code } });
  if (!(dc && dc.discount_code)) return { message: `Created the rule but the code failed${dc && dc.errors ? ": " + JSON.stringify(dc.errors) : ""}.` };
  const disc = input.percent_off ? `${input.percent_off}% off` : `$${input.amount_off} off`;
  return { message: `✓ Shopify discount created: ${code} — ${disc}${input.expires_days ? `, expires in ${input.expires_days} days` : ""}. Live at checkout.` };
}

async function refundOrder(db, userId, input) {
  ensureSync(db);
  const inst = installByUser(db, userId); if (!inst) return { message: "No Shopify store connected." };
  const shop = inst.shop_domain, token = inst.access_token;
  let mineOrder = null;
  if (input.order_id) mineOrder = db.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").get(input.order_id, userId);
  else if (input.customer_name) mineOrder = db.prepare("SELECT * FROM orders WHERE user_id = ? AND customer_name LIKE ? ORDER BY created_at DESC LIMIT 1").get(userId, `%${input.customer_name}%`);
  let shopifyOrderId = null;
  if (mineOrder) { const m = mapByMine(db, "order", mineOrder.id); if (m) shopifyOrderId = m.shopify_id; }
  if (!shopifyOrderId && input.order_number) { const sj = await restGet(shop, token, `orders.json?status=any&name=${encodeURIComponent(input.order_number)}`); const o = sj && sj.orders && sj.orders[0]; if (o) shopifyOrderId = o.id; }
  if (!shopifyOrderId) return { message: `Couldn't find that order in Shopify${input.customer_name ? ` for "${input.customer_name}"` : ""}.` };
  const oj = await restGet(shop, token, `orders/${shopifyOrderId}.json`);
  const order = oj && oj.order; if (!order) return { message: "Couldn't load the Shopify order." };
  const refundLineItems = (order.line_items || []).map(li => ({ line_item_id: li.id, quantity: li.quantity, restock_type: "return" }));
  const calc = await restCreate(shop, token, `orders/${shopifyOrderId}/refunds/calculate.json`, { refund: { currency: order.currency, shipping: { full_refund: true }, refund_line_items: refundLineItems } });
  const suggested = calc && calc.refund; if (!suggested) return { message: `Couldn't calculate the refund${calc && calc.errors ? ": " + JSON.stringify(calc.errors) : ""}.` };
  const transactions = (suggested.transactions || []).map(t => ({ parent_id: t.parent_id, amount: t.amount, kind: "refund", gateway: t.gateway, order_id: shopifyOrderId }));
  const create = await restCreate(shop, token, `orders/${shopifyOrderId}/refunds.json`, { refund: { currency: order.currency, notify: true, note: input.reason || "Refunded via Take Control", shipping: { full_refund: true }, refund_line_items: refundLineItems, transactions } });
  if (!(create && create.refund)) return { message: `Refund calculation succeeded but the refund failed${create && create.errors ? ": " + JSON.stringify(create.errors) : ""}.` };
  if (mineOrder) { try { db.prepare("UPDATE orders SET status='refunded' WHERE id=?").run(mineOrder.id); } catch (_) {} }
  return { message: `✓ Refunded ${order.name} on Shopify${order.total_price ? ` — ${order.currency} ${order.total_price}` : ""}. The customer has been notified.` };
}

module.exports = {
  webhookRouter, ensureSync, startSyncScheduler,
  backfillFromShopify, registerSyncWebhooks, reconcileOutbound,
  pushProduct, pushCustomer,
  editProduct, addProduct, stockTool, createDiscount, refundOrder,
};
