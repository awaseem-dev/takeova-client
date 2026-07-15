const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { getDb, getSetting } = require("../db/init");
// Per-tenant agent outcome tracking (safe-loaded; no-op if enhancements unmounted)
let _enh; try { _enh = require("./ai-employees-enhancements"); } catch (_) { _enh = null; }
const updateOutcome = (_enh && _enh.updateOutcome) ? _enh.updateOutcome : function(){};
const { auth, ownerOnly } = require("../middleware/auth");
const { v4: uuid } = require("uuid");
const sanitizeHtml = require("sanitize-html");

// Allowed HTML for AI-generated proposal content — blocks scripts, iframes, event handlers
const PROPOSAL_SANITIZE_OPTS = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(["table","thead","tbody","tr","td","th","h1","h2","h3","h4","img","hr","br","strong","em","ul","ol","li","p","div","span","section","header","footer","style"]),
  allowedAttributes: { "*": ["style","class","align","width","height","colspan","rowspan"], "a": ["href","target","rel"], "img": ["src","alt","width","height"] },
  allowedSchemes: ["https","http","mailto"],
  disallowedTagsMode: "discard",
};

const _stripe = process.env.STRIPE_SECRET_KEY ? require("stripe")(process.env.STRIPE_SECRET_KEY) : null;
const router = express.Router();

// Lazily resolve Stripe — key may be set via admin panel (platform_settings) after startup
function getStripe() {
  if (_stripe) return _stripe;
  const key = getSetting("STRIPE_SECRET_KEY");
  return key ? require("stripe")(key) : null;
}
const requireStripe = (res) => {
  if (!getStripe()) { res.status(503).json({ error: "Stripe not configured — add STRIPE_SECRET_KEY" }); return false; }
  return true;
};
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
const DASHBOARD_URL = process.env.DASHBOARD_URL || `${FRONTEND_URL}/mine-all-in-one-dashboard.html`;

// Escape user-supplied strings for safe HTML interpolation
function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Platform-fee logic lives in ../lib/fees.js (extracted so it can be unit-tested).
// Values + getFeeForPlan() behaviour are identical to the previous inline copy.
const { PLATFORM_FEE_PERCENT, PLAN_FEE_PERCENT, getFeeForPlan, platformFeeCents } = require("../lib/fees");

// Rate limiters for public endpoints
const checkoutLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, keyGenerator: req => req.ip, message: { error: "Too many checkout attempts — please slow down" }, standardHeaders: true, legacyHeaders: false });
const promoLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, keyGenerator: req => req.ip, message: { error: "Too many promo code attempts" }, standardHeaders: true, legacyHeaders: false });

const METRIC_NAMES = {
  edits:"AI Edits", images:"AI Images", aiVideos:"AI Videos", ugcVideos:"UGC Videos",
  emails:"Emails", outreachEmails:"Outreach Emails", outreachSMS:"Outreach SMS",
  voiceMins:"Voice Minutes", proposals:"AI Proposals", socialPosts:"Social Posts",
  adCreatives:"Ad Creatives", aiActions:"AI Actions", chatbotChats:"Chatbot Chats",
  competitorReports:"Competitor Reports", aiResearch:"AI Research", blogPosts:"Blog Posts",
  contracts:"Contracts", mentorChats:"Mentor Chats", knowledgeBase:"Knowledge Base Articles",
  leadMagnets:"Lead Magnets", customerChats:"Customer Chats",
  productDescs:"AI Product Descriptions", reviewReplies:"AI Review Replies",
  socialCaptions:"AI Social Captions", invoiceChasers:"AI Invoice Chasers",
  upsellRecs:"AI Upsell Recommendations", cartPersonalise:"AI Cart Personalisation",
  faqGeneration:"AI FAQ Generation", refundHandling:"AI Refund Handling",
  competitorAnalysis:"AI Competitor Analysis", salesCopy:"AI Sales Copy",
  intelligenceRefresh:"TAKEOVA Intelligence Refresh"
};

// Multi-currency support — get currency for a site or default to USD
// Requires Pro or Enterprise plan; falls back to USD for lower plans
function getCurrency(db, siteId, userId) {
  if (!siteId) return "usd";
  try {
    // Check plan if userId provided
    if (userId) {
      const user = db.prepare("SELECT plan FROM users WHERE id = ?").get(userId);
      if (!user || !["pro", "enterprise", "agency"].includes(user.plan)) return "usd";
    }
    const site = db.prepare("SELECT site_meta FROM sites WHERE id = ?").get(siteId);
    if (site?.site_meta) {
      const meta = (function(s){try{return JSON.parse(s);}catch(_){return {};}})(site.site_meta);
      if (meta.currency) return meta.currency.toLowerCase();
    }
  } catch (e) {}
  return "usd";
}

// Supported currencies with Stripe
const SUPPORTED_CURRENCIES = ["usd","eur","gbp","aud","cad","nzd","jpy","chf","sek","nok","dkk","sgd","hkd","mxn","brl","inr","zar","aed","pln","czk","huf","ron","bgn","hrk","thb","myr","php","idr","krw","twd"];

// ── MULTI-CURRENCY ENDPOINTS ──────────────────────────────────────────────────

// GET /api/payments/currency/:siteId — get site currency (any plan can read)
router.get("/currency/:siteId", auth, (req, res) => {
  const db = getDb();
  const site = db.prepare("SELECT site_meta, user_id FROM sites WHERE id = ? AND user_id = ?").get(req.params.siteId, req.userId);
  if (!site) return res.status(404).json({ error: "Site not found" });
  let currency = "usd";
  try { const m = JSON.parse(site.site_meta || "{}"); currency = m.currency || "usd"; } catch(e) {}
  res.json({ currency, supported: SUPPORTED_CURRENCIES });
});

// POST /api/payments/currency/:siteId — set site currency (Pro and Enterprise only)
router.post("/currency/:siteId", auth, (req, res) => {
  const db = getDb();
  const plan = req.user?.plan || "starter";
  if (!["pro", "enterprise", "agency"].includes(plan)) {
    return res.status(403).json({ error: "Multi-currency requires Pro or Enterprise plan", upgrade_to: "pro" });
  }
  const { currency } = req.body;
  if (!currency || !SUPPORTED_CURRENCIES.includes(currency.toLowerCase())) {
    return res.status(400).json({ error: "Unsupported currency", supported: SUPPORTED_CURRENCIES });
  }
  const site = db.prepare("SELECT site_meta FROM sites WHERE id = ? AND user_id = ?").get(req.params.siteId, req.userId);
  if (!site) return res.status(404).json({ error: "Site not found" });
  try {
    const meta = JSON.parse(site.site_meta || "{}");
    meta.currency = currency.toLowerCase();
    db.prepare("UPDATE sites SET site_meta = ? WHERE id = ?").run(JSON.stringify(meta), req.params.siteId);
    res.json({ success: true, currency: meta.currency });
  } catch(e) {
    res.status(500).json({ error: "Failed to update currency" });
  }
});

// DELETE /api/payments/currency/:siteId — reset to USD
router.delete("/currency/:siteId", auth, (req, res) => {
  const db = getDb();
  const site = db.prepare("SELECT site_meta FROM sites WHERE id = ? AND user_id = ?").get(req.params.siteId, req.userId);
  if (!site) return res.status(404).json({ error: "Site not found" });
  try {
    const meta = JSON.parse(site.site_meta || "{}");
    delete meta.currency;
    db.prepare("UPDATE sites SET site_meta = ? WHERE id = ?").run(JSON.stringify(meta), req.params.siteId);
    res.json({ success: true, currency: "usd" });
  } catch(e) {
    res.status(500).json({ error: "Failed to reset currency" });
  }
});


async function fireAutomation(userId, trigger_type, trigger_data) {
  try {
    const fetch = (await import("node-fetch")).default;
    fetch((process.env.BACKEND_URL || "http://localhost:4000") + "/api/platform/automations/execute", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-key": process.env.INTERNAL_API_KEY || "",
        "x-user-id": userId
      },
      body: JSON.stringify({ trigger_type, trigger_data })
    }).catch(() => {});
  } catch (e) { }
}

const PLANS = {
  starter: { name: "Starter", price: 7900, annualPrice: 6300 },
  growth: { name: "Growth", price: 12900, annualPrice: 10300 },
  pro: { name: "Pro", price: 19900, annualPrice: 15900 },
  enterprise: { name: "Enterprise", price: 39900, annualPrice: 31900 },
  agency: { name: "Agency", price: 79900, annualPrice: 63900 },
};

const AI_ADDONS = {
  designer:     { name: "AI Designer",                   price: 7900, description: "Designs on demand \u2014 social graphics, ad creatives, brand kit, plus print-ready PDF flyers, business cards and price lists. Plan design caps apply \u2192 $2.50/design overage." },
  sales:        { name: "AI Sales Rep",                  price: 7900, description: "Follows up leads via email/SMS/WhatsApp. 500 follow-ups/mo included · $0.05/follow-up overage." },
  support:      { name: "AI Support Agent",              price: 7900, description: "Replies to support tickets and live chat 24/7. 1,000 replies/mo included · $0.02/reply overage." },
  social:       { name: "AI Social Manager",             price: 8900, description: "Writes and schedules posts across all 6 platforms. 120 posts/mo included · $0.10/post overage." },
  bookkeeper:   { name: "AI Bookkeeper",                 price: 7900, description: "Categorises transactions, flags anomalies, generates reports. Unlimited transactions · monthly report included." },
  marketing:    { name: "AI Marketing Manager",          price: 8900, description: "Runs email campaigns, ad copy, and funnel optimisation. 10 campaigns/mo included · $1.00/campaign overage." },
  voice:        { name: "AI Receptionist",               price: 9900, description: "Answers calls, books appointments, sends SMS follow-ups. 100 mins/mo included · $0.15/min overage." },
  mine_control: { name: "Take Control (WhatsApp Agent)", price: 8900, description: "100 msg/mo (Growth·$0.10 overage) · 200/mo (Pro·$0.08) · 500/mo (Enterprise·$0.06)." },
  growth_agent: { name: "TAKEOVA Growth Agent",             price: 8900, description: "Daily business analysis, proactive recommendations, automated growth tasks. 30 reports/mo included." },
  csm:          { name: "AI Customer Success",           price: 4900, description: "Health monitoring, churn prevention, win-back campaigns. 500 check-ins/mo included · $0.03/check-in overage." },
  legal:        { name: "AI Legal Employee",             price: 8900, description: "Contract drafting, review, clause tools, expiry alerts. 20 AI actions/mo included · $0.50/action overage." },
  community:        { name: "Community Engagement Agent",    price: 7900, description: "Monitors Reddit + X, replies to drive traffic. 4x daily scans · 200 replies/mo included · $0.05/reply overage." },
  prospector_agent: { name: "Prospector Agent",               price: 7900, description: "Find mid-ranking businesses, build demo sites, send outreach. $0.50 per demo generated." },
  proposal_agent:   { name: "AI Proposal Agent",               price: 4900, description: "Scrapes prospect website, generates fully personalised proposal. $0.40 per proposal." },
  cold_email_agent: { name: "AI Cold Email Agent",             price: 6900, description: "Claude researches each prospect and writes a personalised email. $0.12 per email sent." },
};

const PROMOS = {
  LAUNCH50: { percent_off: 50, duration: "once", name: "50% off first month" },
};

const cache = { prices: {}, coupons: {} };

async function ensurePrice(planId, planSet, interval) {
  interval = interval || "month";
  const cacheKey = planSet + "_" + planId + "_" + interval;
  if (cache.prices[cacheKey]) return cache.prices[cacheKey];
  const plan = planSet === "ai" ? AI_ADDONS[planId] : PLANS[planId];
  if (!plan) return null;

  // Determine price: annual plans use annualPrice, billed yearly
  let unitAmount;
  if (interval === "year" && plan.annualPrice) {
    unitAmount = plan.annualPrice * 12; // annual total (e.g. $15/mo * 12 = $180/yr)
  } else {
    unitAmount = plan.price; // monthly (e.g. $79/mo = 7900 cents)
  }

  const products = await getStripe().products.list({ limit: 100 });
  let product = products.data.find(p => p.metadata.mine_plan === planSet + "_" + planId);
  if (!product) product = await getStripe().products.create({ name: `MINE ${plan.name}`, metadata: { mine_plan: planSet + "_" + planId } });
  const prices = await getStripe().prices.list({ product: product.id, limit: 20 });
  let price = prices.data.find(p => p.unit_amount === unitAmount && p.recurring?.interval === interval);
  if (!price) price = await getStripe().prices.create({ product: product.id, unit_amount: unitAmount, currency: "usd", recurring: { interval } });
  cache.prices[cacheKey] = price.id;
  return price.id;
}

async function ensureCoupon(code) {
  if (cache.coupons[code]) return cache.coupons[code];
  const promo = PROMOS[code];
  if (!promo) return null;
  const coupons = await getStripe().coupons.list({ limit: 100 });
  let coupon = coupons.data.find(c => c.metadata?.mine_promo === code);
  if (!coupon) coupon = await getStripe().coupons.create({ percent_off: promo.percent_off, duration: promo.duration, name: promo.name, metadata: { mine_promo: code } });
  cache.coupons[code] = coupon.id;
  return coupon.id;
}

// ═══════════════════════════════════════════════
// PART 1: PLATFORM SUBSCRIPTIONS (user pays YOU)
// ═══════════════════════════════════════════════


// ── Addon subscription tracking ─────────────────────────────────────────────
function ensureAddonTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS user_addons (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    addon_id TEXT NOT NULL,
    stripe_subscription_id TEXT,
    stripe_item_id TEXT,
    status TEXT DEFAULT 'active',
    activated_at TEXT DEFAULT (datetime('now')),
    cancelled_at TEXT,
    UNIQUE(user_id, addon_id)
  );
  CREATE INDEX IF NOT EXISTS idx_user_addons_user ON user_addons(user_id);
  `);
}

router.post("/create-checkout-session", auth, ownerOnly, async (req, res) => {
  try {
    if (!requireStripe(res)) return;
    try {
      const { planId, promoCode, aiAddons, billing } = req.body;
      if (!PLANS[planId]) return res.status(400).json({ error: "Invalid plan" });

      const interval = billing === "annual" ? "year" : "month";
      const db = getDb();
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
      const priceId = await ensurePrice(planId, "plan", interval);

      let customerId = user.stripe_customer_id;
      if (!customerId) {
        const customer = await getStripe().customers.create({ email: user.email, metadata: { mine_user: user.id } });
        customerId = customer.id;
        db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(customerId, user.id);
      }

      const lineItems = [{ price: priceId, quantity: 1 }];
      if (aiAddons && aiAddons.length > 0) {
        for (const addon of aiAddons) {
          const addonPriceId = await ensurePrice(addon, "ai", "month"); // AI addons always monthly
          if (addonPriceId) lineItems.push({ price: addonPriceId, quantity: 1 });
        }
      }

      const params = {
        customer: customerId, mode: "subscription",
        line_items: lineItems,
        payment_method_collection: "always",
        success_url: `${DASHBOARD_URL}?session_id={CHECKOUT_SESSION_ID}&plan=${planId}&billing=${interval}`,
        cancel_url: `${DASHBOARD_URL}?cancelled=true`,
        metadata: { mine_user: user.id, mine_plan: planId, mine_billing: interval, mine_promo: promoCode || "", ai_addons: (aiAddons || []).join(","), ref_code: req.body.ref_code || "" },
        subscription_data: {
          // 3-day free trial for any first-time subscriber, on any plan
          trial_period_days: !user.stripe_subscription_id ? 3 : 0,
          metadata: { mine_user: user.id, mine_plan: planId, mine_billing: interval, ref_code: req.body.ref_code || "" }
        },
      };

      // Auto-apply the advertised first-month promo when none entered (override via DEFAULT_SIGNUP_PROMO, set to "none" to disable)
      const _pc = (promoCode || process.env.DEFAULT_SIGNUP_PROMO || "LAUNCH50").toUpperCase();
      if (_pc !== "NONE") {
        let couponId = null;
        try { couponId = await ensureCoupon(_pc); } catch (_e) {}
        if (couponId) params.discounts = [{ coupon: couponId }];
      }

      const session = await getStripe().checkout.sessions.create(params);
      res.json({ url: session.url, sessionId: session.id });
    } catch (e) { console.error("[Route] Internal error:", e?.message);
      res.status(500).json({ error: "An internal error occurred" }); }
  } catch(e) {
    console.error("[Payments]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

router.post("/create-portal-session", auth, ownerOnly, async (req, res) => {
  try {
    if (!requireStripe(res)) return;
    try {
      const db = getDb();
      const user = db.prepare("SELECT stripe_customer_id FROM users WHERE id = ?").get(req.userId);
      if (!user?.stripe_customer_id) return res.status(400).json({ error: "No billing account" });
      const session = await getStripe().billingPortal.sessions.create({
        customer: user.stripe_customer_id, return_url: FRONTEND_URL,
      });
      res.json({ url: session.url });
    } catch (e) { console.error("[Route] Internal error:", e?.message);
      res.status(500).json({ error: "An internal error occurred" }); }
  } catch(e) {
    console.error("[Payments]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ── Switch current subscription to annual billing ──
router.post("/switch-annual", auth, ownerOnly, async (req, res) => {
  try {
    if (!requireStripe(res)) return;
    const db = getDb();
    const user = db.prepare("SELECT plan, stripe_subscription_id FROM users WHERE id = ?").get(req.userId);
    if (!user) return res.status(404).json({ error: "Account not found" });
    if (!user.stripe_subscription_id) {
      return res.status(400).json({ error: "No active subscription to switch — start a plan first" });
    }
    const planId = user.plan;
    if (!planId || !PLANS[planId]) {
      return res.status(400).json({ error: "Your plan can't be switched to annual automatically — please use the billing portal" });
    }
    const annualPrice = await ensurePrice(planId, "plan", "year");
    if (!annualPrice) {
      return res.status(400).json({ error: "Annual pricing isn't available for your plan" });
    }
    const stripe = getStripe();
    const sub = await stripe.subscriptions.retrieve(user.stripe_subscription_id, { expand: ["items.data.price.product"] });
    // Match the main plan item by product metadata; fall back to the monthly item, then first item
    let planItem = sub.items.data.find(it => it.price && it.price.product && it.price.product.metadata && it.price.product.metadata.mine_plan === "plan_" + planId);
    if (!planItem) planItem = sub.items.data.find(it => it.price && it.price.recurring && it.price.recurring.interval === "month");
    if (!planItem) planItem = sub.items.data[0];
    if (!planItem) return res.status(400).json({ error: "Subscription has no items to update" });
    if (planItem.price && planItem.price.recurring && planItem.price.recurring.interval === "year") {
      return res.json({ success: true, already_annual: true, message: "Already on annual billing" });
    }
    await stripe.subscriptions.update(user.stripe_subscription_id, {
      items: [{ id: planItem.id, price: annualPrice }],
      proration_behavior: "create_prorations",
    });
    res.json({ success: true, message: "Switched to annual billing" });
  } catch (e) {
    console.error("[Payments] switch-annual", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Couldn't switch to annual billing — please try again or use the billing portal" });
  }
});

// ── RETRY PAYMENT NOW — for paused/grace accounts to immediately retry after updating card ──
// Called from the "Update Payment" page after user updates card in Stripe portal
router.post("/retry-now", auth, async (req, res) => {
  try {
    const db = getDb();
    const user = db.prepare("SELECT id, email, account_status, stripe_customer_id, stripe_subscription_id FROM users WHERE id = ?").get(req.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const status = user.account_status;
    if (status !== "paused" && status !== "grace") {
      return res.json({ success: true, alreadyActive: true, message: "Account is already active" });
    }

    if (!requireStripe(res)) return;
    const stripe = getStripe();

    // 1. Find the most recent open/uncollectible invoice for this customer
    let retried = false;
    let invoiceId = null;

    if (user.stripe_customer_id) {
      try {
        const invoices = await stripe.invoices.list({
          customer: user.stripe_customer_id,
          status: "open",
          limit: 5,
        });

        for (const inv of invoices.data) {
          try {
            const paid = await stripe.invoices.pay(inv.id);
            if (paid.status === "paid") {
              retried = true;
              invoiceId = inv.id;
              break;
            }
          } catch(payErr) {
            // Card still declining — surface this to the user
            if (payErr.code === "card_declined" || payErr.type === "StripeCardError") {
              return res.status(402).json({
                error: "Payment failed",
                code: "CARD_DECLINED",
                declineCode: payErr.decline_code || "generic_decline",
                message: "Your card was declined. Please update your payment method and try again.",
                updateUrl: (process.env.FRONTEND_URL || "https://takeova.ai") + "?update_payment=true",
              });
            }
            // Other error — try next invoice
          }
        }

        // If no open invoices, try the subscription's latest invoice
        if (!retried && user.stripe_subscription_id) {
          const sub = await stripe.subscriptions.retrieve(user.stripe_subscription_id, {
            expand: ["latest_invoice"],
          });
          const latestInv = sub.latest_invoice;
          if (latestInv && latestInv.status === "open") {
            try {
              const paid = await stripe.invoices.pay(latestInv.id);
              if (paid.status === "paid") {
                retried = true;
                invoiceId = latestInv.id;
              }
            } catch(payErr) {
              if (payErr.type === "StripeCardError") {
                return res.status(402).json({
                  error: "Payment failed",
                  code: "CARD_DECLINED",
                  declineCode: payErr.decline_code || "generic_decline",
                  message: "Your card was declined. Please update your payment method and try again.",
                  updateUrl: (process.env.FRONTEND_URL || "https://takeova.ai") + "?update_payment=true",
                });
              }
            }
          }
        }
      } catch(stripeErr) {
        console.error("[retry-now] Stripe error:", stripeErr.message);
      }
    }

    if (retried) {
      // Restore account immediately
      const { handlePaymentSuccess } = require("./features");
      await handlePaymentSuccess(db, user.email, invoiceId);

      // Also clear any failed overage charges (re-bill them)
      const failedOverages = db.prepare(
        "SELECT DISTINCT period FROM overage_charges WHERE user_id = ? AND status = 'failed' ORDER BY period DESC LIMIT 3"
      ).all(user.id);

      // Mark failed overages as pending so month-end cron picks them up, or bill now if amount is known
      if (failedOverages.length > 0) {
        const stripeKey = process.env.STRIPE_SECRET_KEY || db.prepare("SELECT value FROM platform_settings WHERE key = 'STRIPE_SECRET_KEY'").get()?.value;
        for (const { period } of failedOverages) {
          try {
            const charges = db.prepare("SELECT * FROM overage_charges WHERE user_id = ? AND period = ? AND status = 'failed'").all(user.id, period);
            const total = charges.reduce((s, c) => s + (c.amount || 0), 0);
            if (total > 0 && stripeKey && user.stripe_customer_id) {
              const stripe2 = require("stripe")(stripeKey);
              const inv = await stripe2.invoices.create({
                customer: user.stripe_customer_id,
                auto_advance: true,
                description: `MINE overages — ${period}`,
                metadata: { mine_user: user.id, type: "overage", period },
              });
              for (const c of charges) {
                await stripe2.invoiceItems.create({
                  customer: user.stripe_customer_id,
                  invoice: inv.id,
                  amount: Math.round((c.amount || 0) * 100),
                  currency: "usd",
                  description: c.description || `Overage — ${c.metric}`,
                });
              }
              const paid2 = await stripe2.invoices.pay(inv.id);
              if (paid2.status === "paid") {
                db.prepare("UPDATE overage_charges SET status = 'billed' WHERE user_id = ? AND period = ? AND status = 'failed'").run(user.id, period);
              }
            }
          } catch(overageErr) {
            // Don't block reactivation if overage rebilling fails — user can settle later
          }
        }
      }

      return res.json({
        success: true,
        reactivated: true,
        message: "Payment successful — your account is fully restored!",
      });
    }

    // No open invoices found but account is paused — reactivate anyway (edge case: payment cleared externally)
    // Only do this if there are genuinely no outstanding invoices
    return res.status(402).json({
      error: "No open invoice found",
      code: "NO_INVOICE",
      message: "We couldn't find an outstanding invoice. Please contact support or try updating your payment method.",
      updateUrl: (process.env.FRONTEND_URL || "https://takeova.ai") + "?update_payment=true",
    });

  } catch(e) {
    console.error("[retry-now] Error:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ── BILLING PORTAL (with payment-method-update flow for paused accounts) ──
// Standard portal for active accounts, directed to payment method update for paused/grace
router.post("/portal", auth, ownerOnly, async (req, res) => {
  try {
    if (!requireStripe(res)) return;
    const db = getDb();
    const user = db.prepare("SELECT stripe_customer_id, account_status FROM users WHERE id = ?").get(req.userId);
    if (!user?.stripe_customer_id) return res.status(400).json({ error: "No billing account found" });

    const isPaused = user.account_status === "paused" || user.account_status === "grace";

    // For paused/grace accounts, direct them straight to payment method update flow
    const sessionParams = {
      customer: user.stripe_customer_id,
      return_url: (process.env.FRONTEND_URL || "https://takeova.ai") + (isPaused ? "?update_payment=true" : ""),
    };

    if (isPaused) {
      // flow_data directs the customer straight to the payment method update screen
      sessionParams.flow_data = {
        type: "payment_method_update",
        after_completion: {
          type: "redirect",
          redirect: { return_url: (process.env.FRONTEND_URL || "https://takeova.ai") + "?payment_updated=true" },
        },
      };
    }

    const session = await getStripe().billingPortal.sessions.create(sessionParams);
    res.json({ url: session.url, isPaused });
  } catch(e) {
    console.error("[portal] Error:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/subscription-status", auth, async (req, res) => {
  try {
    if (!requireStripe(res)) return;
    try {
      const db = getDb();
      const user = db.prepare("SELECT stripe_customer_id, plan FROM users WHERE id = ?").get(req.userId);
      if (!user?.stripe_customer_id) return res.json({ active: false, plan: user?.plan });
      const subs = await getStripe().subscriptions.list({ customer: user.stripe_customer_id, status: "active", limit: 1 });
      if (!subs.data.length) return res.json({ active: false, plan: null });
      const s = subs.data[0];
      res.json({ active: true, plan: s.metadata.mine_plan, periodEnd: s.current_period_end, cancelAt: s.cancel_at_period_end });
    } catch (e) { console.error("[Route] Internal error:", e?.message);
      res.status(500).json({ error: "An internal error occurred" }); }
  } catch(e) {
    console.error("[Payments]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

router.post("/validate-promo", promoLimiter, (req, res) => {
  const code = req.body.promoCode?.toUpperCase().trim();
  const p = PROMOS[code];
  res.json(p ? { valid: true, code, percentOff: p.percent_off, label: p.name } : { valid: false });
});

router.post("/create-overage-payment", auth, async (req, res) => {
  try {
    const { description } = req.body;
    const db = getDb();
    // Read amount from DB — never trust caller-supplied payment amount
    const period = new Date().toISOString().slice(0, 7);
    const row = db.prepare("SELECT SUM(total) as total FROM overage_charges WHERE user_id = ? AND period = ? AND status = 'pending'").get(req.userId, period);
    const amount = row?.total || 0;
    if (amount <= 0) return res.status(400).json({ error: "No pending overages to pay" });

    // Shopify-billed users: post the overage as a Shopify usage charge (lands on
    // their Shopify invoice, no Stripe checkout), then mark the charges billed.
    try {
      const SH = require("./shopify-app");
      if (SH.isShopifyOrigin(db, req.userId)) {
        const r = await SH.recordOverageUsage(db, req.userId, amount, description || ("MINE overage " + period));
        if (!r.ok) return res.status(502).json({ error: "Could not post Shopify usage charge: " + r.reason });
        db.prepare("UPDATE overage_charges SET status = 'billed' WHERE user_id = ? AND period = ? AND status = 'pending'").run(req.userId, period);
        return res.json({ ok: true, shopify: true, billed: amount });
      }
    } catch (e) { console.error("[overage shopify]", e.message); }

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const c = await getStripe().customers.create({ email: user.email, metadata: { mine_user: user.id } });
      customerId = c.id;
      db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(customerId, user.id);
    }
    const session = await getStripe().checkout.sessions.create({
      customer: customerId, mode: "payment",
      line_items: [{ price_data: { currency: "usd", product_data: { name: description || "MINE Overage" }, unit_amount: Math.round(amount * 100) }, quantity: 1 }],
      success_url: `${FRONTEND_URL}?payment=success`,
      cancel_url: `${FRONTEND_URL}?payment=cancelled`,
      // Metadata is REQUIRED for the webhook to match this payment back to the user
      // and mark their pending overage charges as 'billed'. Without these fields,
      // the user pays but their overage rows stay status='pending' forever.
      metadata: {
        type: "overage",
        mine_user: req.userId,
        mine_period: period,
      },
      payment_intent_data: {
        metadata: {
          type: "overage",
          mine_user: req.userId,
          mine_period: period,
        }
      },
    });
    res.json({ url: session.url });
  } catch (e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// ═══════════════════════════════════════════════
// PART 2: STRIPE CONNECT (user's customers pay THEM)
// ═══════════════════════════════════════════════

// Onboard — user connects their Stripe account
router.post("/connect/onboard", auth, ownerOnly, async (req, res) => {
  try {
    if (!requireStripe(res)) return;
    try {
      const db = getDb();
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
      let connectId = user.stripe_connect_id;

      if (!connectId) {
        const account = await getStripe().accounts.create({
          type: "express",
          email: user.email,
          metadata: { mine_user: user.id },
          capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        });
        connectId = account.id;
        db.prepare("UPDATE users SET stripe_connect_id = ? WHERE id = ?").run(connectId, user.id);
      }

      const accountLink = await getStripe().accountLinks.create({
        account: connectId,
        refresh_url: `${FRONTEND_URL}?connect=refresh`,
        return_url: `${FRONTEND_URL}?connect=complete`,
        type: "account_onboarding",
      });

      db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
        .run(req.userId, "connect_onboard_started", JSON.stringify({ connectId }));
      res.json({ url: accountLink.url, connectId });
    } catch (e) { console.error("[Route] Internal error:", e?.message);
      res.status(500).json({ error: "An internal error occurred" }); }
  } catch(e) {
    console.error("[Payments]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// Check Connect status
router.get("/connect/status", auth, async (req, res) => {
  try {
    if (!requireStripe(res)) return;
    try {
      const db = getDb();
      const user = db.prepare("SELECT stripe_connect_id FROM users WHERE id = ?").get(req.userId);
      if (!user?.stripe_connect_id) return res.json({ connected: false });

      const account = await getStripe().accounts.retrieve(user.stripe_connect_id);
      res.json({
        connected: true, connectId: account.id,
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled,
        detailsSubmitted: account.details_submitted,
        country: account.country,
      });
    } catch (e) { console.error("[Route] Internal error:", e?.message);
      res.status(500).json({ error: "An internal error occurred" }); }
  } catch(e) {
    console.error("[Payments]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// Connect dashboard link
router.post("/connect/dashboard", auth, ownerOnly, async (req, res) => {
  try {
    const db = getDb();
    const user = db.prepare("SELECT stripe_connect_id FROM users WHERE id = ?").get(req.userId);
    if (!user?.stripe_connect_id) return res.status(400).json({ error: "No Connect account" });
    const link = await getStripe().accounts.createLoginLink(user.stripe_connect_id);
    res.json({ url: link.url });
  } catch (e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// Checkout for user's customer (product purchase)
router.post("/connect/checkout", checkoutLimiter, async (req, res) => {
  if (req.isImpersonated) return res.status(403).json({ error: "Cannot make billing changes while impersonating a client" });
  try {
    const { siteId, items, customerEmail, successUrl, cancelUrl, couponCode } = req.body;
    const db = getDb();
    const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(siteId);
    if (!site) return res.status(404).json({ error: "Site not found" });
    const user = db.prepare("SELECT stripe_connect_id, plan, origin FROM users WHERE id = ?").get(site.user_id);
    if (!user?.stripe_connect_id) return res.status(400).json({ error: "Store not set up for payments" });

    // Validate each item price against the server-side product catalog — reject client-supplied prices
    // Products not found in the catalog are rejected to prevent $0.01 price manipulation.
    // If your business needs custom/quote-based pricing, create the product in the catalog first.
    const validatedItems = [];
    for (const item of items) {
      const dbProduct = db.prepare("SELECT price FROM products WHERE user_id = ? AND LOWER(name) = LOWER(?) LIMIT 1").get(site.user_id, item.name);
      if (!dbProduct) {
        return res.status(400).json({ error: `Product not found in catalog: ${item.name}. Add it to your store before accepting payments.` });
      }
      // Always use server-side price — never trust client-supplied amount
      validatedItems.push({ ...item, price: dbProduct.price });
    }

    let totalAmount = validatedItems.reduce((sum, item) => sum + Math.round(item.price * 100) * (item.quantity || 1), 0);
    let discountApplied = null;
    let freeShipping = false;

    // ── Validate coupon/reward code ──
    if (couponCode) {
      const code = couponCode.toUpperCase().trim();

      // Check loyalty reward codes (REWARD-XXXXXX)
      if (code.startsWith("REWARD-")) {
        try {
          db.exec("CREATE TABLE IF NOT EXISTS loyalty_redemptions (id TEXT PRIMARY KEY, customer_id TEXT, user_id TEXT, reward_name TEXT, points_spent INTEGER, type TEXT, value REAL, coupon_code TEXT UNIQUE, used INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))");
          const reward = db.prepare("SELECT * FROM loyalty_redemptions WHERE coupon_code = ? AND used = 0").get(code);
          if (reward) {
            if (reward.type === "discount") {
              const discountCents = Math.round((reward.value || 0) * 100);
              totalAmount = Math.max(0, totalAmount - discountCents);
              discountApplied = { type: "fixed", value: reward.value, code, source: "loyalty" };
            } else if (reward.type === "percent_discount") {
              const discountCents = Math.round(totalAmount * (reward.value / 100));
              totalAmount = Math.max(0, totalAmount - discountCents);
              discountApplied = { type: "percent", value: reward.value, code, source: "loyalty", saved: discountCents / 100 };
            } else if (reward.type === "free_shipping") {
              freeShipping = true;
              discountApplied = { type: "free_shipping", code, source: "loyalty" };
            }
            // Coupon will be marked used in checkout.session.completed webhook after payment confirmed
            // (marking here would consume the code even on abandoned checkouts)
          }
        } catch(e) {}
      }

      // Check site-level coupons (WELCOME20, etc.)
      if (!discountApplied) {
        try {
          let siteData = {}; try { siteData = JSON.parse(db.prepare("SELECT site_meta FROM sites WHERE id = ?").get(siteId || site?.id)?.site_meta || "{}"); } catch(e) {}
          const coupons = siteData.coupons || [];
          const coupon = coupons.find(c => c.code === code && c.active && (!c.expiry || new Date(c.expiry) >= new Date()) && (c.used || 0) < (c.maxUses || 999));
          if (coupon) {
            if (coupon.type === "percent") {
              const discountCents = Math.round(totalAmount * (coupon.value / 100));
              totalAmount = Math.max(0, totalAmount - discountCents);
              discountApplied = { type: "percent", value: coupon.value, code, source: "coupon", saved: discountCents / 100 };
            } else if (coupon.type === "fixed") {
              const discountCents = Math.round((coupon.value || 0) * 100);
              totalAmount = Math.max(0, totalAmount - discountCents);
              discountApplied = { type: "fixed", value: coupon.value, code, source: "coupon" };
            }
            // Coupon usage is tracked in checkout.session.completed webhook (after confirmed payment)
            // — coupon_code is stored in session metadata for deferred increment
          }
        } catch(e) {}
      }
    }

    const platformFee = Math.round(totalAmount * (getFeeForPlan(user.plan, user.origin) / 100));

    // Check if any items need shipping (physical products)
    const hasPhysical = items.some(item => item.type !== "digital" && item.type !== "service" && item.type !== "course");

    // Build line_items. CRITICAL: if a discount was applied above we reduced
    // totalAmount but the raw line items still show full price. Without scaling,
    // Stripe would charge the customer the full amount and the coupon would be
    // silently ignored. We distribute the discount proportionally across items.
    const originalTotal = validatedItems.reduce(
      (s, it) => s + Math.round(it.price * 100) * (it.quantity || 1), 0
    );

    let lineItems;
    if (discountApplied && totalAmount < originalTotal && originalTotal > 0) {
      const ratio = totalAmount / originalTotal;
      // Scale each item, tracking rounding drift so we distribute the exact discount
      const scaled = validatedItems.map(it => ({
        it,
        scaledUnit: Math.round(Math.round(it.price * 100) * ratio),
        qty: it.quantity || 1,
      }));
      // Compute sum-of-scaled-items and fix any ±few-cent drift on the last item
      const scaledSum = scaled.reduce((s, r) => s + r.scaledUnit * r.qty, 0);
      const drift = totalAmount - scaledSum;
      if (drift !== 0 && scaled.length > 0) {
        const last = scaled[scaled.length - 1];
        // Spread drift across units of the last line (avoids negative unit_amount)
        last.scaledUnit = Math.max(1, last.scaledUnit + Math.round(drift / last.qty));
      }
      lineItems = scaled.map(r => ({
        price_data: {
          currency: getCurrency(db, siteId),
          product_data: {
            name: r.it.name,
            description: r.it.description ? `${r.it.description} (discount: ${discountApplied.code})` : `Discount applied: ${discountApplied.code}`,
          },
          unit_amount: r.scaledUnit,
        },
        quantity: r.qty,
      }));
    } else {
      lineItems = validatedItems.map(item => ({
        price_data: {
          currency: getCurrency(db, siteId),
          product_data: { name: item.name, description: item.description || undefined },
          unit_amount: Math.round(item.price * 100),
        },
        quantity: item.quantity || 1,
      }));
    }

    const sessionParams = {
      mode: "payment",
      customer_email: customerEmail || undefined,
      line_items: lineItems,
      payment_intent_data: {
        application_fee_amount: platformFee,
        transfer_data: { destination: user.stripe_connect_id },
      },
      success_url: successUrl || `${FRONTEND_URL}/order-complete?session={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `${FRONTEND_URL}/cart`,
      metadata: {
        mine_site: siteId,
        mine_user: site.user_id,
        platform_fee: platformFee,
        coupon_code: (couponCode || "").toUpperCase().trim(),
        discount_source: discountApplied?.source || "",
        discount_amount_cents: discountApplied ? (originalTotal - totalAmount) : 0,
        items_json: JSON.stringify(items.map(i => ({ name: i.name, price: i.price, quantity: i.quantity || 1, type: i.type || "physical" }))),
      },
    };

    // Collect shipping address for physical products
    if (hasPhysical) {
      sessionParams.shipping_address_collection = {
        allowed_countries: ["US","CA","GB","AU","NZ","IE","DE","FR","ES","IT","NL","BE","AT","CH","SE","NO","DK","FI","PT","SG","JP","KR","MX","BR","IN","ZA"],
      };
    }

    const session = await getStripe().checkout.sessions.create(sessionParams);

    // Coupon usage increment intentionally deferred to checkout.session.completed webhook
    // to prevent coupon exhaustion on abandoned checkouts. The coupon_code is stored
    // in session metadata and consumed only after confirmed payment.

    // Track abandoned cart (if they don't complete checkout)
    if (customerEmail) {
      try {
        const { v4: cartUuid } = require("uuid");
        db.exec("CREATE TABLE IF NOT EXISTS abandoned_carts (id TEXT PRIMARY KEY, site_id TEXT, customer_email TEXT, customer_name TEXT, items TEXT, cart_total REAL, cart_url TEXT, session_id TEXT, recovery_email_sent INTEGER DEFAULT 0, recovered INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))");
// Change 9: schema-drift ALTERs for abandoned_carts
try { db.exec("ALTER TABLE abandoned_carts ADD COLUMN notified INTEGER DEFAULT 0"); } catch(_){}
try { db.exec("ALTER TABLE abandoned_carts ADD COLUMN notified_at TEXT"); } catch(_){}
        db.prepare("INSERT INTO abandoned_carts (id, site_id, customer_email, items, cart_total, session_id) VALUES (?,?,?,?,?,?)")
          .run(cartUuid(), siteId, customerEmail, JSON.stringify(items), totalAmount / 100, session.id);
        // Auto-enroll in "Cart abandoned" funnels
        try { const { autoEnrollInFunnels } = require("./email"); autoEnrollInFunnels(db, site.user_id, "Cart abandoned", customerEmail, ""); } catch(e) {}
      } catch(e) {}
    }

    // NOTE: Loyalty points are awarded in the checkout.session.completed webhook (server.js)
    // after confirmed payment — NOT here at session creation, to prevent point farming on abandoned checkouts.
    res.json({ url: session.url, sessionId: session.id });
  } catch (e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// Validate coupon code on published site (before checkout)
router.post("/connect/validate-coupon", (req, res) => {
  const { siteId, code, subtotal } = req.body;
  const db = getDb();
  const upperCode = (code || "").toUpperCase().trim();
  if (!upperCode) return res.json({ valid: false, error: "No code entered" });

  // Check loyalty reward codes
  if (upperCode.startsWith("REWARD-")) {
    try {
      db.exec("CREATE TABLE IF NOT EXISTS loyalty_redemptions (id TEXT PRIMARY KEY, customer_id TEXT, user_id TEXT, reward_name TEXT, points_spent INTEGER, type TEXT, value REAL, coupon_code TEXT UNIQUE, used INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))");
      const reward = db.prepare("SELECT * FROM loyalty_redemptions WHERE coupon_code = ? AND used = 0").get(upperCode);
      if (reward) {
        let discount = 0; let label = "";
        if (reward.type === "discount") { discount = reward.value; label = `$${reward.value} off (Loyalty Reward)`; }
        else if (reward.type === "percent_discount") { discount = (subtotal || 0) * (reward.value / 100); label = `${reward.value}% off (Loyalty Reward)`; }
        else if (reward.type === "free_shipping") { label = "Free Shipping (Loyalty Reward)"; }
        return res.json({ valid: true, code: upperCode, type: reward.type, value: reward.value, discount, label, source: "loyalty" });
      }
    } catch(e) {}
  }

  // Check site coupons
  try {
    const site = db.prepare("SELECT data FROM sites WHERE id = ?").get(siteId);
    if (site) {
      let siteData = {}; try { siteData = JSON.parse(db.prepare("SELECT site_meta FROM sites WHERE id = ?").get(siteId || site?.id)?.site_meta || "{}"); } catch(e) {}
      const coupon = (siteData.coupons || []).find(c => c.code === upperCode && c.active && (!c.expiry || new Date(c.expiry) >= new Date()) && (c.used || 0) < (c.maxUses || 999));
      if (coupon) {
        if (coupon.minOrder && (subtotal || 0) < coupon.minOrder) return res.json({ valid: false, error: `Minimum order $${coupon.minOrder} required` });
        let discount = 0; let label = "";
        if (coupon.type === "percent") { discount = (subtotal || 0) * (coupon.value / 100); label = `${coupon.value}% off`; }
        else if (coupon.type === "fixed") { discount = coupon.value; label = `$${coupon.value} off`; }
        return res.json({ valid: true, code: upperCode, type: coupon.type, value: coupon.value, discount, label, source: "coupon" });
      }
    }
  } catch(e) { console.error("[/connect/validate-coupon]", e.message || e); }

  res.json({ valid: false, error: "Invalid or expired code" });
});

// Subscription for user's customer (membership/course)
router.post("/connect/subscription", async (req, res) => {
  if (req.isImpersonated) return res.status(403).json({ error: "Cannot change subscription while impersonating a client" });
  try {
    const { siteId, customerEmail, planName, amount, interval } = req.body;
    const db = getDb();
    const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(siteId);
    if (!site) return res.status(404).json({ error: "Site not found" });
    const user = db.prepare("SELECT stripe_connect_id, plan, origin FROM users WHERE id = ?").get(site.user_id);
    if (!user?.stripe_connect_id) return res.status(400).json({ error: "Store not set up for payments" });

    // Validate subscription price against server-side membership catalog — reject if plan not found
    // to prevent price manipulation via client-supplied amount
    const dbPlan = db.prepare("SELECT price, interval FROM membership_tiers WHERE user_id = ? AND LOWER(name) = LOWER(?) LIMIT 1").get(site.user_id, planName || "") || db.prepare("SELECT price FROM memberships WHERE user_id = ? AND LOWER(name) = LOWER(?) LIMIT 1").get(site.user_id, planName || "");
    if (!dbPlan) return res.status(400).json({ error: "Plan not found" });
    // Always use server-side price — never trust client-supplied amount
    const unitAmount = Math.round(dbPlan.price * 100);
    // Billing interval is server-authoritative when the tier defines it ('monthly'/'yearly' -> Stripe 'month'/'year')
    const billingInterval = String(dbPlan.interval || interval || "month").toLowerCase().indexOf("year") === 0 ? "year" : "month";

    const session = await getStripe().checkout.sessions.create({
      mode: "subscription",
      customer_email: customerEmail || undefined,
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: planName || "Membership" },
          unit_amount: unitAmount,
          recurring: { interval: billingInterval },
        },
        quantity: 1,
      }],
      subscription_data: {
        application_fee_percent: getFeeForPlan(user.plan, user.origin),
        transfer_data: { destination: user.stripe_connect_id },
      },
      success_url: `${FRONTEND_URL}/subscription-complete?session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/pricing`,
      metadata: { mine_site: siteId, mine_user: site.user_id },
    });
    res.json({ url: session.url, sessionId: session.id });
  } catch (e) { console.error("[Route] Internal error:", e?.message);
    res.status(500).json({ error: "An internal error occurred" }); }
});

// Invoice payment via Connect
router.post("/connect/invoice-link", auth, async (req, res) => {
  try {
    if (!requireStripe(res)) return;
    try {
      const { invoiceId, clientEmail, description } = req.body;
      const db = getDb();
      const user = db.prepare("SELECT stripe_connect_id, plan, origin FROM users WHERE id = ?").get(req.userId);
      if (!user?.stripe_connect_id) return res.status(400).json({ error: "Connect Stripe first" });

      // Always read amount from DB — never trust caller-supplied payment amount
      const invoice = db.prepare("SELECT total, client_email FROM invoices WHERE id = ? AND user_id = ?").get(invoiceId, req.userId);
      if (!invoice) return res.status(404).json({ error: "Invoice not found" });
      if (!invoice.total || invoice.total <= 0) return res.status(400).json({ error: "Invoice has no amount" });

      const safeClientEmail = String(clientEmail || invoice.client_email || "").replace(/[\r\n]/g, "").trim();
      const totalAmount = Math.round(invoice.total * 100);
      const platformFee = Math.round(totalAmount * (getFeeForPlan(user.plan, user.origin) / 100));

      const session = await getStripe().checkout.sessions.create({
        mode: "payment", customer_email: safeClientEmail || undefined,
        line_items: [{ price_data: { currency: "usd", product_data: { name: description || "Invoice Payment" }, unit_amount: totalAmount }, quantity: 1 }],
        payment_intent_data: { application_fee_amount: platformFee, transfer_data: { destination: user.stripe_connect_id } },
        success_url: `${FRONTEND_URL}?invoice_paid=${invoiceId}`,
        cancel_url: `${FRONTEND_URL}?invoice_cancelled=${invoiceId}`,
        metadata: { mine_invoice: invoiceId, mine_user: req.userId },
      });
      db.prepare("UPDATE invoices SET stripe_payment_link = ? WHERE id = ?").run(session.url, invoiceId);
      res.json({ url: session.url });
    } catch (e) { console.error("[Route] Internal error:", e?.message);
      res.status(500).json({ error: "An internal error occurred" }); }
  } catch(e) {
    console.error("[Payments]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ─── GET /api/payments/invoice/:id/qr — payment QR code for an invoice ────
// Returns a PNG QR code that encodes the invoice's Stripe Checkout URL.
// Customer scans → opens Stripe Checkout → Apple Pay button shows automatically.
router.get("/invoice/:id/qr", auth, async (req, res) => {
  try {
    const db = getDb();
    const inv = db.prepare("SELECT stripe_payment_link, total, client_name FROM invoices WHERE id = ? AND user_id = ?")
                   .get(req.params.id, req.userId);
    if (!inv) return res.status(404).json({ error: "Invoice not found" });
    if (!inv.stripe_payment_link) {
      return res.status(400).json({ error: "Generate a payment link first (Get Pay Link button)" });
    }

    const QRCode = require("qrcode");
    const qrDataUrl = await QRCode.toDataURL(inv.stripe_payment_link, {
      width: 512,
      margin: 1,
      color: { dark: "#0F172A", light: "#FFFFFF" },
      errorCorrectionLevel: "M",
    });

    res.json({
      url: inv.stripe_payment_link,
      qrDataUrl,
      total: inv.total,
      clientName: inv.client_name,
    });
  } catch (e) {
    console.error("[payments] qr generation failed:", e.message);
    res.status(500).json({ error: "QR generation failed" });
  }
});

// Connect balance
router.get("/connect/balance", auth, ownerOnly, async (req, res) => {
  try {
    if (!requireStripe(res)) return;
    try {
      const db = getDb();
      const user = db.prepare("SELECT stripe_connect_id FROM users WHERE id = ?").get(req.userId);
      if (!user?.stripe_connect_id) return res.json({ connected: false });

      const balance = await getStripe().balance.retrieve({ stripeAccount: user.stripe_connect_id });
      const payouts = await getStripe().payouts.list({ limit: 10 }, { stripeAccount: user.stripe_connect_id });

      res.json({
        connected: true,
        available: balance.available.reduce((sum, b) => sum + b.amount, 0) / 100,
        pending: balance.pending.reduce((sum, b) => sum + b.amount, 0) / 100,
        currency: balance.available[0]?.currency || "usd",
        recentPayouts: payouts.data.map(p => ({ amount: p.amount / 100, status: p.status, arrival: p.arrival_date })),
      });
    } catch (e) { console.error("[Route] Internal error:", e?.message);
      res.status(500).json({ error: "An internal error occurred" }); }
  } catch(e) {
    console.error("[Payments]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// ═══════════════════════════════════════════════
// PART 3: WEBHOOKS
// ═══════════════════════════════════════════════


// ── Standalone addon checkout (for users who already have a plan) ─────────────
router.post("/addon-checkout", auth, ownerOnly, checkoutLimiter, async (req, res) => {
  try {
    if (!requireStripe(res)) return;
    const { addonId } = req.body;
    if (!addonId || !AI_ADDONS[addonId]) return res.status(400).json({ error: "Invalid addon" });

    const db = getDb();
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    // Check if already active
    ensureAddonTable(db);
    const existing = db.prepare("SELECT status FROM user_addons WHERE user_id = ? AND addon_id = ?").get(req.userId, addonId);
    if (existing?.status === "active") return res.status(400).json({ error: "This addon is already active on your account" });

    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await getStripe().customers.create({ email: user.email, metadata: { mine_user: user.id } });
      customerId = customer.id;
      db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(customerId, user.id);
    }

    const addonPriceId = await ensurePrice(addonId, "ai", "month");
    if (!addonPriceId) return res.status(500).json({ error: "Could not create Stripe price" });

    let sessionParams;

    // If user has an existing subscription, add as a new subscription item
    if (user.stripe_subscription_id) {
      // Add the add-on as a line item on the existing subscription and charge the
      // card on file (prorated) — NO Checkout redirect.
      const item = await getStripe().subscriptionItems.create({
        subscription: user.stripe_subscription_id,
        price: addonPriceId,
        quantity: 1,
        proration_behavior: "create_prorations",
      });
      db.prepare(`INSERT INTO user_addons (id, user_id, addon_id, stripe_subscription_id, stripe_item_id, status, activated_at, cancelled_at)
                  VALUES (?, ?, ?, ?, ?, 'active', datetime('now'), NULL)
                  ON CONFLICT(user_id, addon_id) DO UPDATE SET status='active', stripe_subscription_id=excluded.stripe_subscription_id, stripe_item_id=excluded.stripe_item_id, activated_at=datetime('now'), cancelled_at=NULL`)
        .run(crypto.randomUUID(), user.id, addonId, user.stripe_subscription_id, item.id);
      if (addonId === "mine_control") { try { db.prepare("UPDATE mine_control_config SET enabled = 1, updated_at = datetime('now') WHERE user_id = ?").run(user.id); } catch(e) {} }
      else if (addonId === "growth_agent") { try { db.prepare("UPDATE growth_agent_config SET enabled = 1, updated_at = datetime('now') WHERE user_id = ?").run(user.id); } catch(e) {} }
      else { try { db.prepare("UPDATE ai_employees SET enabled = 1, updated_at = datetime('now') WHERE user_id = ? AND role = ?").run(user.id, addonId); } catch(e) {} }
      try { db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)").run(user.id, "addon_activated", JSON.stringify({ addonId, stripe_item_id: item.id, via: "subscription_item" })); } catch(e) {}
      return res.json({ success: true, added: true, addon: addonId });
    } else {
      // No plan yet — charge standalone
      sessionParams = {
        customer: customerId,
        mode: "subscription",
        line_items: [{ price: addonPriceId, quantity: 1 }],
        success_url: `${FRONTEND_URL}?addon_activated=${addonId}`,
        cancel_url: `${FRONTEND_URL}?addon_cancelled=true`,
        metadata: { mine_user: user.id, mine_addon: addonId },
        subscription_data: { metadata: { mine_user: user.id, mine_addon: addonId } },
      };
    }

    const session = await getStripe().checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch(e) {
    console.error("[addon-checkout]", e.message);
    res.status(500).json({ error: "Checkout failed" });
  }
});


// ── Cancel a specific addon ────────────────────────────────────────────────────
router.post("/cancel-addon", auth, ownerOnly, async (req, res) => {
  try {
    if (!requireStripe(res)) return;
    const { addonId } = req.body;
    if (!addonId) return res.status(400).json({ error: "addonId required" });

    const db = getDb();
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
    if (!user?.stripe_subscription_id) return res.status(400).json({ error: "No active subscription found" });

    ensureAddonTable(db);

    // Find the Stripe subscription item for this addon
    const addonRow = db.prepare("SELECT * FROM user_addons WHERE user_id = ? AND addon_id = ? AND status = 'active'").get(req.userId, addonId);

    let itemDeleted = false;
    if (addonRow?.stripe_item_id) {
      try {
        await getStripe().subscriptionItems.del(addonRow.stripe_item_id, { proration_behavior: "create_prorations" });
        itemDeleted = true;
      } catch(e) {
        console.error("[cancel-addon] Stripe item delete failed:", e.message);
      }
    }

    if (!itemDeleted) {
      // Fallback: find item by price matching
      try {
        const sub = await getStripe().subscriptions.retrieve(user.stripe_subscription_id, { expand: ["items.data.price"] });
        const addonPriceId = await ensurePrice(addonId, "ai", "month");
        const matchingItem = sub.items.data.find(item => item.price.id === addonPriceId);
        if (matchingItem) {
          await getStripe().subscriptionItems.del(matchingItem.id, { proration_behavior: "create_prorations" });
          itemDeleted = true;
        }
      } catch(e) {
        console.error("[cancel-addon] Fallback Stripe cancel failed:", e.message);
      }
    }

    // Deactivate locally regardless (graceful degradation)
    db.prepare("UPDATE user_addons SET status = 'cancelled', cancelled_at = datetime('now') WHERE user_id = ? AND addon_id = ?").run(req.userId, addonId);

    // Deactivate in the addon-specific table
    if (addonId === "mine_control") {
      db.prepare("UPDATE mine_control_config SET enabled = 0 WHERE user_id = ?").run(req.userId);
    } else if (addonId === "growth_agent") {
      try { db.prepare("UPDATE growth_agent_config SET enabled = 0 WHERE user_id = ?").run(req.userId); } catch(e) { console.error("[/cancel-addon]", e.message || e); }
    } else {
      // AI employee
      db.prepare("UPDATE ai_employees SET enabled = 0, updated_at = datetime('now') WHERE user_id = ? AND role = ?").run(req.userId, addonId);
    }

    db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)").run(req.userId, "addon_cancelled", JSON.stringify({ addonId, stripeItemDeleted: itemDeleted }));

    res.json({ success: true, message: `${AI_ADDONS[addonId]?.name || addonId} cancelled. Access continues until end of current billing period.` });
  } catch(e) {
    console.error("[cancel-addon]", e.message);
    res.status(500).json({ error: "Cancellation failed" });
  }
});

// ── Get active addons for current user ────────────────────────────────────────
router.get("/active-addons", auth, (req, res) => {
  const db = getDb();
  ensureAddonTable(db);
  const addons = db.prepare("SELECT addon_id, status, activated_at, cancelled_at FROM user_addons WHERE user_id = ?").all(req.userId);
  // Also check ai_employees table for employees
  const employees = db.prepare("SELECT role, enabled FROM ai_employees WHERE user_id = ?").all(req.userId);
  const mcConfig = (() => { try { return db.prepare("SELECT enabled FROM mine_control_config WHERE user_id = ?").get(req.userId); } catch(e) { return null; } })();
  const gaConfig = (() => { try { return db.prepare("SELECT enabled FROM growth_agent_config WHERE user_id = ?").get(req.userId); } catch(e) { return null; } })();
  res.json({
    addons,
    employees: employees.reduce((acc, e) => { acc[e.role] = e.enabled === 1; return acc; }, {}),
    mine_control: !!mcConfig?.enabled,
    growth_agent: !!gaConfig?.enabled,
  });
});

// Revoke paid access — shared by cancellation, full-refund, and chargeback handlers.
function revokeUserAccess(db, uid, reason) {
  if (!uid) return;
  try {
    db.prepare("UPDATE users SET plan = NULL, subscription_status = 'canceled' WHERE id = ?").run(uid);
    const u = db.prepare("SELECT role FROM users WHERE id = ?").get(uid);
    if (u && u.role === 'agency') {
      db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(uid);
      db.prepare("UPDATE agencies SET status = 'inactive', updated_at = datetime('now') WHERE user_id = ?").run(uid);
    }
    db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)").run(uid, "access_revoked", JSON.stringify({ reason }));
  } catch(_) { /* tables may not exist yet */ }
}

router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const sig = req.headers["stripe-signature"];
    let event;
    try { event = getStripe().webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET); }
    catch (err) { return res.status(400).send(`Webhook Error: ${err.message}`); }

    const db = getDb();

    // Idempotency: skip already-processed events. We check BEFORE the switch
    // so retries short-circuit. We INSERT AFTER the switch completes
    // successfully — so if the business logic throws, the event can be
    // re-processed on Stripe's next retry.
    try {
      db.exec("CREATE TABLE IF NOT EXISTS processed_stripe_events (event_id TEXT PRIMARY KEY, created_at TEXT DEFAULT (datetime('now')))");
      const already = db.prepare("SELECT event_id FROM processed_stripe_events WHERE event_id=?").get(event.id);
      if (already) { return res.json({ received: true }); }
    } catch(e) { /* non-fatal — continue processing */ }

  switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object;
        const userId = s.metadata?.mine_user;
        const planId = s.metadata?.mine_plan;

        // ── Design Studio credit purchase ──
        if (s.metadata?.mine_design_pack) {
          try {
            const { handleDesignPurchaseWebhook } = require("./design");
            handleDesignPurchaseWebhook(s);
          } catch (e) { console.error("[WEBHOOK] Design credit fulfillment failed:", e.message); }
          break;
        }

        // ── Voice Pack purchase ──
        // Standalone voice-minutes top-up (not the addon bundle). Credits the
        // user's voice_packs row so the AI Receptionist has minutes available.
        if (s.metadata?.type === "voice_pack" && userId) {
          try {
            const mins = parseInt(s.metadata.mins || "0") || 0;
            if (mins > 0) {
              const { v4: vUuid } = require("uuid");
              db.exec(`CREATE TABLE IF NOT EXISTS voice_packs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, mins_total INTEGER NOT NULL DEFAULT 100, mins_used INTEGER NOT NULL DEFAULT 0, purchased_at TEXT DEFAULT (datetime('now')), stripe_payment_id TEXT, expires_at TEXT)`);
              // Idempotent: keyed by session ID so replays don't double-credit
              const alreadyCredited = db.prepare("SELECT id FROM voice_packs WHERE stripe_payment_id = ?").get(s.id);
              if (!alreadyCredited) {
                db.prepare("INSERT INTO voice_packs (id, user_id, mins_total, mins_used, stripe_payment_id) VALUES (?,?,?,0,?)")
                  .run(vUuid(), userId, mins, s.id);
                db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
                  .run(userId, "voice_pack_purchased", JSON.stringify({ sessionId: s.id, mins, amount: (s.amount_total || 0) / 100 }));
              }
            }
          } catch (e) { console.error("[WEBHOOK] Voice pack fulfillment failed:", e.message); }
          break;
        }

        // ── Overage payment ──
        // User paid off their pending usage overages via the hosted checkout
        // from /create-overage-payment. Mark all pending charges in that period as billed.
        if (s.metadata?.type === "overage" && userId) {
          try {
            const period = s.metadata.mine_period;
            const updated = db.prepare("UPDATE overage_charges SET status = 'billed', billed = 1, billed_at = datetime('now') WHERE user_id = ? AND period = ? AND status = 'pending'")
              .run(userId, period);
            db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
              .run(userId, "overage_paid_checkout", JSON.stringify({ sessionId: s.id, period, amount: (s.amount_total || 0) / 100, rowsUpdated: updated.changes }));
          } catch (e) { console.error("[WEBHOOK] Overage fulfillment failed:", e.message); }
          break;
        }

        // ── Booking deposit payment ──
        // Customer paid a deposit on a booking. Mark the booking as deposit_paid
        // so the business owner sees it in their dashboard.
        if (s.metadata?.booking_id) {
          try {
            const bookingId = s.metadata.booking_id;
            // Add columns if they don't exist (old schemas)
            try { db.exec("ALTER TABLE bookings ADD COLUMN deposit_paid INTEGER DEFAULT 0"); } catch(e) {}
            try { db.exec("ALTER TABLE bookings ADD COLUMN deposit_paid_at TEXT"); } catch(e) {}
            try { db.exec("ALTER TABLE bookings ADD COLUMN deposit_amount_cents INTEGER"); } catch(e) {}
            db.prepare("UPDATE bookings SET deposit_paid = 1, deposit_paid_at = datetime('now'), deposit_amount_cents = ? WHERE id = ?")
              .run(s.amount_total || 0, bookingId);
            // Notify the site owner
            const ownerUid = s.metadata.user_id || s.metadata.mine_user;
            if (ownerUid) {
              db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
                .run(ownerUid, "booking_deposit_paid", JSON.stringify({ bookingId, amount: (s.amount_total || 0) / 100, sessionId: s.id }));
              try {
                const { notifyOwner } = require("./features");
                notifyOwner(ownerUid, "💰", `Deposit received: $${((s.amount_total || 0) / 100).toFixed(2)} for booking`);
              } catch(e) {}
            }
          } catch (e) { console.error("[WEBHOOK] Booking deposit fulfillment failed:", e.message); }
          break;
        }

        if (userId && planId && !s.metadata?.mine_site) {
          db.prepare("UPDATE users SET plan = ?, stripe_customer_id = ? WHERE id = ?").run(planId, s.customer, userId);
          db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)").run(userId, "subscription_started", JSON.stringify({ plan: planId, amount: s.amount_total }));

          // Credit affiliate if ref_code present
          const refCode = s.metadata?.ref_code;
          if (refCode) {
            try {
              const fetch = (await import("node-fetch")).default;
              fetch((process.env.BACKEND_URL || "http://localhost:4000") + "/api/affiliates/conversion", {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-internal-key": process.env.INTERNAL_API_KEY },
                body: JSON.stringify({ ref_code: refCode, user_id: userId, plan: planId, amount: (s.amount_total || 0) / 100 })
              }).catch(() => {});
            } catch (e) {}
          }

          // Activate AI addons if included
          const addons = s.metadata?.ai_addons;
          if (addons) {
            const addonList = addons.split(",").filter(Boolean);
            for (const addon of addonList) {
              if (addon === "bundle") {
                // Activate all 6
                for (const empId of ["sales","support","social","bookkeeper","marketing","voice"]) {
                  // INSERT OR IGNORE — preserves existing employee config (rules, schedule, tone, etc.)
                  // INSERT OR REPLACE would DELETE+INSERT on conflict, wiping all user configuration
                  db.prepare("INSERT OR IGNORE INTO ai_employees (id, user_id, role, enabled, rules, schedule, autonomy, tone, created_at, updated_at) VALUES (?,?,?,1,'[]','{}','semi','professional',datetime('now'),datetime('now'))").run(require("uuid").v4(), userId, empId);
                  db.prepare("UPDATE ai_employees SET enabled=1, updated_at=datetime('now') WHERE user_id=? AND role=?").run(userId, empId);
                }
              } else {
                db.prepare("INSERT OR IGNORE INTO ai_employees (id, user_id, role, enabled, rules, schedule, autonomy, tone, created_at, updated_at) VALUES (?,?,?,1,'[]','{}','semi','professional',datetime('now'),datetime('now'))").run(require("uuid").v4(), userId, addon);
                db.prepare("UPDATE ai_employees SET enabled=1, updated_at=datetime('now') WHERE user_id=? AND role=?").run(userId, addon);
              }
            }
            db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)").run(userId, "ai_addons_activated", addons);

            // If voice addon was activated, credit 100 included minutes into voice_packs for this billing period
            if (addonList.includes("voice") || addonList.includes("bundle")) {
              try {
                const { v4: _uuid } = require("uuid");
                const period = new Date().toISOString().slice(0, 7); // YYYY-MM
                const periodEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString().split("T")[0];
                // Ensure table exists
                db.exec(`CREATE TABLE IF NOT EXISTS voice_packs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, mins_total INTEGER NOT NULL DEFAULT 100, mins_used INTEGER NOT NULL DEFAULT 0, purchased_at TEXT DEFAULT (datetime('now')), stripe_payment_id TEXT, expires_at TEXT)`);
                // Check if already credited this period to avoid double-crediting on webhook retries
                const alreadyCredited = db.prepare("SELECT id FROM voice_packs WHERE user_id = ? AND stripe_payment_id = ?").get(userId, "addon-" + period);
                if (!alreadyCredited) {
                  db.prepare("INSERT INTO voice_packs (id, user_id, mins_total, mins_used, stripe_payment_id, expires_at) VALUES (?,?,100,0,?,?)")
                    .run(_uuid(), userId, "addon-" + period, periodEnd);
                }
              } catch(e) { /* non-fatal — usage will still be tracked, overage rates apply */ }
            }

            // Activate Take Control if purchased
            if (addonList.includes("mine_control")) {
              try {
                const db2 = require("../db/init").getDb();
                db2.exec(`CREATE TABLE IF NOT EXISTS mine_control_config (id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, whatsapp_number TEXT, enabled INTEGER DEFAULT 1, messages_used INTEGER DEFAULT 0, messages_period TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`);
                const existing = db2.prepare("SELECT id FROM mine_control_config WHERE user_id = ?").get(userId);
                if (existing) {
                  db2.prepare("UPDATE mine_control_config SET enabled = 1, updated_at = datetime('now') WHERE user_id = ?").run(userId);
                } else {
                  db2.prepare("INSERT INTO mine_control_config (id, user_id, enabled) VALUES (?,?,1)").run(require("uuid").v4(), userId);
                }
              } catch(e) { console.error("[Take Control] Activation error:", e.message); }
            }

            // Activate Growth Agent if purchased
            if (addonList.includes("growth_agent")) {
              try {
                const { ensureTables: gaEnsure } = require("./growth-agent");
                const db2 = require("../db/init").getDb();
                gaEnsure(db2);
                const existing = db2.prepare("SELECT user_id FROM growth_agent_config WHERE user_id = ?").get(userId);
                if (existing) {
                  db2.prepare("UPDATE growth_agent_config SET enabled = 1, updated_at = datetime('now') WHERE user_id = ?").run(userId);
                } else {
                  db2.prepare("INSERT INTO growth_agent_config (user_id, enabled) VALUES (?,1)").run(userId);
                }
              } catch(e) { console.error("[GrowthAgent] Activation error:", e.message); }
            }
          }
        }
        if (s.metadata?.mine_site) {
          db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)").run(
            s.metadata.mine_user, "connect_sale", JSON.stringify({ siteId: s.metadata.mine_site, total: (s.amount_total || 0) / 100, fee: parseInt(s.metadata.platform_fee || "0") / 100 }));

          // Increment site coupon usage after confirmed payment (deferred from session creation)
          const confirmedCouponCode = (s.metadata?.coupon_code || "").toUpperCase().trim();
          if (confirmedCouponCode && !confirmedCouponCode.startsWith("REWARD-")) {
            try {
              const siteRec = db.prepare("SELECT site_meta FROM sites WHERE id = ?").get(s.metadata.mine_site);
              if (siteRec?.site_meta) {
                const siteData = JSON.parse(siteRec.site_meta);
                const updatedCoupons = (siteData.coupons || []).map(c =>
                  c.code === confirmedCouponCode ? { ...c, used: (c.used || 0) + 1 } : c
                );
                siteData.coupons = updatedCoupons;
                db.prepare("UPDATE sites SET site_meta = ? WHERE id = ?").run(JSON.stringify(siteData), s.metadata.mine_site);
              }
            } catch(e) { console.error("[/webhook]", e.message || e); }
          }
          // Mark loyalty reward coupon as used after confirmed payment
          if (confirmedCouponCode.startsWith("REWARD-")) {
            try {
              db.prepare("UPDATE loyalty_redemptions SET used = 1 WHERE coupon_code = ?").run(confirmedCouponCode);
            } catch(e) { console.error("[/webhook]", e.message || e); }
          }

          // Fire purchase automation
          fireAutomation(s.metadata.mine_user, "purchase_completed", {
            email: s.customer_details?.email || s.customer_email || "",
            name: s.customer_details?.name || "",
            amount: (s.amount_total || 0) / 100,
            siteId: s.metadata.mine_site
          });
        }
        break;
      }
      case "invoice.paid": {
        const inv = event.data.object;
        // ── Overage invoice paid (async confirmation from Stripe) ──
        if (inv.metadata?.type === "overage" && inv.metadata?.mine_user) {
          const uid = inv.metadata.mine_user;
          const period = inv.metadata.mine_period;
          db.prepare("UPDATE overage_charges SET status = 'billed' WHERE user_id = ? AND period = ? AND status = 'pending'").run(uid, period);
          db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)").run(uid, "overage_paid_webhook", JSON.stringify({ invoiceId: inv.id, amount: inv.amount_paid, period }));
          break;
        }
        // ── Subscription invoice paid ──
        if (inv.subscription) {
          const sub = await getStripe().subscriptions.retrieve(inv.subscription);
          if (sub?.metadata?.mine_user) {
            db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)").run(sub.metadata.mine_user, "subscription_renewed", JSON.stringify({ amount: inv.amount_paid }));
            // Fire webhooks for invoice paid
            try { const { fireWebhooks } = require("./marketplace"); fireWebhooks(sub.metadata.mine_user, "invoice.paid", { amount: (inv.amount_paid || 0) / 100, invoiceId: inv.id }); } catch(e){}

            // Credit 100 fresh voice minutes if user has the AI Receptionist addon active
            if (inv.billing_reason === "subscription_cycle") {
              try {
                const userId = sub.metadata.mine_user;
                const hasVoiceAddon = db.prepare("SELECT id FROM ai_employees WHERE user_id = ? AND role = 'voice' AND enabled = 1").get(userId);
                if (hasVoiceAddon) {
                  const period = new Date().toISOString().slice(0, 7); // YYYY-MM
                  const periodEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString().split("T")[0];
                  // Idempotency key: addon- + period — safe to retry, won't double-credit
                  const alreadyCredited = db.prepare("SELECT id FROM voice_packs WHERE user_id = ? AND stripe_payment_id = ?").get(userId, "addon-" + period);
                  if (!alreadyCredited) {
                    db.exec("CREATE TABLE IF NOT EXISTS voice_packs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, mins_total INTEGER NOT NULL DEFAULT 100, mins_used INTEGER NOT NULL DEFAULT 0, purchased_at TEXT DEFAULT (datetime('now')), stripe_payment_id TEXT, expires_at TEXT)");
                    db.prepare("INSERT INTO voice_packs (id, user_id, mins_total, mins_used, stripe_payment_id, expires_at) VALUES (?,?,100,0,?,?)")
                      .run(require("uuid").v4(), userId, "addon-" + period, periodEnd);
                    db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)").run(userId, "voice_mins_renewed", JSON.stringify({ period, mins: 100, invoiceId: inv.id }));
                  }
                }
              } catch(e) { /* non-fatal */ }
            }

            // Recurring affiliate commission
            const refCode = sub.metadata?.ref_code;
            if (refCode && inv.billing_reason === "subscription_cycle") {
              try {
                const fetch = (await import("node-fetch")).default;
                fetch((process.env.BACKEND_URL || "http://localhost:4000") + "/api/affiliates/conversion", {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "x-internal-key": process.env.INTERNAL_API_KEY },
                  body: JSON.stringify({ ref_code: refCode, user_id: sub.metadata.mine_user, plan: sub.metadata.mine_plan || "renewal", amount: (inv.amount_paid || 0) / 100 })
                }).catch(() => {});
              } catch (e) {}
            }
          }
        }
        break;
      }
      case "invoice.payment_failed": {
        const inv = event.data.object;
        // ── Overage invoice payment failed ──
        if (inv.metadata?.type === "overage" && inv.metadata?.mine_user) {
          const uid = inv.metadata.mine_user;
          const period = inv.metadata.mine_period;
          db.prepare("UPDATE overage_charges SET status = 'failed' WHERE user_id = ? AND period = ? AND status = 'pending'").run(uid, period);
          db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)").run(uid, "overage_payment_failed", JSON.stringify({ invoiceId: inv.id, amount: inv.amount_due, period }));
          // Email the user
          try {
            const user = db.prepare("SELECT email, name FROM users WHERE id = ?").get(uid);
            if (user?.email) {
              const { autoEmail } = require("./features");
              await autoEmail(uid, user.email,
                "Payment failed — MINE usage charges",
                `<div style="font-family:system-ui;max-width:560px;margin:0 auto;padding:24px">
                  <h2 style="color:#2563EB">Action required: overdue balance</h2>
                  <p>Hi ${user.name || "there"},</p>
                  <p>We were unable to collect your TAKEOVA usage overage charges of <strong>$${(inv.amount_due / 100).toFixed(2)}</strong> for ${period}.</p>
                  <p>Please update your payment method to avoid service interruption:</p>
                  <p style="text-align:center;margin:24px 0">
                    <a href="${process.env.FRONTEND_URL || "https://takeova.ai"}/dashboard?tab=billing" style="background:#2563EB;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Update Payment Method →</a>
                  </p>
                  <p style="color:#666;font-size:13px">If you believe this is an error, reply to this email and we'll sort it out.</p>
                  <p style="color:#999;font-size:11px">Sent via MINE</p>
                </div>`
              );
            }
          } catch(e) { console.error("[Webhook] Failed to send payment_failed email:", e.message); }
        }
        break;
      }
      
      case "customer.subscription.updated": {
        const sub = event.data.object;
        const uid = sub.metadata?.mine_user;
        const custId = sub.customer;
        if (uid || custId) {
          // Find user by metadata or customer ID
          const targetUser = uid
            ? db.prepare("SELECT id, plan FROM users WHERE id = ?").get(uid)
            : db.prepare("SELECT id, plan FROM users WHERE stripe_customer_id = ?").get(custId);
          if (targetUser) {
            // Map Stripe price → MINE plan
            // Load from the file produced by seed-stripe-products.js.
            // Path is STRIPE_PRICE_IDS_PATH (matches .env.production.template).
            // Falls back to env vars for installations that set them individually.
            const priceId = sub.items?.data?.[0]?.price?.id || "";
            const PRICE_MAP = {};
            try {
              const path = require("path");
              const fs = require("fs");
              const pricesPath = process.env.STRIPE_PRICE_IDS_PATH
                ? path.resolve(process.env.STRIPE_PRICE_IDS_PATH)
                : path.join(__dirname, "..", "config", "stripe-prices.live.json");
              if (fs.existsSync(pricesPath)) {
                const cfg = JSON.parse(fs.readFileSync(pricesPath, "utf8"));
                for (const [planKey, obj] of Object.entries(cfg.plans || {})) {
                  if (obj?.monthlyPriceId) PRICE_MAP[obj.monthlyPriceId] = planKey;
                  if (obj?.annualPriceId)  PRICE_MAP[obj.annualPriceId]  = planKey;
                }
              }
            } catch (e) { /* fall through to env-var fallback */ }
            // Fallback: individual env vars (kept for legacy configs)
            if (!Object.keys(PRICE_MAP).length) {
              if (process.env.STRIPE_PRICE_STARTER)    PRICE_MAP[process.env.STRIPE_PRICE_STARTER]    = "starter";
              if (process.env.STRIPE_PRICE_GROWTH)     PRICE_MAP[process.env.STRIPE_PRICE_GROWTH]     = "growth";
              if (process.env.STRIPE_PRICE_PRO)        PRICE_MAP[process.env.STRIPE_PRICE_PRO]        = "pro";
              if (process.env.STRIPE_PRICE_ENTERPRISE) PRICE_MAP[process.env.STRIPE_PRICE_ENTERPRISE] = "enterprise";
              if (process.env.STRIPE_PRICE_AGENCY)     PRICE_MAP[process.env.STRIPE_PRICE_AGENCY]     = "agency";
            }
            const newPlan = PRICE_MAP[priceId];
            const newStatus = sub.status; // active, trialing, past_due, canceled
            if (newPlan && newPlan !== targetUser.plan) {
              db.prepare("UPDATE users SET plan = ?, updated_at = datetime('now') WHERE id = ?")
                .run(newPlan, targetUser.id);
              db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
                .run(targetUser.id, "plan_changed_via_stripe", JSON.stringify({ from: targetUser.plan, to: newPlan, priceId }));
            }
            // Handle trial ending: trialing → active
            if (newStatus === "active" && sub.trial_end) {
              db.prepare("UPDATE users SET trial_ends_at = NULL WHERE id = ?").run(targetUser.id);
            }
            // Track subscription status across ALL state transitions, not just failures.
            // This is what middleware/auth.js requireActivePlan reads to gate access.
            // Active/trialing → user has access; past_due/canceled/unpaid → blocked.
            if (newStatus) {
              db.prepare("UPDATE users SET subscription_status = ? WHERE id = ?")
                .run(newStatus, targetUser.id);
            }
            // Store subscription ID so we can match it on deletion even without metadata
            if (sub.id) {
              db.prepare("UPDATE users SET stripe_subscription_id = ? WHERE id = ? AND (stripe_subscription_id IS NULL OR stripe_subscription_id != ?)")
                .run(sub.id, targetUser.id, sub.id);
            }
          }
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        // Look up by subscription ID (metadata on subscription object is unreliable)
        const cancelledUser = db.prepare("SELECT id FROM users WHERE stripe_subscription_id = ?").get(sub.id);
        const cancelUid = cancelledUser?.id || sub.metadata?.mine_user;
        if (cancelUid) {
          db.prepare("UPDATE users SET plan = NULL, stripe_subscription_id = NULL, subscription_status = 'canceled' WHERE id = ?").run(cancelUid);
          db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)").run(cancelUid, "subscription_cancelled", JSON.stringify({ plan: sub.metadata?.mine_plan }));
          // If this was the paid Agency plan, also revoke agency access (role + agency record).
          try {
            const u = db.prepare("SELECT role FROM users WHERE id = ?").get(cancelUid);
            if (u && u.role === 'agency') {
              db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(cancelUid);
              db.prepare("UPDATE agencies SET status = 'inactive', updated_at = datetime('now') WHERE user_id = ?").run(cancelUid);
              db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)").run(cancelUid, "agency_access_revoked", JSON.stringify({ reason: "subscription_cancelled" }));
            }
          } catch(_) { /* agencies table may not exist yet */ }
        }
        // ALSO check if this was an AI employee subscription
        try {
          const aiEmp = db.prepare("SELECT id, user_id, employee_id FROM ai_employee_subscriptions WHERE stripe_subscription_id = ?").get(sub.id);
          if (aiEmp) {
            db.prepare("UPDATE ai_employee_subscriptions SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?").run(aiEmp.id);
            db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)").run(aiEmp.user_id, "ai_employee_cancelled", JSON.stringify({ employee_id: aiEmp.employee_id }));
          }
        } catch(_) { /* table may not exist yet */ }
        break;
      }

      case "charge.refunded": {
        // Revoke only on a FULL refund AND only if they're no longer actively subscribed
        // (a goodwill full refund to an active subscriber should NOT strip access).
        const charge = event.data.object;
        try {
          const fullyRefunded = charge.refunded === true || (charge.amount && charge.amount_refunded >= charge.amount);
          if (fullyRefunded && charge.customer) {
            const u = db.prepare("SELECT id, subscription_status FROM users WHERE stripe_customer_id = ?").get(charge.customer);
            if (u && u.subscription_status !== 'active' && u.subscription_status !== 'trialing') {
              revokeUserAccess(db, u.id, "full_refund");
            }
          }
        } catch(_) {}
        break;
      }

      case "invoice.payment_failed": {
        // If the failed invoice was for an AI employee subscription, mark it as past_due
        const inv = event.data.object;
        const subId = inv.subscription;
        if (subId) {
          try {
            db.prepare("UPDATE ai_employee_subscriptions SET status = 'past_due' WHERE stripe_subscription_id = ?").run(subId);
          } catch(_) {}
        }
        break;
      }

      case "invoice.payment_succeeded": {
        // If this was for an AI employee subscription that was past_due, restore active
        const inv = event.data.object;
        const subId = inv.subscription;
        if (subId) {
          try {
            db.prepare("UPDATE ai_employee_subscriptions SET status = 'active' WHERE stripe_subscription_id = ? AND status = 'past_due'").run(subId);
          } catch(_) {}
        }
        break;
      }

      case "account.deauthorized": {
        // User disconnected their Stripe Connect account from Stripe's dashboard.
        // event.data.object is an Account (not a subscription) — the account ID
        // is what we stored in users.stripe_connect_id.
        const acct = event.data.object;
        const connectId = acct.id;
        if (connectId) {
          // Clear their connect ID so they're prompted to reconnect.
          // Only stripe_connect_id exists on users — no stripe_connect_status column.
          db.prepare("UPDATE users SET stripe_connect_id = NULL WHERE stripe_connect_id = ?")
            .run(connectId);
          // Also clear on agencies table if this was an agency's account
          try {
            db.prepare("UPDATE agencies SET stripe_connect_id = NULL WHERE stripe_connect_id = ?")
              .run(connectId);
          } catch(e) { /* agencies table may not exist */ }
          console.log('[Stripe Connect] Account deauthorized:', connectId);
        }
        break;
      }
      case "account.updated": {
        const acct = event.data.object;
        if (acct.charges_enabled && acct.details_submitted) {
          const u = db.prepare("SELECT id FROM users WHERE stripe_connect_id = ?").get(acct.id);
          if (u) db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)").run(u.id, "connect_activated", JSON.stringify({ connectId: acct.id }));
        }
        break;
      }

      // ── PaymentIntent lifecycle ────────────────────────────────────────
      // All our code currently creates PIs with `confirm: true` + `off_session: true`,
      // so the happy path is confirmed synchronously in the API handler.
      // This webhook is the catch-all for:
      //   • SCA / 3D-Secure flows where pi.status came back as 'requires_action'
      //     and user then completed authentication (succeeded fires asynchronously)
      //   • Delayed confirmations (slow networks, issuer delays)
      //   • PIs created by Stripe Dashboard actions
      // We log for audit; if the PI's metadata points at a known user we flag it.
      case "payment_intent.succeeded": {
        const pi = event.data.object;
        const piUid = pi.metadata?.user_id || pi.metadata?.mine_user;
        if (piUid) {
          // Idempotent: only log if we haven't already recorded this PI in overage_charges.
          // If we did, the synchronous success path handled it and we don't duplicate.
          try {
            const existing = db.prepare("SELECT id FROM overage_charges WHERE stripe_invoice_item_id = ?").get(pi.id);
            if (!existing) {
              db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
                .run(piUid, "payment_intent_succeeded_async", JSON.stringify({
                  piId: pi.id,
                  amount: (pi.amount_received || pi.amount || 0) / 100,
                  metadata: pi.metadata || {}
                }));
            }
          } catch(e) { /* table may not exist yet — audit log is non-critical */ }
        }
        break;
      }

      case "payment_intent.payment_failed": {
        const pi = event.data.object;
        const piUid = pi.metadata?.user_id || pi.metadata?.mine_user;
        if (piUid) {
          db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
            .run(piUid, "payment_intent_failed", JSON.stringify({
              piId: pi.id,
              amount: (pi.amount || 0) / 100,
              lastPaymentError: pi.last_payment_error?.message || null,
              declineCode: pi.last_payment_error?.decline_code || null,
            }));
        }
        break;
      }

      // ── Dispute / chargeback ──────────────────────────────────────────
      // A customer disputed a charge with their bank. We need to:
      //  • Flag the originating order if we can find one
      //  • Alert the admin (or user) via audit log — email handled separately
      //  • Stripe automatically withdraws the funds + fee; we just record.
      case "charge.dispute.created": {
        const dispute = event.data.object;
        const chargeId = dispute.charge;
        const piId = dispute.payment_intent;
        // Try to find the originating order by stripe charge/pi reference
        let orderUid = null;
        try {
          const order = db.prepare("SELECT id, user_id FROM orders WHERE stripe_payment_intent = ? OR stripe_charge_id = ? LIMIT 1")
            .get(piId, chargeId);
          if (order) {
            orderUid = order.user_id;
            db.prepare("UPDATE orders SET status = 'disputed', notes = COALESCE(notes, '') || ? WHERE id = ?")
              .run(`\n[DISPUTE ${new Date().toISOString()}] reason: ${dispute.reason || 'unknown'}, amount: $${(dispute.amount || 0) / 100}`, order.id);
          }
        } catch(e) { /* orders table columns may differ — non-fatal */ }

        // Record audit regardless of whether we found the order
        db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
          .run(orderUid || null, "charge_disputed", JSON.stringify({
            chargeId,
            piId,
            amount: (dispute.amount || 0) / 100,
            reason: dispute.reason,
            status: dispute.status,
            disputeId: dispute.id,
          }));
        console.warn(`[Stripe Dispute] charge=${chargeId} pi=${piId} reason=${dispute.reason} amount=$${(dispute.amount || 0) / 100}`);
        // Chargeback is a hostile signal — also revoke the disputing user's paid access.
        try {
          let disputeUid = orderUid;
          if (!disputeUid) {
            let customerId = dispute.customer || null;
            if (!customerId && chargeId) {
              const ch = await getStripe().charges.retrieve(chargeId);
              customerId = ch?.customer || null;
            }
            if (customerId) {
              const du = db.prepare("SELECT id FROM users WHERE stripe_customer_id = ?").get(customerId);
              disputeUid = du?.id || null;
            }
          }
          if (disputeUid) revokeUserAccess(db, disputeUid, "chargeback");
        } catch(_) {}
        break;
      }
    }

    // Mark processed ONLY after switch completes without throwing.
    // If the switch threw, we drop into the outer catch and return 500 without
    // this INSERT running — Stripe will retry the event later.
    try {
      db.prepare("INSERT OR IGNORE INTO processed_stripe_events (event_id) VALUES (?)").run(event.id);
    } catch(e) { console.error("[/webhook]", e.message || e); }

    res.json({ received: true });
  } catch(e) {
    console.error("[Payments]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// (module.exports moved to end of file)

// ═══════════════════════════════════════
// FEATURE 4: REVENUE-SHARE PRICING
// ═══════════════════════════════════════

// (revenue-share plan removed — platform fees come solely from PLAN_FEE_PERCENT)

// ═══════════════════════════════════════
// FEATURE 5: AI PROPOSAL / QUOTE GENERATOR
// ═══════════════════════════════════════

router.post("/proposals/generate", auth, async (req, res) => {
  try {
    const { clientName, clientEmail, projectDescription, description, services, budget } = req.body;
    const projDesc = projectDescription || description || "";
    const db = getDb();
    db.exec("CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, user_id TEXT, client_name TEXT, client_email TEXT, description TEXT, services TEXT, amount REAL, status TEXT DEFAULT 'draft', html TEXT, pdf_url TEXT, opened_at TEXT, signed_at TEXT, created_at TEXT, follow_up_count INTEGER DEFAULT 0)");

    // Usage cap check
    if (typeof global !== "undefined" && global.mineCheckUsage) {
      const usage = global.mineCheckUsage(db, req.userId, "proposals");
      if (usage.blocked) return res.status(403).json({ error: "AI Proposals not available on your plan. Upgrade to Growth or higher.", upgrade: true });
      global.mineTrackUsage(db, req.userId, "proposals");
    }

    const anthropicKey = getSetting("ANTHROPIC_API_KEY");
    if (!anthropicKey) return res.status(400).json({ error: "AI not configured" });

    // Get business context
    const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
    const siteProducts = site ? db.prepare("SELECT name, price FROM products WHERE user_id = ? LIMIT 20").all(req.userId) : [];
    const businessProducts = siteProducts.map(p => `${p.name}: $${p.price}`).join(", ");

    const fetch = (await import("node-fetch")).default;
    const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": anthropicKey, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: 2000,
        messages: [{ role: "user", content: `Write a professional business proposal/quote as HTML.
  Business: ${site?.name || "My Business"}
  Available services: ${businessProducts || services?.join(", ") || "consulting services"}
  Client: ${clientName}
  Project: ${projectDescription}
  Budget hint: ${budget || "to be quoted"}

  Create a clean, professional HTML proposal with:
  1. Header with business name and date
  2. Executive summary (2-3 sentences)
  3. Scope of work (bullet points)
  4. Deliverables with timeline
  5. Pricing table with line items
  6. Terms (payment terms, validity)
  7. Signature block

  Use inline CSS. Make it look premium. Return ONLY the HTML, no markdown fences.` }]
      })
    });
    const aiData = await aiResp.json();
    const rawHtml = aiData.content?.[0]?.text || "";
    const html = sanitizeHtml(rawHtml, PROPOSAL_SANITIZE_OPTS);

    const id = uuid();
    const amount = parseFloat(budget) || 0;
    db.prepare("INSERT INTO proposals (id, user_id, client_name, client_email, description, services, amount, html, created_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))")
      .run(id, req.userId, clientName, clientEmail, projDesc, JSON.stringify(services || []), amount, html);

    res.json({ success: true, id, html, amount });
  } catch(e) {
    console.error("[Payments]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// Send proposal to client
router.post("/proposals/:id/send", auth, async (req, res) => {
  try {
    const db = getDb();
    const proposal = db.prepare("SELECT * FROM proposals WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
    if (!proposal) return res.status(404).json({ error: "Not found" });

    const sgKey = getSetting("SENDGRID_API_KEY");
    if (!sgKey) return res.status(400).json({ error: "Email not configured" });

    const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
    const fetch = (await import("node-fetch")).default;
    const serverUrl = getSetting("SERVER_URL") || "https://your-server.com";

    const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: proposal.client_email, name: proposal.client_name }] }],
        from: { email: getSetting("EMAIL_FROM") || "noreply@takeova.ai", name: site?.name || "Business" },
        subject: `Proposal from ${site?.name || "us"}: ${String(proposal.description || "").replace(/[\r\n]/g, "").substring(0, 50)}`,
        content: [{ type: "text/html", value: (() => {
      const pixelToken = crypto.createHmac("sha256", process.env.INTERNAL_API_KEY || process.env.JWT_SECRET || "dev-CHANGE-ME").update(proposal.id).digest("hex").slice(0, 24);
          const viewToken = crypto.createHmac("sha256", process.env.INTERNAL_API_KEY || process.env.JWT_SECRET || "dev-CHANGE-ME").update(proposal.id).digest("hex").slice(0, 32);
          const viewUrl = `${serverUrl}/api/payments/proposals/${proposal.id}/view?t=${viewToken}`;
          return `<div style="text-align:center;margin:28px 0">
            <a href="${viewUrl}" style="background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block">
              📄 View &amp; Sign Proposal →
            </a>
            <div style="margin-top:10px;font-size:12px;color:#94a3b8">Or copy this link: ${viewUrl}</div>
          </div>` + proposal.html + (() => { try { const mc2=db.prepare("SELECT wa_business_code,customer_mode_enabled FROM mine_control_config WHERE user_id=? AND enabled=1").get(req.userId); const wn=(getSetting("WHATSAPP_BUSINESS_NUMBER")||process.env.WHATSAPP_BUSINESS_NUMBER||"").replace(/\D/g,""); if(!mc2?.wa_business_code||!mc2?.customer_mode_enabled||!wn)return ""; const wl="https://wa.me/"+wn+"?text="+encodeURIComponent("START-"+mc2.wa_business_code); const qr="https://api.qrserver.com/v1/create-qr-code/?size=100x100&data="+encodeURIComponent(wl); return `<div style="text-align:center;margin:24px 0;padding:20px;background:#f0fdf4;border-radius:10px;border:1px solid #bbf7d0;"><p style="font-size:12px;color:#166534;font-weight:600;margin-bottom:10px;">💬 Questions? Chat on WhatsApp</p><a href="${wl}"><img src="${qr}" style="width:80px;height:80px;border-radius:6px;border:2px solid #25D366;"/></a><p style="margin-top:8px;"><a href="${wl}" style="color:#25D366;font-size:12px;font-weight:600;text-decoration:none;">Open WhatsApp →</a></p></div>`; } catch(e){return "";} })() + `<br><br><img src="${serverUrl}/api/payments/proposals/${proposal.id}/pixel?t=${pixelToken}" width="1" height="1"/>`;
        })() }]
      })
    });
    if (!_sgResp.ok) {
      let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
      console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
    }

    db.prepare("UPDATE proposals SET status = 'sent' WHERE id = ?").run(proposal.id);
    res.json({ sent: true });
  } catch(e) {
    console.error("[Payments]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// Track proposal opens — token-authenticated to prevent arbitrary open-marking
router.get("/proposals/:id/pixel", async (req, res) => {
  const pixelImg = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  res.type("image/gif").send(pixelImg); // Respond immediately — don't block email client

  const { t } = req.query;
  if (!t) return;
  try {
    const expected = crypto.createHmac("sha256", process.env.INTERNAL_API_KEY || process.env.JWT_SECRET || "dev-CHANGE-ME").update(req.params.id).digest("hex").slice(0, 24);
    const tokenBuf = Buffer.from(t.padEnd(expected.length, " ").slice(0, expected.length));
    const expectedBuf = Buffer.from(expected);
    if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) return;

    const db = getDb();
    const proposal = db.prepare("SELECT * FROM proposals WHERE id=?").get(req.params.id);
    if (!proposal) return;

    const wasUnseen = !proposal.opened_at;
    db.prepare("UPDATE proposals SET opened_at=COALESCE(opened_at,datetime('now')), view_count=COALESCE(view_count,0)+1, status=CASE WHEN status='sent' THEN 'viewed' ELSE status END WHERE id=?").run(req.params.id);

    // Notify owner only on FIRST open
    if (wasUnseen) {
      try {
        const owner = db.prepare("SELECT u.email, u.name, s.name as site_name FROM users u LEFT JOIN sites s ON s.user_id=u.id WHERE u.id=? LIMIT 1").get(proposal.user_id);
        const sgKey = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
        const fromEmail = getSetting("EMAIL_FROM") || process.env.EMAIL_FROM || "hello@takeova.ai";
        if (sgKey && owner?.email) {
          const fetch = (await import("node-fetch")).default;
          const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
            method: "POST",
            headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: owner.email, name: owner.name || "there" }] }],
              from: { email: fromEmail, name: "MINE" },
              subject: "🎯 " + String(proposal.client_name || "Client").replace(/[\r\n]/g, " ").slice(0, 100) + " just opened your proposal!",
              content: [{ type: "text/html", value: `
                <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px 16px">
                  <div style="background:linear-gradient(135deg,#4F46E5,#6366F1);border-radius:14px;padding:24px;text-align:center;margin-bottom:20px">
                    <div style="font-size:32px;margin-bottom:8px">🎯</div>
                    <div style="font-size:20px;font-weight:800;color:#fff">Proposal opened!</div>
                    <div style="font-size:13px;color:rgba(255,255,255,.7);margin-top:4px">${escHtml(proposal.client_name)} is reading your proposal right now</div>
                  </div>
                  <div style="background:#F0FDF4;border:1px solid #86EFAC;border-radius:10px;padding:16px;margin-bottom:16px;font-size:13px">
                    <div><strong>Prospect:</strong> ${escHtml(proposal.client_name)}</div>
                    <div><strong>Proposal:</strong> ${escHtml(proposal.description || "Proposal")}</div>
                    <div><strong>Opened:</strong> Just now</div>
                  </div>
                  <p style="font-size:13px;color:#555;line-height:1.7;margin-bottom:16px">
                    This is a great time to send a personal message or give them a quick call — they're actively considering your offer.
                  </p>
                  <div style="background:#FFF7ED;border:1px solid #FED7AA;border-radius:8px;padding:12px;font-size:12px;color:#92400E">
                    💡 <strong>Tip:</strong> Proposals viewed within the first hour convert 3x more. Strike while it's fresh.
                  </div>
                </div>
              `}]
            })
          })
          if (!_sgResp.ok) {
            let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
            console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
          }
        }
      } catch(notifyErr) { /* non-fatal */ }
    }
  } catch(e) { /* non-fatal */ }
});

// List proposals
router.get("/proposals", auth, (req, res) => {
  const db = getDb();
  try {
    const proposals = db.prepare("SELECT id, client_name, client_email, description, amount, status, opened_at, signed_at, created_at FROM proposals WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").all(req.userId);
    res.json({ proposals });
  } catch(e) { res.json({ proposals: [] }); }
});

// View a single proposal (owner)
router.get("/proposals/:id", auth, (req, res) => {
  const db = getDb();
  const proposal = db.prepare("SELECT * FROM proposals WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!proposal) return res.status(404).json({ error: "Not found" });
  try { proposal.services = JSON.parse(proposal.services || "[]"); } catch (e) { proposal.services = []; }
  res.json({ proposal });
});

// Client-facing proposal view page (public, token-authenticated)
// Token = HMAC-SHA256(proposal_id, INTERNAL_API_KEY) — included in the email link
router.get("/proposals/:id/view", (req, res) => {
  const { t } = req.query;
  if (!t) return res.status(400).send("Missing token");

  const expected = crypto.createHmac("sha256", process.env.INTERNAL_API_KEY || process.env.JWT_SECRET || "dev-CHANGE-ME")
    .update(req.params.id).digest("hex").slice(0, 32);
  const tBuf = Buffer.from((t + " ".repeat(32)).slice(0, 32));
  const eBuf = Buffer.from(expected);
  if (tBuf.length !== eBuf.length || !crypto.timingSafeEqual(tBuf, eBuf)) {
    return res.status(403).send("Invalid or expired link");
  }

  const db = getDb();
  const proposal = db.prepare("SELECT * FROM proposals WHERE id = ?").get(req.params.id);
  if (!proposal) return res.status(404).send("Proposal not found");

  // Mark opened if not already
  if (!proposal.opened_at) {
    db.prepare("UPDATE proposals SET opened_at = datetime('now'), status = CASE WHEN status = 'sent' THEN 'viewed' ELSE status END WHERE id = ?").run(req.params.id);
  }

  const signToken = crypto.createHmac("sha256", process.env.INTERNAL_API_KEY || process.env.JWT_SECRET || "dev-CHANGE-ME")
    .update("sign:" + req.params.id).digest("hex").slice(0, 32);
  const serverUrl = getSetting("SERVER_URL") || "https://your-server.com";

  // Return the proposal HTML wrapped in a sign page shell
  const signFormHtml = proposal.signed_at ? `
    <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:20px;text-align:center;margin:24px 0">
      <div style="font-size:32px;margin-bottom:8px">✅</div>
      <div style="font-weight:700;color:#15803d;font-size:18px">Proposal Signed</div>
      <div style="color:#166534;margin-top:4px;font-size:14px">Signed on ${new Date(proposal.signed_at).toLocaleDateString("en-GB", { day:"numeric", month:"long", year:"numeric" })}</div>
    </div>` : `
    <div style="background:#fff;border:1.5px solid #e2e8f0;border-radius:12px;padding:28px;margin:24px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
      <div style="font-size:18px;font-weight:700;margin-bottom:4px">Ready to proceed?</div>
      <div style="color:#64748b;font-size:14px;margin-bottom:20px">By signing below you agree to the terms and scope outlined in this proposal.</div>
      <div style="margin-bottom:16px">
        <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Your full name</label>
        <input id="sig-name" type="text" placeholder="${escHtml(proposal.client_name)}" value="${escHtml(proposal.client_name)}"
          style="width:100%;padding:10px 14px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:15px;box-sizing:border-box"/>
      </div>
      <div style="margin-bottom:20px">
        <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Draw your signature</label>
        <canvas id="sig-canvas" width="520" height="100"
          style="border:1.5px solid #e2e8f0;border-radius:8px;background:#f8fafc;cursor:crosshair;width:100%;max-width:520px;display:block"></canvas>
        <button onclick="clearSig()" style="margin-top:6px;font-size:12px;color:#64748b;background:none;border:none;cursor:pointer;padding:0">Clear</button>
      </div>
      <button onclick="submitSig()" id="sig-btn"
        style="width:100%;padding:14px;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer">
        ✍️ Sign &amp; Accept Proposal
      </button>
      <div id="sig-msg" style="margin-top:12px;font-size:13px;text-align:center;display:none"></div>
    </div>
    <script>
      const canvas = document.getElementById('sig-canvas');
      const ctx = canvas.getContext('2d');
      let drawing = false, hasSignature = false;
      ctx.strokeStyle = '#1e293b'; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      function pos(e) {
        const r = canvas.getBoundingClientRect();
        const scaleX = canvas.width / r.width;
        const scaleY = canvas.height / r.height;
        const src = e.touches ? e.touches[0] : e;
        return { x: (src.clientX - r.left) * scaleX, y: (src.clientY - r.top) * scaleY };
      }
      canvas.addEventListener('mousedown', e => { drawing = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); });
      canvas.addEventListener('mousemove', e => { if (!drawing) return; hasSignature = true; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); });
      canvas.addEventListener('mouseup', () => drawing = false);
      canvas.addEventListener('touchstart', e => { e.preventDefault(); drawing = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); });
      canvas.addEventListener('touchmove', e => { e.preventDefault(); if (!drawing) return; hasSignature = true; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); });
      canvas.addEventListener('touchend', () => drawing = false);
      function clearSig() { ctx.clearRect(0, 0, canvas.width, canvas.height); hasSignature = false; }
      async function submitSig() {
        const name = document.getElementById('sig-name').value.trim();
        if (!name) { showMsg('Please enter your full name', 'error'); return; }
        if (!hasSignature) { showMsg('Please draw your signature', 'error'); return; }
        const sigData = canvas.toDataURL('image/png');
        const btn = document.getElementById('sig-btn');
        btn.disabled = true; btn.textContent = 'Submitting…';
        try {
          const r = await fetch('${serverUrl}/api/payments/proposals/${req.params.id}/sign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: '${signToken}', signerName: name, signatureData: sigData })
          });
          const d = await r.json();
          if (d.signed) {
            showMsg('✅ Proposal signed! You'll receive a confirmation email shortly.', 'success');
            btn.style.display = 'none';
            document.getElementById('sig-canvas').style.display = 'none';
          } else {
            showMsg(d.error || 'Something went wrong', 'error');
            btn.disabled = false; btn.textContent = '✍️ Sign & Accept Proposal';
          }
        } catch(e) {
          showMsg('Network error — please try again', 'error');
          btn.disabled = false; btn.textContent = '✍️ Sign & Accept Proposal';
        }
      }
      function showMsg(msg, type) {
        const el = document.getElementById('sig-msg');
        el.textContent = msg;
        el.style.display = 'block';
        el.style.color = type === 'error' ? '#dc2626' : '#16a34a';
      }
    </script>`;

  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Proposal — ${escHtml(proposal.client_name)}</title>
    <style>body{margin:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
    .wrap{max-width:680px;margin:0 auto;padding:24px 16px 60px}</style></head>
    <body><div class="wrap">${proposal.html || ""}${signFormHtml}</div></body></html>`);
});

// Client signs the proposal (public endpoint, HMAC-token authenticated)
router.post("/proposals/:id/sign", async (req, res) => {
  try {
    const { token, signerName, signatureData } = req.body;
    if (!token || !signerName) return res.status(400).json({ error: "Missing required fields" });

    const expected = crypto.createHmac("sha256", process.env.INTERNAL_API_KEY || process.env.JWT_SECRET || "dev-CHANGE-ME")
      .update("sign:" + req.params.id).digest("hex").slice(0, 32);
    const tBuf = Buffer.from((token + " ".repeat(32)).slice(0, 32));
    const eBuf = Buffer.from(expected);
    if (tBuf.length !== eBuf.length || !crypto.timingSafeEqual(tBuf, eBuf)) {
      return res.status(403).json({ error: "Invalid or expired signing link" });
    }

    const db = getDb();
    const proposal = db.prepare("SELECT * FROM proposals WHERE id = ?").get(req.params.id);
    if (!proposal) return res.status(404).json({ error: "Proposal not found" });
    if (proposal.signed_at) return res.status(409).json({ error: "Already signed" });

    // Store signature data and mark signed
    try { db.exec("ALTER TABLE proposals ADD COLUMN signer_name TEXT"); } catch(e) {}
    try { db.exec("ALTER TABLE proposals ADD COLUMN signature_data TEXT"); } catch(e) {}

    db.prepare("UPDATE proposals SET signed_at = datetime('now'), status = 'signed', signer_name = ?, signature_data = ? WHERE id = ?")
      .run(signerName, signatureData || null, req.params.id);
    try { updateOutcome(req.params.id, 'proposal', 'success', { signed: true }); } catch(_){}

    // Notify the business owner by email
    const sgKey = getSetting("SENDGRID_API_KEY");
    const owner = db.prepare("SELECT email FROM users WHERE id = ?").get(proposal.user_id);
    const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(proposal.user_id);
    const serverUrl = getSetting("SERVER_URL") || "https://your-server.com";

    if (sgKey && owner) {
      const fetch = (await import("node-fetch")).default;
      const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: owner.email }] }],
          from: { email: getSetting("EMAIL_FROM") || "noreply@takeova.ai", name: site?.name || "MINE" },
          subject: `🎉 ${String(proposal.client_name || "Client").replace(/[\r\n]/g, " ").slice(0, 100)} signed your proposal`,
          content: [{ type: "text/html", value: `
            <p>Great news — <strong>${escHtml(signerName)}</strong> (${escHtml(proposal.client_email)}) has signed your proposal for <em>${escHtml(proposal.description)}</em>.</p>
            <p><strong>Amount: $${proposal.amount?.toFixed(2) || "0.00"}</strong></p>
            <p><a href="${serverUrl}/payments/proposals/${proposal.id}/convert-preview" style="background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:700">Convert to Invoice →</a></p>
            <p style="color:#64748b;font-size:13px">You can also convert from Payments → Proposals in your dashboard.</p>`
          }]
        })
      })
      if (!_sgResp.ok) {
        let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
        console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
      }

      // Also send confirmation to the client
      const _sgResp2 = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: proposal.client_email, name: proposal.client_name }] }],
          from: { email: getSetting("EMAIL_FROM") || "noreply@takeova.ai", name: site?.name || "Business" },
          subject: `Your signed proposal — ${proposal.description?.substring(0, 50)}`,
          content: [{ type: "text/html", value: `
            <p>Hi ${escHtml(proposal.client_name)},</p>
            <p>Thank you for signing! This email confirms you have accepted the proposal for <strong>${escHtml(proposal.description)}</strong>.</p>
            <p>Amount agreed: <strong>$${proposal.amount?.toFixed(2) || "0.00"}</strong></p>
            <p>We'll be in touch shortly with next steps.</p>
            <p>${proposal.html || ""}</p>`
          }]
        })
      })
      if (!_sgResp2.ok) {
        let _sgErr = ""; try { _sgErr = (await _sgResp2.text()).slice(0, 300); } catch(_) {}
        console.error(`[sendgrid] ${_sgResp2.status}: ${_sgErr}`);
      }
    }

    // Fire automation trigger
    await fireAutomation(proposal.user_id, "proposal_signed", {
      proposalId: proposal.id, clientName: proposal.client_name,
      clientEmail: proposal.client_email, amount: proposal.amount
    });

    res.json({ signed: true });
  } catch(e) {
    console.error("[Payments]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// Convert a signed proposal to an invoice
router.post("/proposals/:id/convert", auth, (req, res) => {
  const db = getDb();
  const proposal = db.prepare("SELECT * FROM proposals WHERE id = ? AND user_id = ?").get(req.params.id, req.userId);
  if (!proposal) return res.status(404).json({ error: "Not found" });
  if (proposal.status !== "signed") return res.status(400).json({ error: "Proposal must be signed before converting to invoice" });

  // Parse services from proposal into invoice line items
  let services = [];
  try { services = JSON.parse(proposal.services || "[]"); } catch (e) {}
  const items = services.length > 0
    ? services
    : [{ description: proposal.description || "Services", quantity: 1, unit_price: proposal.amount || 0 }];

  const subtotal = items.reduce((s, i) => s + ((i.unit_price || i.price || 0) * (i.quantity || 1)), 0);
  const total = subtotal; // tax can be added via invoice edit

  // Generate invoice number — use MAX to avoid race conditions
  const lastInv = db.prepare("SELECT MAX(CAST(REPLACE(invoice_number,'INV-','') AS INTEGER)) as maxNum FROM invoices WHERE user_id = ? AND invoice_number LIKE 'INV-%'").get(req.userId);
  const nextNum = (lastInv?.maxNum || 1000) + 1;
  const invoiceNumber = "INV-" + String(nextNum).padStart(4, "0");

  // Due date defaults to 14 days from now
  const dueDate = req.body.dueDate || new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const notes = req.body.notes || `Converted from Proposal — ${proposal.description || ""}. Signed by ${proposal.signer_name || proposal.client_name} on ${proposal.signed_at?.split("T")[0] || "date unknown"}.`;

  const invoiceId = uuid();
  db.prepare(`INSERT INTO invoices (id, user_id, invoice_number, client_name, client_email, items_json, subtotal, tax, total, status, due_date, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'draft', ?, ?, datetime('now'))`)
    .run(invoiceId, req.userId, invoiceNumber, proposal.client_name, proposal.client_email,
      JSON.stringify(items), subtotal, total, dueDate, notes);

  // Mark proposal as converted
  db.prepare("UPDATE proposals SET status = 'converted' WHERE id = ?").run(proposal.id);

  res.json({ success: true, invoiceId, invoiceNumber, total });
});

// Auto follow-up — fires on both unopened AND opened-but-unsigned proposals
router.post("/proposals/auto-followup", auth, async (req, res) => {
  try {
    const db = getDb();

    // Two cohorts:
    // 1. Sent >2 days ago and never opened — gentle "did you see this?" nudge
    // 2. Viewed >3 days ago but not yet signed — "any questions?" nudge
    const unopened = db.prepare(`
      SELECT *, 'unopened' AS cohort FROM proposals
      WHERE user_id = ? AND status IN ('sent') AND opened_at IS NULL
      AND follow_up_count < 3 AND datetime(created_at) < datetime('now', '-2 days')
    `).all(req.userId);

    const viewedUnsigned = db.prepare(`
      SELECT *, 'viewed' AS cohort FROM proposals
      WHERE user_id = ? AND status IN ('viewed') AND signed_at IS NULL
      AND follow_up_count < 3 AND datetime(opened_at) < datetime('now', '-3 days')
    `).all(req.userId);

    const stale = [...unopened, ...viewedUnsigned];
    const sgKey = getSetting("SENDGRID_API_KEY");
    if (!sgKey) return res.json({ followedUp: 0 });

    const site = db.prepare("SELECT name FROM sites WHERE user_id = ? LIMIT 1").get(req.userId);
    const fetch = (await import("node-fetch")).default;
    let count = 0;

    for (const p of stale) {
      const isViewed = p.cohort === "viewed";
      const subject = isViewed
        ? `Any questions about the proposal? — ${(p.description || "").substring(0, 40)}`
        : `Following up on our proposal — ${(p.description || "").substring(0, 40)}`;
      const body = isViewed
        ? `Hi ${p.client_name},\n\nI noticed you had a look at the proposal — just wanted to check if you have any questions or if there's anything you'd like to adjust before moving forward.\n\nLooking forward to working together!\n\nBest regards,\n${site?.name || "The team"}`
        : `Hi ${p.client_name},\n\nJust following up on the proposal I sent a couple of days ago. Let me know if you'd like to discuss anything.\n\nBest regards,\n${site?.name || "The team"}`;

      const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: p.client_email, name: p.client_name }] }],
          from: { email: getSetting("EMAIL_FROM") || "noreply@takeova.ai", name: site?.name || "Business" },
          subject,
          content: [{ type: "text/plain", value: body }]
        })
      })
      if (!_sgResp.ok) {
        let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
        console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
      }

      db.prepare("UPDATE proposals SET follow_up_count = follow_up_count + 1 WHERE id = ?").run(p.id);
      count++;
    }
    res.json({ followedUp: count, unopened: unopened.length, viewedUnsigned: viewedUnsigned.length });
  } catch(e) {
    console.error("[Payments]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});


// ═══════════════════════════════════════
// OVERAGE AUTO-BILLING (end of month cron)
// ═══════════════════════════════════════

router.post("/bill-overages", auth, async (req, res) => {
  try {
    // Restrict to admin users and cron scheduler only — regular users must not self-trigger billing
    const db = getDb();
    const callingUser = db.prepare("SELECT role FROM users WHERE id = ?").get(req.userId);
    const _cronKey = process.env.CRON_SECRET || "";
    const _supplied = req.headers["x-cron-key"] || "";
    const isCron = _cronKey.length > 0 && _supplied.length === _cronKey.length &&
      require("crypto").timingSafeEqual(Buffer.from(_supplied), Buffer.from(_cronKey));
    const isAdmin = callingUser?.role === "admin";
    if (!isCron && !isAdmin) {
      return res.status(403).json({ error: "Forbidden: overage billing can only be triggered by an admin or the billing scheduler." });
    }

    const period = new Date().getFullYear() + "-" + String(new Date().getMonth() + 1).padStart(2, "0");

    // ── Admin bypass: if the target user is admin, mark pending rows as
    // admin_free and return without billing. Catches all paths that reach
    // here (cron, admin self-trigger, system internal calls).
    const targetUserId = req.body?.user_id || req.userId;
    const targetUser = db.prepare("SELECT role FROM users WHERE id = ?").get(targetUserId);
    if (targetUser?.role === "admin") {
      db.prepare("UPDATE overage_charges SET status='admin_free' WHERE user_id=? AND period=? AND status='pending'").run(targetUserId, period);
      return res.json({ billed: false, admin: true, message: "Admin user — billing skipped, pending rows marked admin_free" });
    }

    try {
      // Get all pending overage charges for this user this period
      const overages = db.prepare("SELECT metric, SUM(total) as total, SUM(quantity) as qty FROM overage_charges WHERE user_id = ? AND period = ? AND status = 'pending' GROUP BY metric").all(req.userId);
      const totalOverage = overages.reduce((s, o) => s + o.total, 0);

      if (totalOverage <= 0) return res.json({ billed: false, total: 0, message: "No overages this period" });

      // Get or create Stripe customer
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
      let customerId = user.stripe_customer_id;
      if (!customerId) {
        const c = await getStripe().customers.create({ email: user.email, metadata: { mine_user: user.id } });
        customerId = c.id;
        db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(customerId, user.id);
      }

      // Create invoice with line items for each overage metric
      const invoice = await getStripe().invoices.create({
        customer: customerId,
        auto_advance: true, // auto-finalize and charge
        collection_method: "charge_automatically",
        metadata: { mine_user: req.userId, mine_period: period, type: "overage" },
      }, { idempotencyKey: `overage-inv-${req.userId}-${period}` });

      for (const o of overages) {
        await getStripe().invoiceItems.create({
          customer: customerId,
          invoice: invoice.id,
          amount: Math.round(o.total * 100), // cents
          currency: "usd",
          description: `MINE Overage — ${METRIC_NAMES[o.metric] || o.metric}: ${o.qty} × $${(o.total / o.qty).toFixed(2)} (${period})`,
        }, { idempotencyKey: `overage-item-${req.userId}-${period}-${o.metric}` });
      }

      // Finalize and attempt payment
      const finalized = await getStripe().invoices.finalizeInvoice(invoice.id);
      const paid = await getStripe().invoices.pay(invoice.id);

      // Mark overages as billed
      db.prepare("UPDATE overage_charges SET status = 'billed' WHERE user_id = ? AND period = ? AND status = 'pending'").run(req.userId, period);

      db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)").run(
        req.userId, "overage_billed", JSON.stringify({ period, total: totalOverage, metrics: overages, invoiceId: invoice.id }));

      res.json({ billed: true, total: totalOverage, invoiceId: invoice.id, status: paid.status, breakdown: overages });
    } catch (e) { console.error("[Route] Internal error:", e?.message);
      res.status(500).json({ error: "An internal error occurred" }); }
  } catch(e) {
    console.error("[Payments]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// Cron-friendly: bill all users with overages
router.post("/bill-overages-all", auth, async (req, res) => {
  try {
    // Protected by API key for cron — timing-safe comparison to prevent timing attacks
    const _cronKey = process.env.CRON_SECRET || "";
    const _supplied = req.headers["x-cron-key"] || "";
    const _cronValid = _cronKey.length > 0 && _supplied.length === _cronKey.length &&
      require("crypto").timingSafeEqual(Buffer.from(_supplied), Buffer.from(_cronKey));
    if (!_cronValid) return res.status(401).json({ error: "Unauthorized" });

    const db = getDb();
    const period = new Date().getFullYear() + "-" + String(new Date().getMonth() + 1).padStart(2, "0");

    const usersWithOverages = db.prepare("SELECT DISTINCT user_id FROM overage_charges WHERE period = ? AND status = 'pending'").all(period);
    let billed = 0;

    for (const { user_id } of usersWithOverages) {
      try {
        const overages = db.prepare("SELECT metric, SUM(total) as total, SUM(quantity) as qty FROM overage_charges WHERE user_id = ? AND period = ? AND status = 'pending' GROUP BY metric").all(user_id, period);
        const totalOverage = overages.reduce((s, o) => s + o.total, 0);
        if (totalOverage <= 0.50) continue; // skip tiny amounts

        const user = db.prepare("SELECT stripe_customer_id, email FROM users WHERE id = ?").get(user_id);
        if (!user?.stripe_customer_id) continue;

        const invoice = await getStripe().invoices.create({
          customer: user.stripe_customer_id,
          auto_advance: true,
          collection_method: "charge_automatically",
          metadata: { mine_user: user_id, mine_period: period, type: "overage" },
        });

        for (const o of overages) {
          await getStripe().invoiceItems.create({
            customer: user.stripe_customer_id,
            invoice: invoice.id,
            amount: Math.round(o.total * 100),
            currency: "usd",
            description: `MINE Overage — ${METRIC_NAMES[o.metric] || o.metric}: ${o.qty} × $${(o.total / o.qty).toFixed(2)} (${period})`,
          });
        }

        await getStripe().invoices.finalizeInvoice(invoice.id);
        await getStripe().invoices.pay(invoice.id);
        db.prepare("UPDATE overage_charges SET status = 'billed' WHERE user_id = ? AND period = ? AND status = 'pending'").run(user_id, period);
        billed++;
      } catch(e) { console.error("[/bill-overages-all]", e.message || e); }
    }

    res.json({ billed, period });
  } catch(e) {
    console.error("[Payments]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;

// ─────────────────────────────────────────────────────────────────────────────
// COURSE CHECKOUT — creates a Stripe session for course purchase
// POST /api/payments/course-checkout
// Body: { courseId, customerEmail, customerName, successUrl, cancelUrl }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/course-checkout", async (req, res) => {
  try {
    const { courseId, customerEmail, customerName, successUrl, cancelUrl } = req.body;
    if (!courseId || !customerEmail) return res.status(400).json({ error: "courseId and customerEmail are required" });

    const db = getDb();

    // Load course + site owner
    const course = db.prepare("SELECT * FROM courses WHERE id = ?").get(courseId);
    if (!course) return res.status(404).json({ error: "Course not found" });
    if (course.status && course.status !== "published") return res.status(400).json({ error: "Course is not available" });

    const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(course.site_id);
    if (!site) return res.status(404).json({ error: "Site not found" });

    const owner = db.prepare("SELECT stripe_connect_id, plan, origin FROM users WHERE id = ?").get(site.user_id);
    if (!owner?.stripe_connect_id) return res.status(400).json({ error: "Store not set up for payments" });

    // Check if already enrolled
    db.exec("CREATE TABLE IF NOT EXISTS enrollments (id TEXT PRIMARY KEY, course_id TEXT, student_email TEXT, student_name TEXT, amount_paid REAL, stripe_session_id TEXT, access_token TEXT, created_at TEXT DEFAULT (datetime('now')))");
    const existing = db.prepare("SELECT id FROM enrollments WHERE course_id = ? AND student_email = ?").get(courseId, customerEmail.toLowerCase());
    if (existing) return res.status(400).json({ error: "Already enrolled", enrolled: true });

    const priceInCents = Math.round((course.price || 0) * 100);
    if (priceInCents === 0) {
      // Free course — enroll directly, no payment needed
      const { v4: freeUuid } = require("uuid");
      const token = freeUuid().replace(/-/g, "");
      db.prepare("INSERT INTO enrollments (id, course_id, student_email, student_name, amount_paid, access_token) VALUES (?,?,?,?,0,?)")
        .run(freeUuid(), courseId, customerEmail.toLowerCase(), customerName || "", token);
      const accessUrl = `${process.env.FRONTEND_URL || "https://takeova.ai"}/api/public/portal/${token}`;
      return res.json({ free: true, accessUrl, enrolled: true });
    }

    const platformFee = Math.round(priceInCents * (getFeeForPlan(owner.plan, owner.origin) / 100));

    const session = await getStripe().checkout.sessions.create({
      mode: "payment",
      customer_email: customerEmail,
      line_items: [{
        price_data: {
          currency: (course.currency || "usd").toLowerCase(),
          product_data: { name: course.title || "Course", description: course.description || undefined },
          unit_amount: priceInCents,
        },
        quantity: 1,
      }],
      payment_intent_data: {
        application_fee_amount: platformFee,
        transfer_data: { destination: owner.stripe_connect_id },
      },
      success_url: successUrl || `${process.env.FRONTEND_URL || "https://takeova.ai"}/api/public/order-complete?session={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || (site.domain ? `https://${site.domain}/courses` : `${process.env.FRONTEND_URL || "https://takeova.ai"}/courses`),
      metadata: {
        mine_course: courseId,
        mine_site: course.site_id,
        mine_user: site.user_id,
        student_email: customerEmail.toLowerCase(),
        student_name: customerName || "",
        course_title: course.title || "",
      },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (e) {
    console.error("[course-checkout]", e.message);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// COURSE ACCESS — get student portal URL after purchase
// GET /api/payments/course-access/:token
// ─────────────────────────────────────────────────────────────────────────────
router.get("/course-access/:token", async (req, res) => {
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS enrollments (id TEXT PRIMARY KEY, course_id TEXT, student_email TEXT, student_name TEXT, amount_paid REAL, stripe_session_id TEXT, access_token TEXT, created_at TEXT DEFAULT (datetime('now')))");
  const enrollment = db.prepare("SELECT * FROM enrollments WHERE access_token = ?").get(req.params.token);
  if (!enrollment) return res.status(404).json({ error: "Invalid access token" });
  const course = db.prepare("SELECT * FROM courses WHERE id = ?").get(enrollment.course_id);
  res.json({ enrollment, course });
});
