// Mobile PWA + consumer join-code entry.
//
// (a) Branded installable PWA served on each customer's OWN origin
//     (custom domain or <slug>.takeova.ai), wired in via the host-based
//     public-serve middleware in server.js:
//       /app                      -> branded app shell (the home-screen start_url)
//       /app/manifest.webmanifest -> dynamic web app manifest (from site branding)
//       /app/icon.svg             -> generated icon (business initial on brand colour)
//       /mine-sw.js               -> service worker (offline + web push)
//     Plus injectInto() adds the manifest link + SW registration to the site HTML
//     so the regular site is installable too.
//
// (b) Consumer "TAKEOVA app" entry on the MAIN origin:
//       GET /m  (or /m/:code)        -> enter a join code, redirect to the business app
//       GET /api/m/resolve/:code     -> resolve a join code to a business app (public)
//
// Honest limits: true install prompts also require HTTPS and (on some browsers)
// PNG icons at 192/512 — we supply the logo when present plus an SVG fallback.

const express = require("express");
const router = express.Router();
function getDb() { return require("../db/init").getDb(); }

function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

function brand(site) {
  let colors = {};
  try { colors = JSON.parse(site.colors_json || "{}"); } catch (_) {}
  const primary = colors.primary || colors.brand || colors.accent || "#3B5BFA";
  const bg = colors.background || colors.bg || "#0B1020";
  const name = site.name || "Your App";
  const short = name.length > 12 ? name.slice(0, 12) : name;
  const logo = site.logo || "";
  const initial = (name.trim()[0] || "M").toUpperCase();
  return { primary, bg, name, short, logo, initial };
}

function iconSvg(site) {
  const b = brand(site);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="${b.primary}"/><text x="50%" y="54%" font-family="system-ui,Arial,sans-serif" font-size="280" font-weight="700" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${esc(b.initial)}</text></svg>`;
}

function manifest(site) {
  const b = brand(site);
  const icons = [];
  if (b.logo) {
    icons.push({ src: b.logo, sizes: "192x192", type: "image/png", purpose: "any" });
    icons.push({ src: b.logo, sizes: "512x512", type: "image/png", purpose: "any" });
  }
  icons.push({ src: "/app/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" });
  return {
    name: b.name,
    short_name: b.short,
    start_url: "/app",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: b.bg,
    theme_color: b.primary,
    icons,
  };
}

function serviceWorker() {
  return `const C='mine-app-v1';
self.addEventListener('install',function(e){self.skipWaiting();});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim());});
self.addEventListener('fetch',function(e){
  var r=e.request; if(r.method!=='GET')return;
  e.respondWith(fetch(r).then(function(res){var c=res.clone();caches.open(C).then(function(ca){ca.put(r,c).catch(function(){});});return res;}).catch(function(){return caches.match(r).then(function(m){return m||caches.match('/app');});}));
});
self.addEventListener('push',function(e){var d={};try{d=e.data?e.data.json():{};}catch(_){}var t=d.title||'Update';var o={body:d.body||'',icon:'/app/icon.svg',badge:'/app/icon.svg',data:d.url||'/app'};e.waitUntil(self.registration.showNotification(t,o));});
self.addEventListener('notificationclick',function(e){e.notification.close();e.waitUntil(self.clients.openWindow(e.notification.data||'/app'));});`;
}

function appShell(site) {
  const b = brand(site);
  const logoHtml = b.logo
    ? `<img src="${esc(b.logo)}" alt="" style="width:72px;height:72px;border-radius:18px;object-fit:cover">`
    : `<div style="width:72px;height:72px;border-radius:18px;background:${b.primary};color:#fff;display:flex;align-items:center;justify-content:center;font-size:36px;font-weight:700">${esc(b.initial)}</div>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(b.name)}</title>
<link rel="manifest" href="/app/manifest.webmanifest"><meta name="theme-color" content="${b.primary}">
<link rel="apple-touch-icon" href="${b.logo ? esc(b.logo) : "/app/icon.svg"}">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="${esc(b.short)}">
<style>*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:${b.bg};color:#fff;min-height:100vh;-webkit-tap-highlight-color:transparent}
.wrap{max-width:520px;margin:0 auto;padding:28px 20px calc(28px + env(safe-area-inset-bottom))}
.head{display:flex;align-items:center;gap:14px;margin:8px 0 22px}.h-n{font-size:20px;font-weight:700}.h-s{font-size:13px;color:rgba(255,255,255,.6)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.tile{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:18px 16px;text-decoration:none;color:#fff;display:flex;flex-direction:column;gap:8px}
.tile:active{transform:scale(.98)}.t-i{font-size:26px}.t-l{font-weight:600;font-size:14px}.t-d{font-size:12px;color:rgba(255,255,255,.55)}
.cta{display:block;text-align:center;margin-top:12px;background:${b.primary};color:#fff;border:none;border-radius:14px;padding:15px;font-size:15px;font-weight:600;text-decoration:none;cursor:pointer;width:100%}
.note{margin-top:16px;font-size:12px;color:rgba(255,255,255,.5);text-align:center;line-height:1.5}</style></head>
<body><div class="wrap">
<div class="head">${logoHtml}<div><div class="h-n">${esc(b.name)}</div><div class="h-s">Your app</div></div></div>
<div class="grid">
<a class="tile" href="/"><span class="t-i">📅</span><span class="t-l">Book</span><span class="t-d">Classes &amp; appointments</span></a>
<a class="tile" href="/"><span class="t-i">🛍️</span><span class="t-l">Shop</span><span class="t-d">Products &amp; services</span></a>
<a class="tile" href="/"><span class="t-i">⭐</span><span class="t-l">Loyalty</span><span class="t-d">Points &amp; rewards</span></a>
<a class="tile" href="/"><span class="t-i">💬</span><span class="t-l">Chat</span><span class="t-d">Message us</span></a>
</div>
<button class="cta" id="mine-push-btn">🔔 Turn on notifications</button>
<a class="cta" style="background:rgba(255,255,255,.1)" href="/">Open full site</a>
<div class="note">Add this to your home screen for an app experience — in your browser menu choose “Add to Home Screen.”</div>
</div>
<script>
if('serviceWorker' in navigator){navigator.serviceWorker.register('/mine-sw.js').catch(function(){});}
(function(){var b=document.getElementById('mine-push-btn');if(!b)return;b.addEventListener('click',function(){
  if(!('Notification' in window)){b.textContent='Notifications not supported';return;}
  Notification.requestPermission().then(function(p){b.textContent=(p==='granted')?'🔔 Notifications on':'Notifications blocked';});
});})();
</script></body></html>`;
}

function injectInto(html, site) {
  const b = brand(site);
  const head = `<link rel="manifest" href="/app/manifest.webmanifest"><meta name="theme-color" content="${b.primary}"><link rel="apple-touch-icon" href="${b.logo ? esc(b.logo) : "/app/icon.svg"}"><meta name="apple-mobile-web-app-capable" content="yes">`;
  const foot = `<script>if('serviceWorker' in navigator){navigator.serviceWorker.register('/mine-sw.js').catch(function(){});}</script>`;
  let out = String(html || "");
  out = out.includes("</head>") ? out.replace("</head>", head + "</head>") : head + out;
  out = out.includes("</body>") ? out.replace("</body>", foot + "</body>") : out + foot;
  return out;
}

// ─── (b) Consumer join-code resolver (public) ───
router.get("/api/m/resolve/:code", (req, res) => {
  try {
    const code = String(req.params.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    if (!code) return res.json({ found: false });
    const db = getDb();
    let row = null;
    try { row = db.prepare("SELECT user_id FROM mobile_app_config WHERE join_code = ?").get(code); } catch (_) {}
    if (!row) return res.json({ found: false });
    const site = db.prepare("SELECT name, logo, custom_domain, domain FROM sites WHERE user_id = ? LIMIT 1").get(row.user_id) || {};
    // Prefer the *.takeova.ai subdomain (always HTTPS + whitelisted in the
    // consumer app's allowNavigation, so it opens in-app); fall back to a
    // custom domain.
    const host = (site.domain || site.custom_domain || "").replace(/^https?:\/\//, "");
    const installUrl = host ? host + "/app" : "";
    res.json({ found: !!installUrl, name: site.name || "Business", logo: site.logo || "", installUrl });
  } catch (e) { res.json({ found: false }); }
});

// ─── (b) Consumer entry page (main origin) ───
router.get(["/m", "/m/:code"], (req, res) => {
  const pre = String(req.params.code || req.query.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  res.type("html").send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Find a business — MINE</title>
<style>*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0B1020;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{max-width:420px;width:100%;padding:32px 24px;text-align:center}.logo{font-size:40px;margin-bottom:8px}h1{font-size:22px;margin:0 0 6px}p{color:rgba(255,255,255,.6);font-size:14px;margin:0 0 22px}
input{width:100%;padding:15px;border-radius:14px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.06);color:#fff;font-size:18px;text-align:center;letter-spacing:3px;text-transform:uppercase}
button{width:100%;margin-top:12px;padding:15px;border:none;border-radius:14px;background:#3B5BFA;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
.err{color:#fca5a5;font-size:13px;margin-top:12px;min-height:18px}</style></head>
<body><div class="card"><div class="logo">📲</div><h1>Open a business app</h1><p>Enter the join code the business gave you, or scan their QR.</p>
<input id="code" maxlength="12" placeholder="CODE" value="${esc(pre)}" autocapitalize="characters" autocomplete="off">
<button id="go">Open app</button><div class="err" id="err"></div></div>
<script>
var go=document.getElementById('go'),inp=document.getElementById('code'),err=document.getElementById('err');
function open(){var c=(inp.value||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');if(!c){err.textContent='Enter a code';return;}err.textContent='Looking up…';
 fetch('/api/m/resolve/'+encodeURIComponent(c)).then(function(r){return r.json();}).then(function(d){
   if(d&&d.found&&d.installUrl){var u=d.installUrl;if(!/^https?:/.test(u))u='https://'+u;window.location.href=u;}else{err.textContent='No business found for that code';}
 }).catch(function(){err.textContent='Something went wrong';});}
go.addEventListener('click',open);inp.addEventListener('keydown',function(e){if(e.key==='Enter')open();});
if(inp.value){open();}
</script></body></html>`);
});

module.exports = { router, serviceWorker, manifest, appShell, injectInto, iconSvg };
