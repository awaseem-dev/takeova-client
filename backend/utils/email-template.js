// ============================================================================
// MINE — Branded transactional email template
// ----------------------------------------------------------------------------
// One on-brand shell for every transactional email (welcome, verify, reset,
// receipt, etc.) so the post-signup experience matches the marketing site and
// the product instead of the old purple/system-font look.
//
// Email clients are picky: this uses table layout + inline styles + a web-safe
// font stack (the brand face is requested, with real fallbacks for Outlook/
// Gmail which ignore web fonts). Brand colour is the MINE blue (#2563EB).
//
// USAGE
//   const { renderEmail, button } = require("../utils/email-template");
//   const html = renderEmail({
//     preheader: "Confirm your email to finish setting up MINE",
//     heading:   "Welcome to MINE",
//     intro:     `Hey ${firstName}, your account is live.`,
//     bodyHtml:  `<p style="${P}">Build your first site, set up payments, and start selling.</p>`,
//     cta:       { text: "Open your dashboard", url: dashboardUrl },
//     footerNote:"You're receiving this because you created a MINE account.",
//   });
//   // then send `html` as the text/html content via SendGrid as before.
// ============================================================================

const BRAND = {
  blue:   "#2563EB",
  blueDk: "#1D4ED8",
  ink:    "#0F172A",
  body:   "#334155",
  muted:  "#64748B",
  line:   "#E2E8F0",
  bg:     "#F1F5F9",
  card:   "#FFFFFF",
};

// Web-safe stack: brand face first, graceful fallbacks for clients without web fonts.
const FONT = "'Plus Jakarta Sans','Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// Shared inline style snippets (export so callers can style bodyHtml consistently).
const P  = `margin:0 0 14px;font-family:${FONT};font-size:15px;line-height:1.65;color:${BRAND.body};`;
const H2 = `margin:0 0 10px;font-family:${FONT};font-size:18px;font-weight:700;color:${BRAND.ink};`;

// A bullet-proof, brand-blue button (uses a table so it renders in Outlook).
function button(text, url) {
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0;">
    <tr><td style="border-radius:10px;background:${BRAND.blue};">
      <a href="${url}" target="_blank"
         style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;
                font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;">${text}</a>
    </td></tr>
  </table>`;
}

function renderEmail({ preheader = "", heading = "", intro = "", bodyHtml = "", cta = null, footerNote = "" }) {
  const ctaHtml = cta && cta.text && cta.url ? button(cta.text, cta.url) : "";
  const introHtml = intro ? `<p style="${P}">${intro}</p>` : "";
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
</head>
<body style="margin:0;padding:0;background:${BRAND.bg};">
  <!-- preheader (hidden preview text) -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- header -->
        <tr><td style="background:${BRAND.blue};border-radius:14px 14px 0 0;padding:26px 32px;text-align:center;">
          <span style="font-family:${FONT};font-size:24px;font-weight:800;letter-spacing:-.02em;color:#ffffff;">MINE</span>
        </td></tr>

        <!-- body card -->
        <tr><td style="background:${BRAND.card};padding:34px 32px;border:1px solid ${BRAND.line};border-top:0;">
          ${heading ? `<h1 style="margin:0 0 16px;font-family:${FONT};font-size:24px;font-weight:800;letter-spacing:-.02em;color:${BRAND.ink};">${heading}</h1>` : ""}
          ${introHtml}
          ${bodyHtml}
          ${ctaHtml}
        </td></tr>

        <!-- footer -->
        <tr><td style="background:${BRAND.card};border:1px solid ${BRAND.line};border-top:0;border-radius:0 0 14px 14px;padding:22px 32px;">
          ${footerNote ? `<p style="margin:0 0 8px;font-family:${FONT};font-size:12px;line-height:1.6;color:${BRAND.muted};">${footerNote}</p>` : ""}
          <p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.6;color:${BRAND.muted};">
            &copy; ${year} MINE &nbsp;·&nbsp; <a href="https://takeova.ai" style="color:${BRAND.blue};text-decoration:none;">takeova.ai</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

module.exports = { renderEmail, button, P, H2, BRAND, FONT };
