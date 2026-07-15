// ═══════════════════════════════════════════════════════════════════════════
// Baseline Rule Enforcement — checks working hours, approval rules, brand voice, KB
// ═══════════════════════════════════════════════════════════════════════════
//
// Usage at the top of any agent case block in ai-employees.js:
//
//   const { _checkBaseline } = require("./baseline-enforcement");
//   const baseline = _checkBaseline(db, userId, role, action, context);
//   if (baseline.block) {
//     recordOutcome(actionId, userId, role, action, "blocked",
//                   { reason: baseline.reason, _outcome_recorded: true });
//     return { sent: false, blocked: true, reason: baseline.reason, _outcome_recorded: true };
//   }
//   // Use baseline.brandVoice, baseline.kbFileIds, baseline.config in your prompts
// ═══════════════════════════════════════════════════════════════════════════

function _loadConfig(db, userId, role) {
  try {
    const row = db.prepare("SELECT rules, business_context, brand_voice, email_signature, policies FROM ai_employees WHERE user_id = ? AND role = ?")
      .get(userId, role);
    if (!row) return null;
    let rules = {};
    try { rules = JSON.parse(row.rules || "{}"); } catch {}
    return {
      ...rules,
      _businessContext: row.business_context || "",
      _brandVoice: row.brand_voice || rules.brandVoice || "",
      _emailSignature: row.email_signature || "",
      _policies: row.policies || "",
    };
  } catch { return null; }
}

// Working hours check — returns {inside: bool, reason?: string}
function _checkWorkingHours(config, now = new Date()) {
  const mode = config.hoursMode || "24-7";
  if (mode === "24-7") return { inside: true };

  // Skip weekends?
  if (config.skipWeekends) {
    const day = now.getDay(); // 0 = Sun, 6 = Sat
    if (day === 0 || day === 6) {
      return { inside: false, reason: "outside hours: weekend" };
    }
  }

  if (mode === "business") {
    const hour = now.getHours();
    if (hour < 9 || hour >= 18) {
      return { inside: false, reason: "outside hours: business hours (9am-6pm)" };
    }
    return { inside: true };
  }

  if (mode === "custom") {
    const start = config.hoursStart || "09:00";
    const end = config.hoursEnd || "18:00";
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    const minsNow = now.getHours() * 60 + now.getMinutes();
    const minsStart = (sh || 0) * 60 + (sm || 0);
    const minsEnd = (eh || 23) * 60 + (em || 59);
    if (minsNow < minsStart || minsNow >= minsEnd) {
      return { inside: false, reason: `outside hours: custom window ${start}-${end}` };
    }
    return { inside: true };
  }

  return { inside: true };
}

// Approval rules check — returns {needsApproval: bool, reason?: string}
function _checkApprovalRules(config, action, context = {}) {
  // VIP customer rule
  if (config.approveVip) {
    const isVip = context.contact?.tags?.includes?.("vip") ||
                  context.contact?.lifetime_value > 5000 ||
                  context.contact?.purchase_count >= 3;
    if (isVip) {
      return { needsApproval: true, reason: "VIP customer — approval rule triggered" };
    }
  }

  // Refund / credit rule
  if (config.approveRefunds) {
    const isRefund = /refund|credit|chargeback/i.test(action || "") ||
                     /refund|credit/i.test(JSON.stringify(context).toLowerCase());
    if (isRefund) {
      return { needsApproval: true, reason: "Refund/credit action — approval rule triggered" };
    }
  }

  // Spend threshold rule
  if (config.approveBigSpend) {
    const threshold = parseFloat(config.approveThreshold || "500");
    const amount = parseFloat(context.amount || context.spend || context.value || 0);
    if (amount > threshold) {
      return { needsApproval: true, reason: `Spend $${amount} exceeds threshold $${threshold}` };
    }
  }

  return { needsApproval: false };
}

// Knowledge base file IDs available to this agent
function _getKBFileIds(db, userId, role) {
  try {
    const rows = db.prepare("SELECT file_id FROM ai_files WHERE user_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 10")
      .all(userId, role);
    return rows.map(r => r.file_id);
  } catch { return []; }
}

// Main entry point — called at top of every agent action handler
function _checkBaseline(db, userId, role, action, context = {}) {
  const config = _loadConfig(db, userId, role);
  if (!config) return { ok: true, config: {}, brandVoice: "", kbFileIds: [] };

  // 1. Working hours
  const hours = _checkWorkingHours(config);
  if (!hours.inside) {
    return {
      block: true,
      blockType: "outside_hours",
      reason: hours.reason,
      shouldQueue: true,  // queue for retry when hours start
      config,
    };
  }

  // 2. Approval rules
  const approval = _checkApprovalRules(config, action, context);
  if (approval.needsApproval) {
    return {
      block: true,
      blockType: "needs_approval",
      reason: approval.reason,
      shouldEscalate: true,
      config,
    };
  }

  // 3. Pass through — return config + KB file IDs for the agent to use
  return {
    ok: true,
    config,
    brandVoice: config._brandVoice || "",
    businessContext: config._businessContext || "",
    emailSignature: config._emailSignature || "",
    policies: config._policies || "",
    kbFileIds: _getKBFileIds(db, userId, role),
  };
}

// Helper: build a system-prompt prefix from baseline config
// Use this in agents that call Claude — prepend to the existing system prompt.
function _buildBaselinePrompt(baseline) {
  const parts = [];
  if (baseline.brandVoice) {
    parts.push(`BRAND VOICE: ${baseline.brandVoice}`);
  }
  if (baseline.businessContext) {
    parts.push(`BUSINESS CONTEXT: ${baseline.businessContext}`);
  }
  if (baseline.policies) {
    parts.push(`POLICIES: ${baseline.policies}`);
  }
  if (baseline.emailSignature) {
    parts.push(`SIGN OFF AS: ${baseline.emailSignature}`);
  }
  return parts.length > 0 ? parts.join("\n\n") + "\n\n" : "";
}

module.exports = {
  _checkBaseline,
  _loadConfig,
  _checkWorkingHours,
  _checkApprovalRules,
  _getKBFileIds,
  _buildBaselinePrompt,
};
