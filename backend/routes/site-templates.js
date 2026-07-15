// ═══════════════════════════════════════════════════════════════════════════
// MINE — Site Template Library
// A set of polished, responsive starter sites the CREATOR can start from and
// the WYSIWYG EDITOR can then refine. Two creation modes:
//   • as-is        → clone the template instantly (no AI, no cost)
//   • AI-customized → Claude rewrites only the visible copy for the business,
//                     keeping all structure/classes/styles intact.
// Routes mounted at /api/site-templates.
// ═══════════════════════════════════════════════════════════════════════════
const express = require("express");
const router = express.Router();
const { v4: uuid } = require("uuid");
const { getDb } = require("../db/init");
const { auth } = require("../middleware/auth");
const { CATALOG, listCatalog, getCatalogEntry } = require("../data/site-catalog");
const { INDUSTRY_TEMPLATES } = require("../data/industry-templates");

// ── Shared design system (kept identical across templates for consistency) ──
const BASE_CSS = `
  *{margin:0;padding:0;box-sizing:border-box}
  :root{--accent:{{ACCENT}};--ink:#1a1a2e;--muted:#5b6472;--bg:#ffffff;--soft:#f6f7f9;--line:#e7e9ee;--radius:14px}
  body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:var(--ink);line-height:1.6;background:var(--bg)}
  .wrap{max-width:1120px;margin:0 auto;padding:0 24px}
  h1,h2,h3{font-family:'{{HEADFONT}}','Inter',serif;line-height:1.15;letter-spacing:-.01em}
  a{color:inherit;text-decoration:none}
  .btn{display:inline-block;background:var(--accent);color:#fff;padding:14px 28px;border-radius:var(--radius);font-weight:700;font-size:15px;transition:transform .12s,box-shadow .12s;box-shadow:0 4px 16px rgba(0,0,0,.10)}
  .btn:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.16)}
  .btn.ghost{background:transparent;color:var(--accent);box-shadow:none;border:2px solid var(--accent)}
  header.nav{position:sticky;top:0;z-index:50;background:rgba(255,255,255,.86);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
  header.nav .wrap{display:flex;align-items:center;justify-content:space-between;height:68px}
  header.nav .logo{font-family:'{{HEADFONT}}',serif;font-weight:800;font-size:20px}
  header.nav nav{display:flex;gap:26px;align-items:center}
  header.nav nav a{font-size:14px;font-weight:600;color:var(--muted)}
  header.nav nav a:hover{color:var(--ink)}
  section{padding:84px 0}
  .eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:12px;font-weight:800;color:var(--accent);margin-bottom:14px}
  .hero{padding:96px 0 80px;background:linear-gradient(180deg,var(--soft),#fff)}
  .hero h1{font-size:clamp(36px,6vw,60px);margin-bottom:20px;max-width:14ch}
  .hero p{font-size:19px;color:var(--muted);max-width:52ch;margin-bottom:32px}
  .grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}
  .card{background:#fff;border:1px solid var(--line);border-radius:18px;padding:30px;transition:transform .15s,box-shadow .15s}
  .card:hover{transform:translateY(-4px);box-shadow:0 14px 34px rgba(0,0,0,.08)}
  .icon{width:52px;height:52px;border-radius:14px;background:color-mix(in srgb,var(--accent) 14%,#fff);display:flex;align-items:center;justify-content:center;font-size:24px;margin-bottom:18px}
  .muted{color:var(--muted)}
  .center{text-align:center}
  .sec-head{max-width:60ch;margin:0 auto 52px}
  .sec-head h2{font-size:clamp(28px,4vw,40px);margin-bottom:14px}
  .stars{color:#f5a623;font-size:16px;letter-spacing:2px}
  .price{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}
  .price .card.feat{border:2px solid var(--accent);transform:scale(1.03)}
  .price .amt{font-size:42px;font-weight:800;font-family:'{{HEADFONT}}',serif;margin:8px 0}
  .price ul{list-style:none;margin:18px 0;text-align:left}
  .price li{padding:8px 0;border-bottom:1px solid var(--line);font-size:14px;color:var(--muted)}
  details{border-bottom:1px solid var(--line);padding:18px 0}
  summary{font-weight:700;cursor:pointer;font-size:16px;list-style:none}
  details p{color:var(--muted);margin-top:10px}
  footer{background:var(--ink);color:#cfd4dd;padding:56px 0 32px}
  footer .wrap{display:flex;flex-wrap:wrap;justify-content:space-between;gap:30px}
  footer a{color:#cfd4dd;font-size:14px;display:block;margin:8px 0}
  footer h4{color:#fff;margin-bottom:12px;font-size:15px}
  .cta{background:var(--accent);color:#fff;text-align:center}
  .cta h2{color:#fff;font-size:clamp(28px,4vw,42px);margin-bottom:16px}
  .cta .btn{background:#fff;color:var(--accent)}
  @media(max-width:820px){header.nav nav{display:none}.grid3,.price{grid-template-columns:1fr}.price .card.feat{transform:none}section{padding:60px 0}}
`;

function page(title, accent, headFont, body) {
  const css = BASE_CSS.replace(/\{\{ACCENT\}\}/g, accent).replace(/\{\{HEADFONT\}\}/g, headFont);
  const fontParam = encodeURIComponent(headFont).replace(/%20/g, "+");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="${accent}">
<meta name="description" content="${title}">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=${fontParam}:wght@600;700;800&display=swap" rel="stylesheet">
<style>${css}</style></head><body>${body}</body></html>`;
}

// ── TEMPLATE 1: Coaching / Consulting ──
const T_COACHING = page("Clarity Coaching", "#6C5CE7", "Fraunces", `
<header class="nav"><div class="wrap"><div class="logo">Clarity</div><nav><a href="#about">About</a><a href="#services">Services</a><a href="#pricing">Pricing</a><a class="btn" href="#book" data-mine-booking>Book a call</a></nav></div></header>
<section class="hero"><div class="wrap"><div class="eyebrow">1:1 Coaching</div><h1>Get unstuck and move toward the life you actually want</h1><p>Practical, judgement-free coaching that helps you set clear goals, build momentum, and follow through — week after week.</p><a class="btn" href="#book" data-mine-booking>Book your free intro call</a></div></section>
<section id="about"><div class="wrap" style="display:grid;grid-template-columns:1fr 1fr;gap:48px;align-items:center"><div><div class="eyebrow">About</div><h2>Coaching that meets you where you are</h2><p class="muted" style="margin-top:16px">I've spent the last decade helping people cut through overwhelm and take real steps forward. No fluff, no rigid programs — just focused conversations and accountability that fit your life.</p></div><div style="aspect-ratio:4/3;border-radius:18px;background:linear-gradient(135deg,var(--accent),#a29bfe)"></div></div></section>
<section style="background:var(--soft)"><div class="wrap"><div class="sec-head center"><div class="eyebrow">Services</div><h2>Ways we can work together</h2></div><div class="grid3"><div class="card"><div class="icon">🎯</div><h3>Goal sprints</h3><p class="muted" style="margin-top:10px">Turn a big, vague ambition into a 90-day plan with clear weekly actions.</p></div><div class="card"><div class="icon">🧭</div><h3>Career clarity</h3><p class="muted" style="margin-top:10px">Figure out your next move with structured exercises and honest feedback.</p></div><div class="card"><div class="icon">🔁</div><h3>Accountability</h3><p class="muted" style="margin-top:10px">Weekly check-ins that keep you consistent long after motivation fades.</p></div></div></div></section>
<section><div class="wrap"><div class="sec-head center"><div class="eyebrow">Results</div><h2>What clients say</h2></div><div class="grid3"><div class="card"><div class="stars">★★★★★</div><p style="margin:14px 0">"I finally launched the business I'd been talking about for three years. The accountability was everything."</p><strong>— Maya R., founder</strong></div><div class="card"><div class="stars">★★★★★</div><p style="margin:14px 0">"Within two months I'd negotiated a promotion. Clear, direct, and genuinely supportive."</p><strong>— James T., engineer</strong></div><div class="card"><div class="stars">★★★★★</div><p style="margin:14px 0">"Less anxious, more focused, actually following through. Worth every session."</p><strong>— Priya S., designer</strong></div></div></div></section>
<section id="pricing" style="background:var(--soft)"><div class="wrap"><div class="sec-head center"><div class="eyebrow">Pricing</div><h2>Simple, transparent packages</h2></div><div class="price"><div class="card"><h3>Single session</h3><div class="amt">$120</div><p class="muted">One focused 60-min session</p><ul><li>60-minute call</li><li>Session summary</li><li>Action plan</li></ul><a class="btn ghost" href="#book" data-mine-booking>Book</a></div><div class="card feat"><div class="eyebrow">Most popular</div><h3>Monthly</h3><div class="amt">$420</div><p class="muted">4 sessions + support</p><ul><li>4 sessions / month</li><li>Weekly check-ins</li><li>Voice/text between calls</li></ul><a class="btn" href="#book" data-mine-booking>Start now</a></div><div class="card"><h3>Intensive</h3><div class="amt">$1,100</div><p class="muted">90-day transformation</p><ul><li>12 sessions</li><li>Custom roadmap</li><li>Priority support</li></ul><a class="btn ghost" href="#book" data-mine-booking>Apply</a></div></div></div></section>
<section><div class="wrap" style="max-width:760px"><div class="sec-head center"><div class="eyebrow">FAQ</div><h2>Common questions</h2></div><details open><summary>Do you offer a free intro call?</summary><p>Yes — every new client starts with a free 20-minute call so we can make sure it's a good fit.</p></details><details><summary>How are sessions held?</summary><p>Over video, so you can join from anywhere. Evening slots are available.</p></details><details><summary>What if I need to reschedule?</summary><p>No problem — just give 24 hours notice and we'll find a new time.</p></details></div></section>
<section class="cta" id="book"><div class="wrap"><h2>Ready to get started?</h2><p style="opacity:.9;margin-bottom:28px">Book a free intro call and let's map out your first move.</p><a class="btn" href="#" data-mine-booking>Book your free call</a></div></section>
<footer><div class="wrap"><div><h4>Clarity Coaching</h4><p style="color:#9aa3b2;max-width:30ch">Helping you get unstuck, one focused conversation at a time.</p></div><div><h4>Explore</h4><a href="#about">About</a><a href="#services">Services</a><a href="#pricing">Pricing</a></div><div><h4>Connect</h4><a href="#">Instagram</a><a href="#">LinkedIn</a><a href="#" data-mine-contact>Contact</a></div></div></footer>
`);

// ── TEMPLATE 2: Local service business (salon / trades / clinic) ──
const T_LOCAL = page("Bloom Studio", "#0E9F6E", "Sora", `
<header class="nav"><div class="wrap"><div class="logo">Bloom</div><nav><a href="#services">Services</a><a href="#reviews">Reviews</a><a href="#visit">Visit</a><a class="btn" href="#book" data-mine-booking>Book now</a></nav></div></header>
<section class="hero"><div class="wrap"><div class="eyebrow">Now booking</div><h1>Look good, feel good — book in seconds</h1><p>A welcoming local studio for cuts, colour and care. Friendly, expert, and right around the corner.</p><a class="btn" href="#book" data-mine-booking>Book an appointment</a></div></section>
<section style="padding-top:46px"><div class="wrap grid3"><div class="card center"><div class="icon" style="margin:0 auto 14px">⭐</div><strong>4.9 rating</strong><p class="muted" style="font-size:14px">From 300+ local reviews</p></div><div class="card center"><div class="icon" style="margin:0 auto 14px">⏱️</div><strong>Open 7 days</strong><p class="muted" style="font-size:14px">Early & late slots</p></div><div class="card center"><div class="icon" style="margin:0 auto 14px">📍</div><strong>Easy to reach</strong><p class="muted" style="font-size:14px">Free parking nearby</p></div></div></section>
<section id="services"><div class="wrap"><div class="sec-head center"><div class="eyebrow">Services</div><h2>What we offer</h2></div><div class="grid3"><div class="card" data-mine-product data-name="Cut & Style" data-price="55"><h3>Cut & Style</h3><div class="amt" style="font-size:30px;color:var(--accent)">$55</div><p class="muted">Wash, cut and finish tailored to you.</p></div><div class="card" data-mine-product data-name="Full Colour" data-price="120"><h3>Full Colour</h3><div class="amt" style="font-size:30px;color:var(--accent)">$120</div><p class="muted">Rich, lasting colour by our specialists.</p></div><div class="card" data-mine-product data-name="Treatment" data-price="40"><h3>Treatment</h3><div class="amt" style="font-size:30px;color:var(--accent)">$40</div><p class="muted">Repair and nourish with a deep treatment.</p></div></div></div></section>
<section id="reviews" style="background:var(--soft)"><div class="wrap"><div class="sec-head center"><div class="eyebrow">Loved locally</div><h2>What our clients say</h2></div><div class="grid3"><div class="card"><div class="stars">★★★★★</div><p style="margin:14px 0">"Best in the area, hands down. I won't go anywhere else."</p><strong>— Sarah L.</strong></div><div class="card"><div class="stars">★★★★★</div><p style="margin:14px 0">"Booked online in 30 seconds and walked out thrilled."</p><strong>— Dan M.</strong></div><div class="card"><div class="stars">★★★★★</div><p style="margin:14px 0">"Warm, professional, and genuinely talented. Five stars."</p><strong>— Aisha K.</strong></div></div></div></section>
<section id="visit"><div class="wrap" style="display:grid;grid-template-columns:1fr 1fr;gap:48px;align-items:center"><div><div class="eyebrow">Visit us</div><h2>Find us & opening hours</h2><p class="muted" style="margin:16px 0">123 High Street, Your Town<br>Mon–Fri 9am–7pm · Sat 9am–5pm · Sun 10am–4pm</p><a class="btn" href="#book" data-mine-booking>Book your visit</a></div><div style="aspect-ratio:4/3;border-radius:18px;background:linear-gradient(135deg,var(--accent),#84e1bc)"></div></div></section>
<section class="cta" id="book"><div class="wrap"><h2>Book your appointment</h2><p style="opacity:.9;margin-bottom:28px">Choose a time that suits you — it only takes a moment.</p><a class="btn" href="#" data-mine-booking>Book now</a></div></section>
<footer><div class="wrap"><div><h4>Bloom Studio</h4><p style="color:#9aa3b2;max-width:30ch">Your friendly local studio for cuts, colour and care.</p></div><div><h4>Hours</h4><a>Mon–Fri 9–7</a><a>Sat 9–5</a><a>Sun 10–4</a></div><div><h4>Connect</h4><a href="#">Instagram</a><a href="#">Facebook</a><a href="#" data-mine-contact>Call us</a></div></div></footer>
`);

// ── TEMPLATE 3: E-commerce / product shop ──
const T_SHOP = page("Field Goods", "#E8590C", "Fraunces", `
<header class="nav"><div class="wrap"><div class="logo">Field Goods</div><nav><a href="#shop">Shop</a><a href="#story">Story</a><a href="#reviews">Reviews</a><a class="btn" href="#shop">Shop all</a></nav></div></header>
<section class="hero"><div class="wrap"><div class="eyebrow">New season</div><h1>Everyday essentials, beautifully made</h1><p>Small-batch goods built to last, made with care and shipped to your door. Thoughtful design, honest materials.</p><a class="btn" href="#shop">Shop the collection</a></div></section>
<section id="shop"><div class="wrap"><div class="sec-head center"><div class="eyebrow">Bestsellers</div><h2>Shop our favourites</h2></div><div data-mine-products></div></div></section>
<section id="story" style="background:var(--soft)"><div class="wrap" style="display:grid;grid-template-columns:1fr 1fr;gap:48px;align-items:center"><div style="aspect-ratio:4/3;border-radius:18px;background:linear-gradient(135deg,var(--accent),#ffd8a8)"></div><div><div class="eyebrow">Our story</div><h2>Made by hand, made to last</h2><p class="muted" style="margin-top:16px">We started in a small workshop with one belief: everyday objects should be beautiful and built to last. Every piece is made in small batches with materials we're proud of.</p></div></div></section>
<section id="reviews"><div class="wrap"><div class="sec-head center"><div class="eyebrow">Reviews</div><h2>What customers say</h2></div><div class="grid3"><div class="card"><div class="stars">★★★★★</div><p style="margin:14px 0">"The quality is unreal for the price. My tote gets compliments daily."</p><strong>— Verified buyer</strong></div><div class="card"><div class="stars">★★★★★</div><p style="margin:14px 0">"Fast shipping and gorgeous packaging. Will order again."</p><strong>— Verified buyer</strong></div><div class="card"><div class="stars">★★★★★</div><p style="margin:14px 0">"You can feel the care in every piece. Beautiful work."</p><strong>— Verified buyer</strong></div></div></div></section>
<section class="cta"><div class="wrap"><h2>Free shipping over $50</h2><p style="opacity:.9;margin-bottom:28px">Treat yourself to something well made.</p><a class="btn" href="#shop">Shop now</a></div></section>
<footer><div class="wrap"><div><h4>Field Goods</h4><p style="color:#9aa3b2;max-width:30ch">Small-batch everyday essentials, beautifully made.</p></div><div><h4>Shop</h4><a href="#shop">All products</a><a href="#">New arrivals</a><a href="#">Gift cards</a></div><div><h4>Connect</h4><a href="#">Instagram</a><a href="#">Newsletter</a><a href="#" data-mine-contact>Contact</a></div></div></footer>
`);


// The 3 hand-built DESIGNED templates (instant clone, no AI cost).
const DESIGNED = { coaching: T_COACHING, "local-service": T_LOCAL, ecommerce: T_SHOP };

// Starter business objects that ship with each designed template.
const DESIGNED_PROVISION = {
  coaching: {
    courses: [{
      title: "Your Signature Program", price: 297,
      description: "A self-paced program that walks clients through your method step by step. Edit the modules and lessons to match what you teach.",
      modules: [
        { title: "Module 1 — Foundations", lessons: ["Welcome & how this works", "The core framework"] },
        { title: "Module 2 — Putting it into practice", lessons: ["Your first action plan", "Building momentum"] },
        { title: "Module 3 — Going deeper", lessons: ["Overcoming sticking points", "Making it last"] },
      ],
    }],
    memberships: [{ name: "Monthly Coaching", price: 420, interval_type: "monthly", features: ["4 sessions per month", "Weekly check-ins", "Voice & text support between calls"] }],
    services: [
      { name: "Free Discovery Call", description: "A no-pressure 20-minute call to see if we're a fit.", duration_minutes: 20, price: 0, category: "Coaching" },
      { name: "1:1 Coaching Session", description: "A focused 60-minute coaching session.", duration_minutes: 60, price: 120, category: "Coaching" },
    ],
    coupons: [{ code: "WELCOME15", type: "percent", value: 15 }],
  },
  "local-service": {
    services: [
      { name: "Cut & Style", description: "Wash, cut and finish tailored to you.", duration_minutes: 60, price: 55, category: "Hair" },
      { name: "Full Colour", description: "Rich, lasting colour by our specialists.", duration_minutes: 120, price: 120, category: "Colour" },
      { name: "Treatment", description: "Repair and nourish with a deep conditioning treatment.", duration_minutes: 45, price: 40, category: "Care" },
    ],
    coupons: [{ code: "FIRSTVISIT10", type: "percent", value: 10 }],
  },
  ecommerce: {
    products: [
      { name: "Canvas Tote", price: 38, description: "Heavy-duty everyday carry, built to last." },
      { name: "Ceramic Mug", price: 24, description: "Hand-glazed stoneware mug, holds 12oz." },
      { name: "Linen Apron", price: 52, description: "Soft, durable linen apron with adjustable straps." },
    ],
    coupons: [{ code: "WELCOME10", type: "percent", value: 10 }],
  },
};

// ── Helpers (mirror sites.js conventions) ──
function planCap(plan, key, fallback) {
  try { const C = require("./features").PLAN_CAPS || {}; const p = C[plan] || null; if (p && p[key] != null) return p[key]; } catch (_) {}
  return fallback;
}

function planMaxSites(plan) {
  // Change 16: PLAN_CAPS is the single source of truth (free/no-plan users: 1)
  return plan ? planCap(plan, "sites", 1) : 1;
}
function slugify(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "my-site";
}

// Provision the starter business objects a vertical needs (courses/products/
// memberships/coupons/services), so the site arrives with a working catalog —
// not just a page. Wrapped so a provisioning hiccup never blocks site creation.
function provisionStarterData(db, userId, siteId, prov) {
  const created = { courses: 0, products: 0, memberships: 0, coupons: 0, services: 0 };
  if (!prov) return created;
  try {
    for (const c of (prov.courses || [])) {
      db.prepare("INSERT INTO courses (id, site_id, user_id, title, description, price, modules_json, status, enrolled) VALUES (?,?,?,?,?,?,?,'draft',0)")
        .run(uuid(), siteId, userId, c.title, c.description || "", c.price || 0, JSON.stringify(c.modules || []));
      created.courses++;
    }
    for (const p of (prov.products || [])) {
      db.prepare("INSERT INTO products (id, site_id, user_id, name, description, price, status, stock) VALUES (?,?,?,?,?,?,'active',999)")
        .run(uuid(), siteId, userId, p.name, p.description || "", p.price || 0);
      created.products++;
    }
    // Bookable services are user-scoped (the public booking widget reads them by user).
    // Dedupe by name so re-creating a template doesn't pile up duplicate services.
    for (const s of (prov.services || [])) {
      const dup = db.prepare("SELECT 1 FROM services WHERE user_id = ? AND name = ?").get(userId, s.name);
      if (!dup) {
        db.prepare("INSERT INTO services (id, user_id, name, description, duration_minutes, price, category, color, active, buffer_minutes) VALUES (?,?,?,?,?,?,?,?,1,0)")
          .run(uuid(), userId, s.name, s.description || "", s.duration_minutes || 60, s.price || 0, s.category || "", s.color || "#2563EB");
        created.services++;
      }
    }
    for (const m of (prov.memberships || [])) {
      db.prepare("INSERT INTO memberships (id, site_id, user_id, name, price, interval_type, features_json, active_members) VALUES (?,?,?,?,?,?,?,0)")
        .run(uuid(), siteId, userId, m.name, m.price || 0, m.interval_type || "monthly", JSON.stringify(m.features || []));
      created.memberships++;
    }
    for (const cp of (prov.coupons || [])) {
      const dup = db.prepare("SELECT 1 FROM coupons WHERE user_id = ? AND code = ?").get(userId, cp.code);
      if (!dup) {
        db.prepare("INSERT INTO coupons (id, user_id, code, type, value, active) VALUES (?,?,?,?,?,1)")
          .run(uuid(), userId, cp.code, cp.type || "percent", cp.value || 0);
        created.coupons++;
      }
    }
  } catch (e) {
    console.error("[site-templates] provisioning error:", e?.message);
  }
  return created;
}

// AI edit quota caps (mirror /api/sites/generate-from-prompt).
// Change 16: AI-edit caps now read from PLAN_CAPS (see planCap)

// Generate a full site with Claude from a bespoke, business-specific prompt.
// Uses the SAME system prompt as /api/sites/generate-from-prompt so a site built
// from a template and a site built from the prompt box look and behave the same.
// Returns an HTML string, or null on any failure (caller falls back gracefully).
async function aiGenerateSite(promptText) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return null;
  const systemPrompt = 'You are a senior product designer + developer at a top design agency, building a polished single-page business website. ' +
    'Output ONLY a complete HTML document — no markdown, no explanation, no code fences, no comments outside <!-- HTML comments -->. ' +
    'STRUCTURE: <!DOCTYPE html>, <html lang="en">, <head> with <title>, <meta viewport>, <meta theme-color>, <meta description>, and Google Fonts <link> for ONE pair of fonts that fits the brand (e.g. Inter+Playfair, DM Sans+Fraunces, Manrope+Cormorant). ' +
    'CSS: All inline in one <style> block. Use CSS custom properties (--primary, --accent, --bg, --text, --muted) defined at :root. Use CSS grid + flexbox. Use clamp() for fluid type and spacing. Use modern features: aspect-ratio, gap, custom scrollbars where appropriate. NO outdated patterns (no floats, no !important except for utility overrides). ' +
    'DESIGN QUALITY: Strong visual hierarchy. Generous whitespace (padding clamp(48px, 8vw, 120px) on sections). Bold typography (heading sizes via clamp). One distinctive design choice that makes it memorable (e.g. asymmetric hero, oversized type, color-blocked sections, gradient mesh background, sticker-style badges, hand-drawn underlines via SVG). Avoid generic "bootstrap-y" looks. ' +
    'COLOR: Pick a palette that matches the business vibe — not always purple/blue. Spa/wellness = earthy greens/creams. Tech/SaaS = bold contrasts. Restaurant = warm reds/creams. Define 3-5 colors and use them consistently. ' +
    'SECTIONS — INCLUDE ALL: hero (with headline, subhead, primary CTA, hero visual placeholder via SVG/gradient), 3-icon trust bar / proof points, about/story (2 columns), services or features (3-card grid), social proof (testimonials with names + roles + star rating), pricing (2-3 tier cards with feature lists), FAQ (3-5 items via <details>), final CTA, footer (with nav + social links + business info). ' +
    'CONTENT: Write specific, believable copy — not "Lorem ipsum" and not generic "We offer the best service" platitudes. Use the business description to invent realistic product names, testimonial quotes, pricing tiers, and team bios. Testimonials should sound like real reviews (specific outcomes, conversational tone). Pricing should be plausible for the industry. ' +
    'INTERACTIVITY: Add data-mine-product (on product/service cards with name+price), data-mine-booking (on appointment CTAs), data-mine-course (on course/class items), data-mine-contact (on contact forms). MINE will hook into these. Include ONE smooth scroll-to-anchor behavior for nav links. ' +
    'ACCESSIBILITY: Semantic HTML (header/main/section/article/footer/nav). alt text on all images (use https://images.unsplash.com/photo-{random valid id} placeholder URLs for hero/section visuals). aria-labels on icon buttons. Sufficient color contrast (4.5:1 for body text). ' +
    'RESPONSIVE: Mobile-first. Test breakpoints in your head — does it look great at 375px? At 1440px? Grid columns collapse to 1 on mobile. ' +
    'Keep the entire output under 200KB. Aim for ~600 lines of HTML+CSS — substantial enough to feel complete, not bloated.';
  const userPrompt = 'Build a website for this business:\n\n' + promptText + '\n\n' +
    'Pick appropriate sections, copy and design based on what the business is. Use a color palette that fits the vibe described.';
  try {
    const fetchFn = (...a) => import("node-fetch").then(m => m.default(...a));
    const aiResp = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicKey, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 8000, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] }),
    });
    const aiData = await aiResp.json();
    if (!aiResp.ok || !aiData.content) { console.error('[site-templates/ai]', aiData?.error?.message || aiResp.status); return null; }
    const html = (aiData.content[0]?.text || '').replace(/^```html?\s*\n?|```\s*$/g, '').trim();
    if (!html || html.length < 200) return null;
    return html;
  } catch (e) { console.error('[site-templates/ai] fetch error:', e?.message || e); return null; }
}

// Minimal branded fallback so the user ALWAYS gets a site even when AI is
// unavailable or over quota — they can edit it, or rebuild from the prompt box.
function fallbackPage(entry, name) {
  return page(name, entry.accent || "#2563EB", "Fraunces", `
<header class="nav"><div class="wrap"><div class="logo">${name}</div><nav><a href="#services">Services</a><a href="#about">About</a><a class="btn" href="#contact" data-mine-contact>Get in touch</a></nav></div></header>
<section class="hero"><div class="wrap"><div class="eyebrow">${entry.category}</div><h1>${name}</h1><p>${entry.tagline}</p><a class="btn" href="#contact" data-mine-contact>Get started</a></div></section>
<section id="services"><div class="wrap"><div class="sec-head center"><div class="eyebrow">Services</div><h2>What we offer</h2></div><div class="grid3"><div class="card"><div class="icon">${entry.icon}</div><h3>Edit this page</h3><p class="muted">Use the editor to tailor everything here — or open the AI generator to rebuild it from a description.</p></div><div class="card"><div class="icon">✏️</div><h3>Make it yours</h3><p class="muted">Click any text or image to change it.</p></div><div class="card"><div class="icon">🚀</div><h3>Publish</h3><p class="muted">When you're happy, hit publish to go live.</p></div></div></div></section>
<section class="cta" id="contact"><div class="wrap"><h2>Get in touch</h2><p style="opacity:.9;margin-bottom:28px">We'd love to hear from you.</p><a class="btn" href="#" data-mine-contact>Contact us</a></div></section>
<footer><div class="wrap"><div><h4>${name}</h4><p style="color:#9aa3b2;max-width:30ch">${entry.tagline}</p></div></div></footer>
`);
}

// Switch on the AI Employees recommended for this vertical (best-effort).
// Uses INSERT OR IGNORE so we never override a choice the user already made.
function enableRecommendedAgents(db, userId, industryKey) {
  try {
    const ind = INDUSTRY_TEMPLATES[industryKey];
    const recs = ind && ind.recommended_agents ? Object.keys(ind.recommended_agents) : [];
    let enabled = 0;
    for (const role of recs) {
      const r = db.prepare("INSERT OR IGNORE INTO ai_employees (id, user_id, role, enabled, created_at, updated_at) VALUES (?,?,?,1,datetime('now'),datetime('now'))").run(uuid(), userId, role);
      if (r && r.changes) enabled += r.changes;
    }
    return enabled;
  } catch (e) { console.error("[site-templates] enable agents:", e?.message); return 0; }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /  → list the full catalog (metadata only; no HTML / no prompts)
// ─────────────────────────────────────────────────────────────────────────
router.get("/", auth, (req, res) => {
  res.json({ templates: listCatalog(), total: CATALOG.length });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /:key  → designed templates return HTML for preview; AI templates return
//              their build prompt (HTML is generated on create).
// ─────────────────────────────────────────────────────────────────────────
router.get("/:key", auth, (req, res) => {
  const t = getCatalogEntry(req.params.key);
  if (!t) return res.status(404).json({ error: "Template not found" });
  if (t.designed) return res.json({ key: t.key, name: t.name, category: t.category, accent: t.accent, designed: true, html: DESIGNED[t.designed] });
  res.json({ key: t.key, name: t.name, category: t.category, accent: t.accent, designed: false, buildPrompt: t.buildPrompt });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /create  → create a real site from a catalog entry.
//   body: { templateKey, businessName?, businessDescription?, customize? }
//   • designed entry  → clone the hand-built template (optionally AI-customize
//                       only the visible copy), then provision its objects.
//   • AI entry        → generate the site from the vertical's bespoke prompt
//                       (quota-gated), then provision its objects. Falls back to
//                       a branded page if AI is unavailable, so creation never fails.
//   Also switches on the AI Employees recommended for the vertical.
// ─────────────────────────────────────────────────────────────────────────
router.post("/create", auth, async (req, res) => {
  try {
    const db = getDb();
    const { templateKey, businessName, businessDescription, customize } = req.body || {};
    const t = getCatalogEntry(templateKey);
    if (!t) return res.status(400).json({ error: "Invalid templateKey" });

    const user = db.prepare("SELECT plan, ai_edits_used, ai_edits_limit FROM users WHERE id = ?").get(req.userId) || {};
    const count = db.prepare("SELECT COUNT(*) as c FROM sites WHERE user_id = ?").get(req.userId).c;
    if (count >= planMaxSites(user.plan)) {
      if (String(user && user.plan).toLowerCase() === "agency") {
        // AGENCY ONLY: past-cap sites allowed, billed $3/site/mo on the agency invoice (agency.js cron). Ceiling 80.
        if (count >= 80) return res.status(403).json({ error: "Site safety ceiling reached — contact support.", code: "SITE_CEILING" });
      } else return res.status(403).json({ error: "Site limit reached for your plan. Upgrade to add more sites.", requiresUpgrade: true, code: "SITE_LIMIT" });
    }

    const name = (businessName && String(businessName).trim()) || t.name;
    let html = null, aiGenerated = false, aiCustomized = false;
    const provisionSpec = t.designed ? DESIGNED_PROVISION[t.designed] : t.provision;

    if (t.designed) {
      const baseHtml = DESIGNED[t.designed];
      html = baseHtml;
      // Optional AI copy customization — keep structure, swap only visible text.
      if (customize && businessDescription && String(businessDescription).trim() && process.env.ANTHROPIC_API_KEY) {
        try {
          const cap = (user.ai_edits_limit > 0) ? user.ai_edits_limit : planCap(user.plan, "edits", 30);
          if ((user.ai_edits_used || 0) + 5 <= cap) {
            const sys = "You are editing an HTML website template. Return the COMPLETE HTML document with ONLY the visible text content rewritten to fit the business described. " +
              "CRITICAL RULES: Do NOT change, add, or remove any HTML tags, attributes, classes, inline styles, or structure. Do NOT touch <style>, <head>, <link>, or data-mine-* attributes. " +
              "Only rewrite human-readable copy: headlines, paragraphs, button labels, nav labels, testimonials (invent believable ones), product/service names and plausible prices, the business name, and footer text. Keep length similar so layout holds. Output ONLY the HTML, no markdown fences, no commentary.";
            const userMsg = `BUSINESS: ${String(businessName || name)}\nDESCRIPTION: ${String(businessDescription).slice(0, 1200)}\n\nTEMPLATE HTML:\n${baseHtml}`;
            const fetchFn = (...a) => import("node-fetch").then(m => m.default(...a));
            const resp = await fetchFn("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
              body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 8000, system: sys, messages: [{ role: "user", content: userMsg }] }),
            });
            if (resp.ok) {
              const data = await resp.json();
              const out = (data.content?.[0]?.text || "").replace(/^```html?\s*\n?|```\s*$/g, "").trim();
              if (out && /<\/html>/i.test(out) && out.length > baseHtml.length * 0.5) {
                html = out; aiCustomized = true;
                db.prepare("UPDATE users SET ai_edits_used = COALESCE(ai_edits_used, 0) + 5 WHERE id = ?").run(req.userId);
              }
            }
          }
        } catch (e) { console.error("[site-templates/create] customize failed:", e?.message); }
      }
    } else {
      // AI-generated from the vertical's bespoke prompt (quota-gated).
      const cap = (user.ai_edits_limit > 0) ? user.ai_edits_limit : planCap(user.plan, "edits", 30);
      const canAI = process.env.ANTHROPIC_API_KEY && ((user.ai_edits_used || 0) + 5 <= cap);
      if (canAI) {
        const prompt = (businessName ? ("Business name: " + String(businessName).trim() + ". ") : "") + t.buildPrompt +
          (businessDescription ? (" Extra details: " + String(businessDescription).slice(0, 800)) : "");
        const out = await aiGenerateSite(prompt);
        if (out) {
          html = out; aiGenerated = true;
          try { db.prepare("UPDATE users SET ai_edits_used = COALESCE(ai_edits_used, 0) + 5 WHERE id = ?").run(req.userId); } catch (e) {}
        }
      }
      if (!html) html = fallbackPage(t, name); // never fail to create a site
    }

    const id = uuid();
    const slug = slugify(name);
    const domain = slug + "." + (process.env.MAIN_HOST || "takeova.ai");
    const colorsJson = JSON.stringify({ accent: t.accent });
    const owner = db.prepare("SELECT agency_id FROM users WHERE id = ?").get(req.userId);
    const agencyId = owner && owner.agency_id ? owner.agency_id : null;
    db.prepare("INSERT INTO sites (id, user_id, agency_id, name, template, category, html, domain, colors_json, status) VALUES (?,?,?,?,?,?,?,?,?,'draft')")
      .run(id, req.userId, agencyId, name, t.key, t.category, html, domain, colorsJson);

    const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(id);
    const provisioned = provisionStarterData(db, req.userId, id, provisionSpec);
    const agentsEnabled = enableRecommendedAgents(db, req.userId, t.industry);
    res.json({ site, designed: !!t.designed, aiGenerated, aiCustomized, provisioned, agentsEnabled });
  } catch (e) {
    console.error("[site-templates/create]", e?.message);
    if (!res.headersSent) res.status(500).json({ error: "Could not create site from template" });
  }
});

module.exports = router;
module.exports.CATALOG = CATALOG;
