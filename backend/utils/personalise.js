/**
 * personalise.js — Claude-powered personalised message generation
 * Used by cron jobs and AI employees to replace generic templates
 * with context-aware, customer-specific messages
 */

const { getSetting } = require("../db/init");

const TONE_MAP = {
  professional: "professional, clear, and polite",
  friendly:     "warm, friendly, and approachable",
  casual:       "casual and conversational",
  urgent:       "helpful but with a sense of urgency",
};

/**
 * Generate a personalised message for a customer scenario
 * @param {Object} opts
 * @param {string} opts.scenario - "winback" | "review_request" | "cart_recovery" | "appointment_reminder" | "invoice_chase" | "followup"
 * @param {Object} opts.customer - { name, last_purchase, last_visit, total_spent, ... }
 * @param {Object} opts.business - { name, type, owner_name }
 * @param {string} opts.channel  - "sms" | "email" | "whatsapp"
 * @param {string} opts.tone     - "professional" | "friendly" | "casual" | "urgent"
 * @returns {Promise<{subject?: string, body: string}>}
 */
async function personaliseMessage(opts) {
  const { scenario, customer, business, channel = "sms", tone = "friendly" } = opts;

  const apiKey = getSetting("ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { body: buildFallbackMessage(scenario, customer, business) };

  const channelGuide = {
    sms:      "SMS — max 160 chars, no markdown, conversational",
    email:    "Email — include a subject line, can be 2-3 short paragraphs, professional HTML-safe",
    whatsapp: "WhatsApp — can be 2-3 sentences, emojis ok, conversational",
  };

  const scenarioPrompts = {
    winback:              `${customer.name} was a regular customer at ${business.name} but hasn't visited in ${customer.weeks_inactive || "several"} weeks. Their last purchase was ${customer.last_purchase || "some time ago"}. Write a warm win-back message that feels personal, not automated. Mention their history if available. Include a clear but soft call to action.`,
    review_request:       `${customer.name} just completed a service/purchase at ${business.name}. Write a brief, genuine review request. Don't be pushy. Make it easy to say yes. If they're a repeat customer (${customer.visit_count || 1} visits), acknowledge that.`,
    cart_recovery:        `${customer.name} added items to their cart at ${business.name} but didn't complete checkout. The items were: ${customer.cart_items || "some products"}. Write a helpful reminder — not salesy. Maybe they just got distracted.`,
    appointment_reminder: `${customer.name} has an appointment at ${business.name} on ${customer.appointment_date || "soon"} at ${customer.appointment_time || ""}. Write a friendly reminder. Include any prep instructions if relevant: ${customer.prep_notes || "none"}.`,
    invoice_chase:        `${customer.name} has an overdue invoice for $${customer.invoice_amount || ""} at ${business.name}, ${customer.days_overdue || "some"} days overdue. Write a polite but clear payment reminder. Keep it professional. Don't guilt-trip.`,
    followup:             `${customer.name} enquired about ${customer.enquiry_topic || "your services"} at ${business.name}. They haven't converted yet. Write a personalised follow-up. Reference their specific enquiry if available.`,
  };

  const prompt = `${scenarioPrompts[scenario] || scenarioPrompts.followup}

Business tone: ${TONE_MAP[tone] || TONE_MAP.friendly}
Channel: ${channelGuide[channel] || channelGuide.sms}
Business name: ${business.name}

${channel === "email" ? 'Return JSON: {"subject": "...", "body": "..."}' : 'Return JSON: {"body": "..."}'}
Return ONLY valid JSON, no explanation.`;

  try {
    const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json();
    const text = data.content?.[0]?.text || "";
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    return parsed;
  } catch(e) {
    console.error("[personalise] Claude API error:", e.message);
    return { body: buildFallbackMessage(scenario, customer, business) };
  }
}

function buildFallbackMessage(scenario, customer, business) {
  const name = customer.name?.split(" ")[0] || "there";
  const biz = business.name || "us";
  const fallbacks = {
    winback:              `Hi ${name}, we miss you at ${biz}! It's been a while — come back and see us soon 😊`,
    review_request:       `Hi ${name}, thank you for visiting ${biz}! We'd love to hear your feedback. Would you mind leaving us a quick review?`,
    cart_recovery:        `Hi ${name}, you left something behind at ${biz}! Complete your order whenever you're ready.`,
    appointment_reminder: `Hi ${name}, just a reminder about your upcoming appointment at ${biz}. See you soon!`,
    invoice_chase:        `Hi ${name}, this is a friendly reminder that your invoice with ${biz} is now due. Please let us know if you have any questions.`,
    followup:             `Hi ${name}, following up on your recent enquiry with ${biz}. Happy to help — just reply to this message.`,
  };
  return fallbacks[scenario] || fallbacks.followup;
}

module.exports = { personaliseMessage };
