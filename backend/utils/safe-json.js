// ═══════════════════════════════════════════════════════════════════════════
// Safe JSON Parse Helper
// ═══════════════════════════════════════════════════════════════════════════
// Drop-in replacement for JSON.parse that returns a default value instead of
// throwing on malformed input. Used at call sites that parse:
//   - AI model responses (Claude can return non-JSON despite instructions)
//   - Stored DB JSON columns (possibly written by older buggy code paths)
//   - External API responses
//
// Usage:
//   const { safeJsonParse } = require("./utils/safe-json");
//   const data = safeJsonParse(rawString, {});  // default to empty object
//   const list = safeJsonParse(maybeJson, []);  // default to empty array
// ═══════════════════════════════════════════════════════════════════════════
function safeJsonParse(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value; // already parsed
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch (e) {
    // Log at debug level — caller decides whether to surface further
    if (process.env.LOG_SAFE_JSON === "1") {
      console.warn("[safeJsonParse] parse failed:", e.message, "value:", String(value).slice(0, 80));
    }
    return fallback;
  }
}

module.exports = { safeJsonParse };
