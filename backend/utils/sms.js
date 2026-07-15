/**
 * MINE SMS Sender Utility
 *
 * Handles Twilio SMS sending with automatic alphanumeric sender ID support.
 *
 * Alphanumeric sender IDs (e.g. "SmithDental" instead of +1234567890):
 *   - Supported: UK, Australia, most of Europe, many Asia-Pacific countries
 *   - NOT supported: USA, Canada, Mexico (regulatory restriction)
 *   - Max 11 characters, letters and numbers only, no spaces
 *
 * Logic:
 *   1. If recipient number starts with +1 (US/Canada) → always use platform phone number
 *   2. Otherwise → use user's sms_sender_name if set, else platform SMS_SENDER_NAME, else phone number
 */

const { getSetting } = require("../db/init");

/**
 * Detect if a phone number is US/Canada (+1 prefix)
 * These countries don't support alphanumeric sender IDs
 */
function isNorthAmerica(phone) {
  const cleaned = phone.replace(/\s/g, "");
  return cleaned.startsWith("+1") || /^1[2-9]\d{9}$/.test(cleaned);
}

/**
 * Sanitise a sender name for alphanumeric use:
 * - Max 11 chars
 * - Letters and numbers only (no spaces, punctuation, special chars)
 * - Must start with a letter
 */
function sanitiseSenderName(name) {
  if (!name) return null;
  const clean = name
    .replace(/[^a-zA-Z0-9]/g, "")  // letters and numbers only
    .slice(0, 11);
  // Must start with a letter (Twilio requirement)
  if (!clean || !/^[a-zA-Z]/.test(clean)) return null;
  return clean;
}

/**
 * Get the FROM value for a Twilio SMS send.
 * @param {string} recipientPhone - The recipient's phone number (E.164 format)
 * @param {string|null} userSenderName - The user's configured sender name (from users.sms_sender_name)
 * @returns {string} The FROM value to use — either alphanumeric name or phone number
 */
function getSmsSender(recipientPhone, userSenderName = null) {
  const platformPhone   = getSetting("TWILIO_PHONE_NUMBER") || process.env.TWILIO_PHONE_NUMBER || "";
  const platformSender  = getSetting("SMS_SENDER_NAME")     || process.env.SMS_SENDER_NAME     || null;

  // US/Canada: alphanumeric not supported — always use phone number
  if (isNorthAmerica(recipientPhone)) {
    return platformPhone;
  }

  // Try user's sender name first, then platform-wide name, then phone number
  const preferred = sanitiseSenderName(userSenderName) || sanitiseSenderName(platformSender);
  return preferred || platformPhone;
}

/**
 * Send an SMS via Twilio with automatic sender selection.
 * @param {object} params
 * @param {string} params.to - Recipient phone (E.164)
 * @param {string} params.body - Message body (max 1600 chars)
 * @param {string|null} params.userSenderName - User's configured sender name
 * @param {Function} params.fetch - node-fetch instance
 * @returns {Promise<boolean>} true if sent successfully
 */
async function sendSms({ to, body, userSenderName = null, fetch }) {
  const sid   = getSetting("TWILIO_ACCOUNT_SID")  || process.env.TWILIO_ACCOUNT_SID;
  const token = getSetting("TWILIO_AUTH_TOKEN")    || process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error("Twilio credentials not configured");

  const from = getSmsSender(to, userSenderName);
  const cleaned = to.replace(/\s/g, "");

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        "Authorization": "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: from, To: cleaned, Body: body.slice(0, 1600) }),
    }
  );

  return res.status < 300;
}

module.exports = { sendSms, getSmsSender, sanitiseSenderName, isNorthAmerica };
