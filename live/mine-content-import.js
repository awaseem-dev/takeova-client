// ════════════════════════════════════════════════════════════════════
// mine-content-import.js — UI for importing real content into sites
// ════════════════════════════════════════════════════════════════════
// Adds a "📥 Import" button to the AI Site Editor's Safety bar.
// Opens a 4-tab modal:
//   1. 📸 Instagram — grab last 9 posts from connected IG account
//   2. ⭐ Google Reviews — pull reviews by Place ID / Maps URL
//   3. 📄 PDF — extract text from a brochure/menu PDF → About/FAQ
//   4. 🌐 Website — scrape competitor for palette + fonts (inspo only)
//
// Each tab: runs the import, previews the output, offers:
//   - "Insert into site" (appends the generated section)
//   - "Copy HTML" (copies the section HTML to clipboard)
//
// All calls go to /api/content-import/* (already registered in server.js).
// ════════════════════════════════════════════════════════════════════

(function () {
  "use strict";

  if (window.mineContentImport) return;  // already loaded
  window.mineContentImport = {};

  // ─── Helpers ─────────────────────────────────────────────
  function esc(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function toast(msg, kind) {
    if (window.mineAIEditor?.toast) return window.mineAIEditor.toast(msg, kind);
    if (window.mineRescue?.toast) return window.mineRescue.toast(msg, kind);
    // Fallback
    var t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:999999;background:" + (kind === "error" ? "#dc2626" : "#111") + ";color:#fff;padding:12px 18px;border-radius:10px;font:600 13px/1.4 system-ui;box-shadow:0 8px 24px rgba(0,0,0,.2);max-width:90vw";
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3500);
  }

  async function apiCall(method, path, body) {
    var headers = { "Content-Type": "application/json" };
    var token = localStorage.getItem("token") || localStorage.getItem("mine_token") || "";
    if (token) headers["Authorization"] = "Bearer " + token;
    var opts = { method: method, headers: headers };
    if (body) opts.body = JSON.stringify(body);
    var r = await fetch(path, opts);
    var data;
    try { data = await r.json(); } catch (_) { data = { error: "Bad response" }; }
    if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
    return data;
  }

  function getCurrentSiteId() {
    if (window.STATE?.currentSiteId) return window.STATE.currentSiteId;
    if (window.currentSite?.id) return window.currentSite.id;
    var el = document.querySelector("[data-site-id]");
    if (el) return el.dataset.siteId;
    return localStorage.getItem("mine_current_site_id") || null;
  }

  function getCurrentHtml() {
    if (window.STATE?.currentHtml) return window.STATE.currentHtml;
    var iframe = document.querySelector("iframe[data-site-preview]");
    if (iframe?.srcdoc) return iframe.srcdoc;
    return null;
  }

  // ─── Modal shell ─────────────────────────────────────────
  function openImportModal() {
    var overlay = document.createElement("div");
    overlay.id = "mine-import-overlay";
    overlay.style.cssText = "position:fixed;inset:0;z-index:999998;background:rgba(15,15,25,.72);backdrop-filter:blur(6px);display:flex;align-items:flex-end;animation:mineFadeIn .2s";
    overlay.innerHTML =
      '<div style="background:#fff;width:100%;max-height:92vh;border-radius:20px 20px 0 0;display:flex;flex-direction:column;animation:mineSlideUp .3s cubic-bezier(.2,.9,.3,1)">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #eee">' +
          '<div style="font-weight:800;font-size:16px;color:#111">📥 Import content</div>' +
          '<button id="mine-import-close" style="background:#f4f4f7;border:none;width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center">×</button>' +
        '</div>' +
        '<div id="mine-import-tabs" style="display:flex;gap:4px;padding:12px 18px 0;border-bottom:1px solid #eee;overflow-x:auto;white-space:nowrap">' +
          '<button data-tab="instagram" class="mine-tab mine-tab-active">📸 Instagram</button>' +
          '<button data-tab="reviews" class="mine-tab">⭐ Google Reviews</button>' +
          '<button data-tab="pdf" class="mine-tab">📄 PDF</button>' +
          '<button data-tab="website" class="mine-tab">🌐 Website</button>' +
        '</div>' +
        '<div id="mine-import-body" style="flex:1;overflow-y:auto;padding:18px"></div>' +
      '</div>';

    // Inject CSS once
    if (!document.getElementById("mine-import-css")) {
      var style = document.createElement("style");
      style.id = "mine-import-css";
      style.textContent =
        "@keyframes mineFadeIn { from { opacity: 0 } to { opacity: 1 } }" +
        "@keyframes mineSlideUp { from { transform: translateY(100%) } to { transform: translateY(0) } }" +
        ".mine-tab { background: transparent; border: none; padding: 10px 14px; border-radius: 10px 10px 0 0; font: 600 13px/1 system-ui; color: #666; cursor: pointer; border-bottom: 2px solid transparent }" +
        ".mine-tab-active { color: #635bff; border-bottom-color: #635bff; background: rgba(99,91,255,.06) }" +
        ".mine-import-field { display: block; width: 100%; padding: 12px 14px; border: 1.5px solid #e5e7eb; border-radius: 10px; font: 500 14px/1.4 system-ui; box-sizing: border-box; outline: none; transition: border-color .15s }" +
        ".mine-import-field:focus { border-color: #635bff }" +
        ".mine-import-btn { display: block; width: 100%; padding: 13px; border: none; border-radius: 12px; font: 700 14px/1 system-ui; cursor: pointer; background: linear-gradient(90deg,#635bff,#a855f7); color: #fff }" +
        ".mine-import-btn:disabled { opacity: .5; cursor: not-allowed }" +
        ".mine-import-label { display: block; font: 600 12px/1 system-ui; color: #444; margin-bottom: 6px }" +
        ".mine-import-help { font: 500 12px/1.4 system-ui; color: #888; margin-top: 6px }" +
        ".mine-import-card { background: #fafafa; border: 1px solid #eee; border-radius: 12px; padding: 14px; margin-bottom: 10px }";
      document.head.appendChild(style);
    }

    document.body.appendChild(overlay);

    overlay.querySelector("#mine-import-close").addEventListener("click", function () { overlay.remove(); });
    overlay.addEventListener("click", function (e) { if (e.target === overlay) overlay.remove(); });

    overlay.querySelectorAll(".mine-tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        overlay.querySelectorAll(".mine-tab").forEach(function (b) { b.classList.remove("mine-tab-active"); });
        btn.classList.add("mine-tab-active");
        renderTab(btn.dataset.tab);
      });
    });

    renderTab("instagram");
  }

  // ─── Tab renderers ───────────────────────────────────────
  function renderTab(tab) {
    var body = document.getElementById("mine-import-body");
    if (!body) return;
    if (tab === "instagram") body.innerHTML = instagramForm();
    if (tab === "reviews") body.innerHTML = reviewsForm();
    if (tab === "pdf") body.innerHTML = pdfForm();
    if (tab === "website") body.innerHTML = websiteForm();
    wireButtons();
  }

  function instagramForm() {
    return (
      '<div style="padding:14px;background:rgba(220,38,127,.06);border:1px solid rgba(220,38,127,.2);border-radius:12px;margin-bottom:14px">' +
        '<div style="font-weight:700;font-size:13px;margin-bottom:4px">📸 Import your Instagram feed</div>' +
        '<div style="font-size:12px;color:#666;line-height:1.5">Pulls your most recent posts into a grid. Requires your IG account to be connected in Settings → Social.</div>' +
      '</div>' +
      '<label class="mine-import-label">How many posts?</label>' +
      '<input type="number" id="ig-limit" class="mine-import-field" value="9" min="1" max="25">' +
      '<div class="mine-import-help">1-25 posts. Your most recent will be pulled.</div>' +
      '<div style="margin-top:16px">' +
        '<button id="ig-go" class="mine-import-btn">Import my Instagram posts</button>' +
      '</div>' +
      '<div id="ig-result" style="margin-top:16px"></div>'
    );
  }

  function reviewsForm() {
    return (
      '<div style="padding:14px;background:rgba(234,179,8,.06);border:1px solid rgba(234,179,8,.2);border-radius:12px;margin-bottom:14px">' +
        '<div style="font-weight:700;font-size:13px;margin-bottom:4px">⭐ Import your Google reviews</div>' +
        '<div style="font-size:12px;color:#666;line-height:1.5">Pulls your real customer reviews from Google Maps. Paste your business\'s Google Maps URL (the one people use to find you).</div>' +
      '</div>' +
      '<label class="mine-import-label">Google Maps URL</label>' +
      '<input type="url" id="gr-url" class="mine-import-field" placeholder="https://maps.app.goo.gl/... or https://www.google.com/maps/place/...">' +
      '<div class="mine-import-help">Or paste your raw Place ID (starts with "ChIJ...").</div>' +
      '<div style="margin-top:16px">' +
        '<button id="gr-go" class="mine-import-btn">Import my reviews</button>' +
      '</div>' +
      '<div id="gr-result" style="margin-top:16px"></div>'
    );
  }

  function pdfForm() {
    return (
      '<div style="padding:14px;background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.2);border-radius:12px;margin-bottom:14px">' +
        '<div style="font-weight:700;font-size:13px;margin-bottom:4px">📄 Import from PDF</div>' +
        '<div style="font-size:12px;color:#666;line-height:1.5">Upload a menu, brochure, or brief. AI extracts it into About, Services, and FAQ sections you can add to your site.</div>' +
      '</div>' +
      '<input type="file" id="pdf-file" accept="application/pdf" style="display:none">' +
      '<button id="pdf-pick" style="display:block;width:100%;padding:32px;border:2px dashed #d1d5db;border-radius:12px;background:#fafafa;font:600 14px/1.4 system-ui;color:#666;cursor:pointer">📎 Choose a PDF (max 20MB)</button>' +
      '<div id="pdf-selected" style="margin-top:10px;font-size:13px;color:#444"></div>' +
      '<div style="margin-top:16px">' +
        '<button id="pdf-go" class="mine-import-btn" disabled>Extract content from PDF</button>' +
      '</div>' +
      '<div id="pdf-result" style="margin-top:16px"></div>'
    );
  }

  function websiteForm() {
    return (
      '<div style="padding:14px;background:rgba(14,165,233,.06);border:1px solid rgba(14,165,233,.2);border-radius:12px;margin-bottom:14px">' +
        '<div style="font-weight:700;font-size:13px;margin-bottom:4px">🌐 Inspiration from any website</div>' +
        '<div style="font-size:12px;color:#666;line-height:1.5">Paste a URL you like. We extract its colour palette and font choices so you can match its vibe. <strong>Never copy their copy.</strong></div>' +
      '</div>' +
      '<label class="mine-import-label">Website URL</label>' +
      '<input type="url" id="ws-url" class="mine-import-field" placeholder="https://example.com">' +
      '<div class="mine-import-help">Public HTTPS pages only.</div>' +
      '<div style="margin-top:16px">' +
        '<button id="ws-go" class="mine-import-btn">Analyse design</button>' +
      '</div>' +
      '<div id="ws-result" style="margin-top:16px"></div>'
    );
  }

  // ─── Button wiring ───────────────────────────────────────
  function wireButtons() {
    var igGo = document.getElementById("ig-go");
    if (igGo) igGo.addEventListener("click", runInstagram);

    var grGo = document.getElementById("gr-go");
    if (grGo) grGo.addEventListener("click", runReviews);

    var pdfPick = document.getElementById("pdf-pick");
    var pdfFile = document.getElementById("pdf-file");
    var pdfGo = document.getElementById("pdf-go");
    if (pdfPick && pdfFile) {
      pdfPick.addEventListener("click", function () { pdfFile.click(); });
      pdfFile.addEventListener("change", function () {
        if (pdfFile.files[0]) {
          document.getElementById("pdf-selected").textContent = "📎 " + pdfFile.files[0].name + " (" + Math.round(pdfFile.files[0].size / 1024) + "KB)";
          pdfGo.disabled = false;
        }
      });
      pdfGo.addEventListener("click", runPdf);
    }

    var wsGo = document.getElementById("ws-url") && document.getElementById("ws-go");
    if (wsGo) document.getElementById("ws-go").addEventListener("click", runWebsite);
  }

  // ─── Import runners ──────────────────────────────────────
  async function runInstagram() {
    var limit = parseInt(document.getElementById("ig-limit").value) || 9;
    var resEl = document.getElementById("ig-result");
    var btn = document.getElementById("ig-go");
    btn.disabled = true; btn.textContent = "Importing…";
    resEl.innerHTML = '<div style="text-align:center;padding:20px;color:#666">⏳ Fetching from Instagram…</div>';

    try {
      var data = await apiCall("POST", "/api/content-import/instagram", { limit: limit });
      renderImportResult(resEl, {
        label: "Imported " + data.count + " Instagram posts",
        previewHtml: data.sectionHtml,
        thumbs: (data.posts || []).slice(0, 9).map(function (p) { return p.image; })
      });
    } catch (e) {
      resEl.innerHTML = '<div style="padding:14px;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;color:#991b1b;font-size:13px">❌ ' + esc(e.message) + '</div>';
    } finally {
      btn.disabled = false; btn.textContent = "Import my Instagram posts";
    }
  }

  async function runReviews() {
    var url = document.getElementById("gr-url").value.trim();
    if (!url) { toast("Paste a Google Maps URL first", "error"); return; }
    var resEl = document.getElementById("gr-result");
    var btn = document.getElementById("gr-go");
    btn.disabled = true; btn.textContent = "Importing…";
    resEl.innerHTML = '<div style="text-align:center;padding:20px;color:#666">⏳ Fetching reviews…</div>';

    try {
      // Try both possible endpoints (two versions exist)
      var data;
      try {
        data = await apiCall("POST", "/api/content-import/reviews", { placeUrl: url });
      } catch (_) {
        data = await apiCall("POST", "/api/imports/google-reviews", { placeUrl: url });
      }
      renderImportResult(resEl, {
        label: "Imported " + (data.reviews?.length || 0) + " reviews" + (data.rating ? " (★" + data.rating.toFixed(1) + ")" : ""),
        previewHtml: data.sectionHtml,
        thumbs: null,
        extraInfo: data.business ? ("Business: " + data.business + " · " + (data.total || data.reviews?.length || 0) + " total reviews") : ""
      });
    } catch (e) {
      resEl.innerHTML = '<div style="padding:14px;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;color:#991b1b;font-size:13px">❌ ' + esc(e.message) + '</div>';
    } finally {
      btn.disabled = false; btn.textContent = "Import my reviews";
    }
  }

  async function runPdf() {
    var file = document.getElementById("pdf-file").files[0];
    if (!file) { toast("Pick a PDF first", "error"); return; }
    if (file.size > 20 * 1024 * 1024) { toast("PDF too large (max 20MB)", "error"); return; }

    var resEl = document.getElementById("pdf-result");
    var btn = document.getElementById("pdf-go");
    btn.disabled = true; btn.textContent = "Extracting…";
    resEl.innerHTML = '<div style="text-align:center;padding:20px;color:#666">⏳ Reading PDF… may take 10-20s</div>';

    try {
      // Convert file to base64
      var b64 = await new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(String(reader.result).split(",")[1]); };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      var data;
      try {
        data = await apiCall("POST", "/api/content-import/pdf", { pdfBase64: b64 });
      } catch (_) {
        data = await apiCall("POST", "/api/imports/pdf", { pdfBase64: b64 });
      }

      // PDF import can return structured sections OR raw text
      if (data.textOnly) {
        resEl.innerHTML =
          '<div class="mine-import-card">' +
            '<div style="font-weight:700;margin-bottom:8px">📄 Extracted text (not structured)</div>' +
            '<textarea readonly style="width:100%;height:240px;padding:10px;border:1px solid #e5e7eb;border-radius:8px;font:13px/1.5 monospace;box-sizing:border-box">' + esc(data.extractedText) + '</textarea>' +
            '<div style="margin-top:10px;font-size:12px;color:#888">' + esc(data.note || "Raw text — paste into your site manually.") + '</div>' +
          '</div>';
      } else {
        // Structured output
        var html = '';
        if (data.about) html += '<div class="mine-import-card"><div style="font-weight:700;margin-bottom:6px">📝 About</div><div style="font-size:13px;line-height:1.5">' + esc(data.about) + '</div></div>';
        if (data.services?.length) {
          html += '<div class="mine-import-card"><div style="font-weight:700;margin-bottom:8px">🛠️ Services (' + data.services.length + ')</div>';
          data.services.forEach(function (s) {
            html += '<div style="padding:8px 0;border-bottom:1px solid #eee"><div style="font-weight:600;font-size:13px">' + esc(s.title) + '</div><div style="font-size:12px;color:#666">' + esc(s.description) + '</div></div>';
          });
          html += '</div>';
        }
        if (data.faq?.length) {
          html += '<div class="mine-import-card"><div style="font-weight:700;margin-bottom:8px">❓ FAQ (' + data.faq.length + ')</div>';
          data.faq.forEach(function (f) {
            html += '<div style="padding:8px 0;border-bottom:1px solid #eee"><div style="font-weight:600;font-size:13px">' + esc(f.q) + '</div><div style="font-size:12px;color:#666">' + esc(f.a) + '</div></div>';
          });
          html += '</div>';
        }
        // Build a section HTML from the parts
        var sectionHtml = buildPdfSection(data);
        resEl.innerHTML = html +
          '<div style="display:flex;gap:8px;margin-top:14px">' +
            '<button id="pdf-insert" class="mine-import-btn" style="flex:1">Add to site</button>' +
            '<button id="pdf-copy" style="flex:1;padding:13px;border:1.5px solid #e5e7eb;border-radius:12px;background:#fff;font:700 14px/1 system-ui;cursor:pointer">Copy HTML</button>' +
          '</div>';

        document.getElementById("pdf-insert").addEventListener("click", function () { insertIntoSite(sectionHtml); });
        document.getElementById("pdf-copy").addEventListener("click", function () { copyToClipboard(sectionHtml); });
      }
    } catch (e) {
      resEl.innerHTML = '<div style="padding:14px;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;color:#991b1b;font-size:13px">❌ ' + esc(e.message) + '</div>';
    } finally {
      btn.disabled = false; btn.textContent = "Extract content from PDF";
    }
  }

  async function runWebsite() {
    var url = document.getElementById("ws-url").value.trim();
    if (!url) { toast("Enter a URL first", "error"); return; }
    var resEl = document.getElementById("ws-result");
    var btn = document.getElementById("ws-go");
    btn.disabled = true; btn.textContent = "Analysing…";
    resEl.innerHTML = '<div style="text-align:center;padding:20px;color:#666">⏳ Fetching ' + esc(url) + '…</div>';

    try {
      var data;
      try {
        data = await apiCall("POST", "/api/content-import/website", { url: url });
      } catch (_) {
        data = await apiCall("POST", "/api/content-import/url", { url: url });
      }
      var palette = (data.palette || []).slice(0, 10);
      var fonts = (data.fonts || []).slice(0, 5);
      var html = '<div class="mine-import-card"><div style="font-weight:700;margin-bottom:10px">🎨 Colour palette</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:6px">' +
        palette.map(function (c) {
          return '<div style="display:flex;align-items:center;gap:4px;padding:4px 8px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;font-size:11px;font-family:monospace">' +
            '<span style="display:inline-block;width:14px;height:14px;border-radius:4px;background:' + esc(c) + '"></span>' + esc(c) + '</div>';
        }).join("") +
        '</div></div>';
      if (fonts.length) {
        html += '<div class="mine-import-card"><div style="font-weight:700;margin-bottom:8px">🔤 Fonts</div>' +
          fonts.map(function (f) { return '<div style="font-family:\'' + esc(f) + '\',sans-serif;font-size:14px;padding:4px 0">' + esc(f) + ' — the quick brown fox</div>'; }).join("") +
          '</div>';
      }
      html += '<div class="mine-import-card" style="background:#fef3c7;border-color:#fcd34d"><div style="font-size:12px;color:#92400e">⚠️ Use for design inspiration only. Never copy their copy or images.</div></div>';
      html += '<div style="margin-top:10px"><button id="ws-tell-ai" class="mine-import-btn">Ask AI to match this vibe</button></div>';
      resEl.innerHTML = html;

      var tellAi = document.getElementById("ws-tell-ai");
      if (tellAi) tellAi.addEventListener("click", function () {
        var prompt = "Update the site's colour palette to use these colours: " + palette.join(", ") +
          (fonts.length ? ". Use fonts similar to: " + fonts.join(", ") + "." : ".");
        var box = document.getElementById("d2-ai-global-prompt") || document.getElementById("se-ai-input");
        if (box) {
          box.value = prompt;
          document.getElementById("mine-import-overlay")?.remove();
          toast("Prompt filled — tap Apply with AI to continue", "info");
          box.focus();
        } else {
          navigator.clipboard.writeText(prompt);
          toast("Prompt copied — paste into the AI editor", "info");
        }
      });
    } catch (e) {
      resEl.innerHTML = '<div style="padding:14px;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;color:#991b1b;font-size:13px">❌ ' + esc(e.message) + '</div>';
    } finally {
      btn.disabled = false; btn.textContent = "Analyse design";
    }
  }

  // ─── Section preview + insert ────────────────────────────
  function renderImportResult(resEl, opts) {
    var thumbsHtml = "";
    if (opts.thumbs?.length) {
      thumbsHtml = '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin:10px 0">' +
        opts.thumbs.map(function (url) {
          return '<img src="' + esc(url) + '" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:6px" loading="lazy">';
        }).join("") + '</div>';
    }

    resEl.innerHTML =
      '<div class="mine-import-card">' +
        '<div style="font-weight:700;margin-bottom:4px">✅ ' + esc(opts.label) + '</div>' +
        (opts.extraInfo ? '<div style="font-size:12px;color:#666">' + esc(opts.extraInfo) + '</div>' : '') +
        thumbsHtml +
      '</div>' +
      '<div style="display:flex;gap:8px">' +
        '<button id="do-insert" class="mine-import-btn" style="flex:1">Add to site</button>' +
        '<button id="do-copy" style="flex:1;padding:13px;border:1.5px solid #e5e7eb;border-radius:12px;background:#fff;font:700 14px/1 system-ui;cursor:pointer">Copy HTML</button>' +
      '</div>';

    document.getElementById("do-insert")?.addEventListener("click", function () { insertIntoSite(opts.previewHtml); });
    document.getElementById("do-copy")?.addEventListener("click", function () { copyToClipboard(opts.previewHtml); });
  }

  async function insertIntoSite(sectionHtml) {
    var siteId = getCurrentSiteId();
    if (!siteId) { toast("Open a site first", "error"); return; }
    var currentHtml = getCurrentHtml();
    if (!currentHtml) {
      // Fallback: try fetching the site
      try {
        var r = await apiCall("GET", "/api/sites/" + siteId);
        currentHtml = r.site?.html;
      } catch (e) { toast("Could not load site", "error"); return; }
    }
    if (!currentHtml) { toast("Site is empty — create it first", "error"); return; }

    // Insert the section just before </main> if present, else before </body>
    var insertPoint = currentHtml.lastIndexOf("</main>");
    if (insertPoint < 0) insertPoint = currentHtml.lastIndexOf("</body>");
    if (insertPoint < 0) {
      toast("Can't find insert point in site", "error"); return;
    }
    var newHtml = currentHtml.slice(0, insertPoint) + "\n" + sectionHtml + "\n" + currentHtml.slice(insertPoint);

    try {
      // Save as a version first (so user can undo)
      await apiCall("POST", "/api/sites/" + siteId + "/versions", { html: currentHtml, label: "Before import" });
      // Update site
      await apiCall("PUT", "/api/sites/" + siteId, { html: newHtml });
      toast("✅ Added to site", "success");
      document.getElementById("mine-import-overlay")?.remove();
      // Refresh preview if possible
      if (window.STATE) window.STATE.currentHtml = newHtml;
      var iframe = document.querySelector("iframe[data-site-preview]");
      if (iframe) iframe.srcdoc = newHtml;
      if (window.mineAIEditor?.refreshPreview) window.mineAIEditor.refreshPreview(newHtml);
    } catch (e) {
      toast("Save failed: " + e.message, "error");
    }
  }

  function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(function () { toast("Copied to clipboard", "success"); })
      .catch(function () { toast("Copy failed — select manually", "error"); });
  }

  function buildPdfSection(data) {
    var parts = [];
    if (data.about) {
      parts.push('<section id="about" class="py-16 px-6">' +
        '<div class="max-w-3xl mx-auto text-center">' +
        '<h2 class="text-3xl md:text-4xl font-bold mb-4">About</h2>' +
        '<p class="text-gray-700 text-lg leading-relaxed">' + esc(data.about) + '</p>' +
        '</div></section>');
    }
    if (data.services?.length) {
      var services = data.services.map(function (s) {
        return '<div class="bg-white rounded-2xl p-6 shadow-sm border border-gray-100">' +
          '<h3 class="font-bold text-lg mb-2">' + esc(s.title) + '</h3>' +
          '<p class="text-gray-600">' + esc(s.description) + '</p></div>';
      }).join("");
      parts.push('<section id="services" class="py-16 px-6 bg-gray-50">' +
        '<div class="max-w-6xl mx-auto">' +
        '<h2 class="text-3xl md:text-4xl font-bold text-center mb-10">What we offer</h2>' +
        '<div class="grid md:grid-cols-2 lg:grid-cols-3 gap-6">' + services + '</div>' +
        '</div></section>');
    }
    if (data.faq?.length) {
      var faq = data.faq.map(function (f) {
        return '<details class="border-b border-gray-200 py-4">' +
          '<summary class="font-semibold cursor-pointer">' + esc(f.q) + '</summary>' +
          '<p class="text-gray-600 mt-3 leading-relaxed">' + esc(f.a) + '</p></details>';
      }).join("");
      parts.push('<section id="faq" class="py-16 px-6">' +
        '<div class="max-w-3xl mx-auto">' +
        '<h2 class="text-3xl md:text-4xl font-bold text-center mb-8">Frequently asked questions</h2>' +
        '<div>' + faq + '</div>' +
        '</div></section>');
    }
    return parts.join("\n\n");
  }

  // ─── Inject "Import" button into the Safety bar ──────────
  function injectImportButton() {
    // Find the Safety bar in the AI Site Editor card
    var bar = document.querySelector("#mine-rescue-bar, [data-mine-rescue-bar]");
    if (!bar) return false;
    if (bar.querySelector("[data-mine-import-btn]")) return true;  // already injected

    var btn = document.createElement("button");
    btn.setAttribute("data-mine-import-btn", "1");
    btn.type = "button";
    btn.textContent = "📥 Import";
    btn.style.cssText = "border:1px solid #e5e7eb;background:#fff;border-radius:8px;padding:7px 12px;font:600 12px/1 system-ui;color:#111;cursor:pointer;white-space:nowrap";
    btn.addEventListener("click", function (e) { e.preventDefault(); openImportModal(); });
    bar.appendChild(btn);
    return true;
  }

  // ─── Boot ────────────────────────────────────────────────
  function boot() {
    var tries = 0;
    var interval = setInterval(function () {
      tries++;
      if (injectImportButton() || tries > 40) clearInterval(interval);
    }, 500);

    // Re-inject if DOM changes swap out the Safety bar (e.g. user navigates panels)
    new MutationObserver(function () { injectImportButton(); })
      .observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // Expose
  window.mineContentImport = {
    open: openImportModal,
    instagram: runInstagram,
    reviews: runReviews,
    pdf: runPdf,
    website: runWebsite
  };
})();
