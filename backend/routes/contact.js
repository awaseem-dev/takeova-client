const express = require("express");
const router = express.Router();

// POST /api/contact — public contact form submissions (from landing-pages/contact.html).
// Uses the shared mailer (getTransporter) from ./email. If no mailer is configured the
// route returns 503 so the front-end's mailto fallback takes over (nothing is lost).
router.post("/", async (req, res) => {
  try {
    const { name, email, topic, message } = req.body || {};
    if (!name || !email || !message) {
      return res.status(400).json({ ok: false, error: "name, email and message are required" });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email))) {
      return res.status(400).json({ ok: false, error: "invalid email address" });
    }

    let getTransporter;
    try { ({ getTransporter } = require("./email")); } catch (_) {}
    const transporter = getTransporter && getTransporter();
    if (!transporter) {
      return res.status(503).json({ ok: false, error: "email not configured" });
    }

    const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
    const safeTopic = esc(String(topic || "Contact").slice(0, 80));
    const html =
      `<p><strong>New contact form submission</strong></p>` +
      `<p><strong>Name:</strong> ${esc(name)}<br>` +
      `<strong>Email:</strong> ${esc(email)}<br>` +
      `<strong>Topic:</strong> ${safeTopic}</p>` +
      `<p><strong>Message:</strong><br>${esc(message).replace(/\n/g, "<br>")}</p>`;

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || "noreply@takeova.ai",
      to: process.env.CONTACT_TO || "support@takeova.ai",
      replyTo: String(email),
      subject: `[Contact: ${String(topic || "Contact").slice(0, 80)}] ${name}`,
      html,
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("contact form error:", e && e.message);
    return res.status(500).json({ ok: false, error: "failed to send message" });
  }
});

module.exports = router;
