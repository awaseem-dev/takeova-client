// ═══════════════════════════════════════════════════════════════════
// MINE — Admin Bypass Helper
//
// Centralised "is this user a platform admin?" check used by every
// limit/cap enforcement across MINE. Admin (role='admin') runs MINE
// itself — capping the platform operator is silly and prevents the
// "MINE-promotes-MINE" marketing flywheel:
//
//   admin uses AI Site Builder → builds takeova.ai
//   admin hires AI Social Manager → posts MINE updates daily
//   admin hires AI Sales Rep → follows up MINE trial signups
//   admin hires AI Browser Agent → competitor pricing intel
//   admin hires AI Bookkeeper → categorises MINE revenue
//   admin hires MineControl → daily MINE briefing
//
// What admin DOES bypass:
//   - email_limit / emails_sent caps
//   - ai_edits_used caps
//   - Browser Agent monthly task caps
//   - AI employee $79/mo addon billing (auto-hired free)
//   - Plan tier gates (starter, growth, pro, enterprise)
//
// What admin does NOT bypass (safety still applies):
//   - Credential vault bank blocklist (legal risk regardless of role)
//   - Browser Agent forbidden-pattern filter
//   - Browser Agent max actions per task (cost control)
//   - System prompt safety rules
//   - Rate limits intended to prevent platform abuse
// ═══════════════════════════════════════════════════════════════════

function isAdmin(db, userId) {
  if (!userId) return false;
  try {
    const row = db.prepare("SELECT role FROM users WHERE id = ?").get(userId);
    return !!(row && row.role === "admin");
  } catch (_) {
    return false;
  }
}

module.exports = { isAdmin };
