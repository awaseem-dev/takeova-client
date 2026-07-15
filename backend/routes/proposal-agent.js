/**
 * TAKEOVA AI Proposal Agent — v2
 * Generate -> Send -> Track Opens -> Follow Up -> Pipeline -> Win/Lose
 * Billing: $49/mo add-on · $0.40 per proposal generated
 */

const express  = require("express");
const router   = express.Router();
const { v4: uuid } = require("uuid");
const { getDb, getSetting } = require("../db/init");
const { auth } = require("../middleware/auth");
// Per-tenant agent outcome tracking (safe-loaded; no-op if enhancements unmounted)
let _enh; try { _enh = require("./ai-employees-enhancements"); } catch (_) { _enh = null; }
const recordOutcome = (_enh && _enh.recordOutcome) ? _enh.recordOutcome : function(){};
const rateLimit = require("express-rate-limit");
const crypto   = require("crypto");

const proposalAgentLimiter = rateLimit({ windowMs: 60_000, max: 10, keyGenerator: r => r.userId || r.ip });
const PROPOSAL_PRICE = 0.40;

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS proposal_agent_jobs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      prospect_url TEXT, prospect_name TEXT, prospect_email TEXT,
      prospect_scraped TEXT, proposal_id TEXT,
      status TEXT DEFAULT 'pending', error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      client_name TEXT, client_email TEXT,
      description TEXT, services TEXT, amount REAL,
      status TEXT DEFAULT 'draft',
      html TEXT, pdf_url TEXT,
      opened_at TEXT, signed_at TEXT, expires_at TEXT,
      follow_up_count INTEGER DEFAULT 0,
      view_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  ["prospect_email","expires_at","view_count","updated_at"].forEach(function(c) {
    try { db.exec("ALTER TABLE proposals ADD COLUMN " + c + " " + (c.includes("count") ? "INTEGER DEFAULT 0" : "TEXT")); } catch(e) {}
  });
  try { db.exec("ALTER TABLE proposal_agent_jobs ADD COLUMN prospect_email TEXT"); } catch(e) {}
}

function hasAddon(db, userId) {
  try {
    // Newer system: ai_employee_subscriptions table (Stripe-managed)
    const newSys = db.prepare(
      "SELECT id FROM ai_employee_subscriptions WHERE user_id=? AND employee_id IN ('proposal','proposal_agent') AND status='active'"
    ).get(userId);
    if (newSys) return true;
    // Legacy: user_addons (still in production for some users)
    return !!db.prepare("SELECT id FROM user_addons WHERE user_id=? AND addon_id='proposal_agent' AND status='active'").get(userId);
  } catch(e) { return false; }
}

function hmac(id) {
  // Dedicated key first so internal-key rotations don't invalidate sent proposal links.
  // Falls back to INTERNAL_API_KEY then JWT_SECRET for back-compat with existing tokens.
  const key = process.env.PROPOSAL_SIGNING_KEY || process.env.INTERNAL_API_KEY || process.env.JWT_SECRET || "dev";
  return crypto.createHmac("sha256", key).update(id).digest("hex");
}

// GET /settings
router.get("/settings", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const user = db.prepare("SELECT plan, role FROM users WHERE id=?").get(req.userId);
  const period = new Date().toISOString().slice(0, 7);
  const used = db.prepare("SELECT COUNT(*) as c FROM proposal_agent_jobs WHERE user_id=? AND status='complete' AND strftime('%Y-%m',created_at)=?").get(req.userId, period)?.c || 0;
  const jobs = db.prepare("SELECT paj.*, p.status as proposal_status, p.opened_at, p.signed_at, p.expires_at, p.view_count, p.follow_up_count, p.amount FROM proposal_agent_jobs paj LEFT JOIN proposals p ON p.id=paj.proposal_id WHERE paj.user_id=? ORDER BY paj.created_at DESC LIMIT 50").all(req.userId);
  res.json({ plan: user?.plan, isAdmin: user?.role==="admin", hasAddon: hasAddon(db, req.userId), used, pricePerProposal: PROPOSAL_PRICE, addonPrice: 49, jobs });
});

// GET /pipeline
router.get("/pipeline", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const proposals = db.prepare("SELECT * FROM proposals WHERE user_id=? ORDER BY created_at DESC LIMIT 100").all(req.userId);
  const pipeline = { draft: [], sent: [], viewed: [], won: [], lost: [] };
  proposals.forEach(p => {
    const status = p.signed_at ? "won" : (p.status || "draft");
    (pipeline[status] || pipeline.draft).push(p);
  });
  const sent_viewed = pipeline.sent.length + pipeline.viewed.length;
  const stats = {
    total: proposals.length,
    sent: sent_viewed,
    won: pipeline.won.length,
    value: pipeline.won.reduce((s, p) => s + (p.amount || 0), 0),
    openRate: sent_viewed > 0 ? Math.round((proposals.filter(p => p.opened_at).length / sent_viewed) * 100) : 0,
    conversionRate: sent_viewed > 0 ? Math.round((pipeline.won.length / sent_viewed) * 100) : 0,
  };
  res.json({ pipeline, stats });
});

// POST /generate
router.post("/generate", auth, proposalAgentLimiter, async (req, res) => {
  const db = getDb();
  ensureTables(db);
  const user = db.prepare("SELECT plan, role FROM users WHERE id=?").get(req.userId);
  if (user?.role !== "admin" && !hasAddon(db, req.userId))
    return res.status(403).json({ error: "AI Proposal Agent requires the add-on ($49/mo).", upgrade: true });

  const { prospectUrl, prospectName, prospectEmail, yourServices, yourBusinessName, tone = "professional", expiryDays = 14, autoSend = false } = req.body;
  if (!prospectName) return res.status(400).json({ error: "Prospect name required" });

  const jobId = uuid();
  db.prepare("INSERT INTO proposal_agent_jobs (id,user_id,prospect_url,prospect_name,prospect_email,status) VALUES (?,?,?,?,?,?)")
    .run(jobId, req.userId, prospectUrl || null, prospectName, prospectEmail || null, "running");

  res.json({ success: true, jobId });

  runAgent(db, req.userId, jobId, { prospectUrl, prospectName, prospectEmail, yourServices, yourBusinessName, tone, expiryDays, autoSend, isAdmin: user?.role === "admin" }).catch(e => {
    console.error("[ProposalAgent]", e.message);
    db.prepare("UPDATE proposal_agent_jobs SET status='failed', error=? WHERE id=?").run(e.message, jobId);
    try { recordOutcome(uuid(), req.userId, 'proposal', 'generate_proposal', 'failed', { job_id: jobId, error: String(e.message||'').slice(0,200) }); } catch(_){}
  });
});

async function runAgent(db, userId, jobId, opts) {
  const fetch = (await import("node-fetch")).default;
  const { prospectUrl, prospectName, prospectEmail, yourServices, yourBusinessName, tone, expiryDays, autoSend, isAdmin } = opts;

  const claudeKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
  if (!claudeKey) throw new Error("ANTHROPIC_API_KEY not configured");

  // Scrape
  let prospectContext = "";
  if (prospectUrl) {
    try {
      const r = await fetch(prospectUrl, { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0" } });
      const html = await r.text();
      prospectContext = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 3000);
      db.prepare("UPDATE proposal_agent_jobs SET prospect_scraped=? WHERE id=?").run(prospectContext.slice(0, 500), jobId);
    } catch(e) { console.error("[/generate]", e.message || e); }
  }

  const site = db.prepare("SELECT name, domain FROM sites WHERE user_id=? LIMIT 1").get(userId);
  const products = db.prepare("SELECT name, price, description FROM products WHERE user_id=? LIMIT 10").all(userId);
  const userRow = db.prepare("SELECT name, outreach_display_name FROM users WHERE id=?").get(userId);
  const bizName = yourBusinessName || site?.name || "My Business";
  const senderName = userRow?.outreach_display_name || userRow?.name || bizName;
  const serviceList = yourServices || products.map(p => p.name + " ($" + p.price + ")").join(", ") || "Professional services";
  const expiryDate = new Date(Date.now() + (expiryDays || 14) * 86400000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  const prompt = "You are an expert business proposal writer. Generate a complete, professional, personalised HTML proposal.\n\nSENDER:\n- Name: " + senderName + "\n- Business: " + bizName + "\n- Services: " + serviceList + "\n- Tone: " + tone + "\n\nPROSPECT:\n- Name/Company: " + prospectName + (prospectUrl ? "\n- Website: " + prospectUrl : "") + (prospectContext ? "\n- Website content: " + prospectContext.slice(0, 1500) : "") + "\n\nRequirements:\n1. Show understanding of THEIR specific business and industry\n2. Reference specific things from their website\n3. Frame services as solutions to THEIR challenges\n4. Include realistic pricing\n5. Add urgency: This proposal expires " + expiryDate + "\n6. CTA: Sign and Accept button\n\nStructure: Header, Opening, Executive Summary, Their Needs, Solution, Scope, Investment table, Timeline, Why Us, Expiry banner (red), CTA, Signature.\nDesign: Dark navy header #0F172A, purple accent #2563EB, white body.\nReturn ONLY complete HTML. No markdown.";

  const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": claudeKey, "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 4096, messages: [{ role: "user", content: prompt }] })
  });
  const aiData = await aiRes.json();
  const html = aiData.content?.[0]?.text || "<p>Generation failed</p>";

  const proposalId = uuid();
  const expiresAt = new Date(Date.now() + (expiryDays || 14) * 86400000).toISOString();

  db.prepare("INSERT INTO proposals (id,user_id,client_name,client_email,description,services,amount,html,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))")
    .run(proposalId, userId, prospectName, prospectEmail || "", "Proposal for " + prospectName, serviceList, 0, html, expiresAt);

  db.prepare("UPDATE proposal_agent_jobs SET status='complete', proposal_id=? WHERE id=?").run(proposalId, jobId);
  try { recordOutcome(proposalId, userId, 'proposal', 'generate_proposal', 'no_response', { proposal_id: proposalId, job_id: jobId }); } catch(_){}

  if (!isAdmin) {
    try {
      const period = new Date().toISOString().slice(0, 7);
      db.prepare("INSERT INTO overage_charges (id,user_id,metric,quantity,unit_price,total,period,status) VALUES (?,?,?,?,?,?,?,?)")
        .run(uuid(), userId, "aiProposals", 1, PROPOSAL_PRICE, PROPOSAL_PRICE, period, "pending");
    } catch(e) {}
  }

  if (autoSend && prospectEmail) {
    try { await sendProposalEmail(db, userId, proposalId); } catch(e) { console.error("[ProposalAgent] Auto-send:", e.message); }
  }
}

// POST /send/:proposalId
router.post("/send/:proposalId", auth, async (req, res) => {
  const db = getDb();
  ensureTables(db);
  const proposal = db.prepare("SELECT * FROM proposals WHERE id=? AND user_id=?").get(req.params.proposalId, req.userId);
  if (!proposal) return res.status(404).json({ error: "Proposal not found" });
  if (!proposal.client_email) return res.status(400).json({ error: "No email address. Add one first." });
  try {
    await sendProposalEmail(db, req.userId, req.params.proposalId);
    res.json({ success: true });
  } catch(e) {
    console.error("[/send/:proposalId]", e?.message || e); res.status(500).json({ error: "An internal error occurred" });
  }
});

async function sendProposalEmail(db, userId, proposalId) {
  const proposal = db.prepare("SELECT * FROM proposals WHERE id=?").get(proposalId);
  const site = db.prepare("SELECT name FROM sites WHERE user_id=? LIMIT 1").get(userId);
  const user = db.prepare("SELECT name, sender_email FROM users WHERE id=?").get(userId);
  const sgKey = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
  if (!sgKey) throw new Error("Email not configured — add SENDGRID_API_KEY in Settings");

  const pixelToken = hmac(proposalId).slice(0, 24);
  const viewToken  = hmac(proposalId).slice(0, 32);
  const backendUrl = process.env.BACKEND_URL || "https://api.takeova.ai";
  const viewUrl    = backendUrl + "/api/payments/proposals/" + proposalId + "/view?t=" + viewToken;
  const fromEmail  = user?.sender_email || getSetting("EMAIL_FROM") || "hello@takeova.ai";
  const fromName   = site?.name || user?.name || "Business";

  const expiryNote = proposal.expires_at
    ? "<div style=\"background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:12px;text-align:center;margin:16px 0;font-size:13px;color:#991B1B;\">This proposal expires on <strong>" + new Date(proposal.expires_at).toLocaleDateString("en-GB", { day:"numeric", month:"long", year:"numeric" }) + "</strong></div>"
    : "";

  const fetch = (await import("node-fetch")).default;
  const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: proposal.client_email, name: proposal.client_name }] }],
      from: { email: fromEmail, name: fromName },
      subject: "Proposal for " + proposal.client_name + " from " + fromName,
      content: [{ type: "text/html", value:
        "<div style=\"font-family:system-ui,sans-serif;max-width:680px;margin:0 auto;padding:24px\">" +
        "<div style=\"text-align:center;margin-bottom:20px\"><div style=\"font-size:22px;font-weight:800;color:#0F172A\">" + fromName + "</div><div style=\"color:#64748B;margin-top:4px\">has sent you a proposal</div></div>" +
        expiryNote +
        "<div style=\"text-align:center;margin:24px 0\"><a href=\"" + viewUrl + "\" style=\"background:linear-gradient(135deg,#2563EB,#4F46E5);color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block\">View &amp; Sign Proposal</a></div>" +
        proposal.html +
        "<img src=\"" + backendUrl + "/api/payments/proposals/" + proposalId + "/pixel?t=" + pixelToken + "\" width=\"1\" height=\"1\" alt=\"\"></div>"
      }]
    })
  });
  if (!_sgResp.ok) {
    let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
    console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
  }

  db.prepare("UPDATE proposals SET status='sent', updated_at=datetime('now') WHERE id=?").run(proposalId);
}

// POST /followup/:proposalId
router.post("/followup/:proposalId", auth, async (req, res) => {
  const db = getDb();
  ensureTables(db);
  const proposal = db.prepare("SELECT * FROM proposals WHERE id=? AND user_id=?").get(req.params.proposalId, req.userId);
  if (!proposal) return res.status(404).json({ error: "Not found" });
  if ((proposal.follow_up_count || 0) >= 3) return res.status(400).json({ error: "Maximum 3 follow-ups reached" });

  const site = db.prepare("SELECT name FROM sites WHERE user_id=? LIMIT 1").get(req.userId);
  const sgKey = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
  if (!sgKey) return res.status(400).json({ error: "Email not configured" });

  const fromName = site?.name || "The team";
  const backendUrl = process.env.BACKEND_URL || "https://api.takeova.ai";
  const viewToken = hmac(proposal.id).slice(0, 32);
  const viewUrl   = backendUrl + "/api/payments/proposals/" + proposal.id + "/view?t=" + viewToken;
  const isViewed  = !!proposal.opened_at;
  const firstName = (proposal.client_name || "there").split(" ")[0];

  const subject = isViewed
    ? "Any questions about our proposal, " + firstName + "?"
    : "Quick follow-up on our proposal, " + firstName;
    const body = isViewed
    ? "Hi " + proposal.client_name + ",\n\nI noticed you had a chance to look at the proposal. Happy to answer any questions or adjust anything before we move forward.\n\nView proposal: " + viewUrl + "\n\nBest,\n" + fromName
    : "Hi " + proposal.client_name + ",\n\nJust following up on the proposal I sent. Let me know if you'd like to jump on a quick call.\n\nView proposal: " + viewUrl + "\n\nBest,\n" + fromName;

  try {
    const fetch = (await import("node-fetch")).default;
    const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { "Authorization": "Bearer " + sgKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: proposal.client_email, name: proposal.client_name }] }],
        from: { email: getSetting("EMAIL_FROM") || "hello@takeova.ai", name: fromName },
        subject,
        content: [{ type: "text/plain", value: body }]
      })
    });
    if (!_sgResp.ok) {
      let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
      console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
    }
    db.prepare("UPDATE proposals SET follow_up_count=follow_up_count+1, updated_at=datetime('now') WHERE id=?").run(proposal.id);
    res.json({ success: true, followUpCount: (proposal.follow_up_count || 0) + 1 });
  } catch(e) {
    console.error("[/followup/:proposalId]", e?.message || e); res.status(500).json({ error: "An internal error occurred" });
  }
});

// PUT /proposal/:proposalId — update email, amount, status
router.put("/proposal/:proposalId", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const proposal = db.prepare("SELECT id FROM proposals WHERE id=? AND user_id=?").get(req.params.proposalId, req.userId);
  if (!proposal) return res.status(404).json({ error: "Not found" });
  const { clientEmail, amount, status } = req.body;
  const fields = [], vals = [];
  if (clientEmail !== undefined) { fields.push("client_email=?"); vals.push(clientEmail); }
  if (amount !== undefined) { fields.push("amount=?"); vals.push(parseFloat(amount) || 0); }
  if (status !== undefined) { fields.push("status=?"); vals.push(status); }
  if (!fields.length) return res.status(400).json({ error: "Nothing to update" });
  fields.push("updated_at=datetime('now')");
  vals.push(req.params.proposalId);
  db.prepare("UPDATE proposals SET " + fields.join(",") + " WHERE id=?").run(...vals);
  res.json({ success: true });
});

// GET /job/:id
router.get("/job/:id", auth, (req, res) => {
  const db = getDb();
  ensureTables(db);
  const job = db.prepare("SELECT paj.*, p.status as proposal_status, p.opened_at, p.signed_at, p.expires_at, p.view_count, p.follow_up_count, p.amount, p.client_email FROM proposal_agent_jobs paj LEFT JOIN proposals p ON p.id=paj.proposal_id WHERE paj.id=? AND paj.user_id=?").get(req.params.id, req.userId);
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json({ job });
});


// POST /api/proposal-agent/auto-followup
// Send follow-up emails to all stale sent/viewed proposals (>3 days with no response)
router.post("/auto-followup", auth, async (req, res) => {
  const db = getDb();
  try {
    ensureTables(db);
    // Find proposals that are sent or viewed, older than 3 days, no recent follow-up
    const stale = db.prepare(`
      SELECT p.* FROM proposals p
      WHERE p.user_id = ?
        AND p.status IN ('sent', 'viewed')
        AND p.updated_at < datetime('now', '-3 days')
        AND (p.last_followup_at IS NULL OR p.last_followup_at < datetime('now', '-3 days'))
      ORDER BY p.updated_at ASC
      LIMIT 20
    `).all(req.userId);

    if (stale.length === 0) return res.json({ success: true, sent: 0, message: "No stale proposals to follow up" });

    let sent = 0;
    const sgKey = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;

    for (const proposal of stale) {
      if (!proposal.client_email) continue;
      try {
        if (sgKey) {
          const fetch = (await import("node-fetch")).default;
          const user = db.prepare("SELECT name, email FROM users WHERE id = ?").get(req.userId);
          const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
            method: "POST",
            headers: { Authorization: "Bearer " + sgKey, "Content-Type": "application/json" },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: proposal.client_email, name: proposal.client_name || "" }] }],
              from: { email: (user && user.email) || "noreply@takeova.ai", name: (user && user.name) || "MINE" },
              subject: "Following up on your proposal - " + (proposal.title || "our quote"),
              content: [{ type: "text/html", value: "<p>Hi " + (proposal.client_name ? proposal.client_name.split(' ')[0] : 'there') + ",</p><p>Just following up on the proposal. Happy to answer any questions.</p><p>Best,<br>" + ((user && user.name) || "The team") + "</p>" }]
            })
          });
          if (!_sgResp.ok) {
            let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
            console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
          }
        }
        db.prepare("UPDATE proposals SET last_followup_at = datetime('now') WHERE id = ?").run(proposal.id);
        sent++;
      } catch(e) { console.error("[auto-followup]", e.message); }
    }

    res.json({ success: true, sent, total_stale: stale.length });
  } catch(e) {
    console.error("[auto-followup]", e);
    res.json({ success: true, sent: 0, message: "Follow-up queued" });
  }
});

// ─── CRON: Daily auto-followup across ALL users ────────────────────────────
// Called by the server-level cron scheduler every day at 10am.
// Protected by x-internal-key header (matches INTERNAL_API_KEY env).
// Previously this endpoint was CALLED but never DEFINED — every daily run
// hit a 404 and silently failed, so no proposal follow-ups ever went out
// from the cron. Users would sit on stale proposals indefinitely unless
// they manually triggered /auto-followup from the dashboard.
router.post("/cron/follow-ups", async (req, res) => {
  const providedKey = req.headers["x-internal-key"] || "";
  const expectedKey = process.env.INTERNAL_API_KEY || "";
  if (!expectedKey || providedKey.length !== expectedKey.length) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const crypto = require("crypto");
    const valid = crypto.timingSafeEqual(
      Buffer.from(providedKey),
      Buffer.from(expectedKey)
    );
    if (!valid) return res.status(403).json({ error: "Forbidden" });
  } catch (_) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const db = getDb();
  try {
    ensureTables(db);
    // Pull stale proposals across ALL users — the per-user /auto-followup
    // endpoint only handles one user at a time.
    const stale = db.prepare(`
      SELECT p.* FROM proposals p
      WHERE p.status IN ('sent', 'viewed')
        AND p.updated_at < datetime('now', '-3 days')
        AND (p.last_followup_at IS NULL OR p.last_followup_at < datetime('now', '-3 days'))
      ORDER BY p.updated_at ASC
      LIMIT 500
    `).all();

    if (stale.length === 0) {
      return res.json({ success: true, sent: 0, message: "No stale proposals" });
    }

    let sent = 0, failed = 0;
    const sgKey = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;

    if (!sgKey) {
      console.warn("[cron/follow-ups] No SendGrid key configured — cannot send follow-ups");
      return res.json({ success: false, sent: 0, error: "SendGrid not configured" });
    }

    const fetch = (await import("node-fetch")).default;

    for (const proposal of stale) {
      if (!proposal.client_email) continue;
      // Skip users who haven't hired the AI Proposal Agent
      if (typeof global.mineRequireHired === "function") {
        if (!global.mineRequireHired(db, proposal.user_id, "proposal")) continue;
      }
      try {
        const user = db.prepare("SELECT name, email FROM users WHERE id = ?").get(proposal.user_id);
        if (!user) continue;
        const fromEmail = user.email || "noreply@takeova.ai";
        const fromName = user.name || "MINE";
        const firstName = proposal.client_name ? String(proposal.client_name).split(" ")[0] : "there";

        const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { Authorization: "Bearer " + sgKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: proposal.client_email, name: proposal.client_name || "" }] }],
            from: { email: fromEmail, name: fromName },
            subject: "Following up on your proposal — " + (proposal.title || "our quote"),
            content: [{
              type: "text/html",
              value: "<p>Hi " + firstName + ",</p>" +
                     "<p>Just following up on the proposal I sent a few days ago. Happy to answer any questions or make changes.</p>" +
                     "<p>Best,<br>" + fromName + "</p>"
            }]
          })
        });
        if (!_sgResp.ok) {
          let errBody = ""; try { errBody = (await _sgResp.text()).slice(0, 300); } catch(_) {}
          console.error(`[cron/follow-ups] SendGrid ${_sgResp.status} for ${proposal.client_email}: ${errBody}`);
          failed++;
          continue;
        }
        db.prepare("UPDATE proposals SET last_followup_at = datetime('now') WHERE id = ?").run(proposal.id);
        sent++;
      } catch (e) {
        console.error(`[cron/follow-ups] proposal ${proposal.id}:`, e.message);
        failed++;
      }
    }

    console.log(`[cron/follow-ups] sent=${sent} failed=${failed} stale=${stale.length}`);
    res.json({ success: true, sent, failed, total_stale: stale.length });
  } catch (e) {
    console.error("[cron/follow-ups]", e);
    res.status(500).json({ error: "An internal error occurred" });
  }
});

module.exports = router;
