// ════════════════════════════════════════════════════════════════════
// mine-form-wizard.js — Smart form wiring for the AI Site Editor
// ════════════════════════════════════════════════════════════════════
// Every MINE-published site already auto-captures form submissions via
// the script injected by backend/routes/hosting.js (goes to
// /api/features/forms/submission-notify). Submissions land in CRM,
// trigger email notifications, and enter funnels.
//
// What was missing: a WAY for the user to SEE this, configure what
// happens, and preview their form before publishing.
//
// This module adds a "⚙️ Wire forms" button to the Safety bar that:
//   1. Scans the current site HTML for <form> tags
//   2. Shows each form with its fields
//   3. Lets the user choose a Destination for each form:
//       - Email notification only (default)
//       - CRM lead + email (default wiring — already happens)
//       - Booking (creates a calendar booking)
//       - Course signup (enrols in a course)
//       - Membership signup (starts a Stripe subscription)
//       - Custom webhook
//   4. Saves a form_config record (new table) keyed by form name
//   5. Backend reads this config on submission and routes accordingly
// ════════════════════════════════════════════════════════════════════

(function () {
  "use strict";

  if (window.mineFormWizard) return;
  window.mineFormWizard = {};

  // ─── Helpers ─────────────────────────────────────────────
  function esc(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function toast(msg, kind) {
    if (window.mineAIEditor?.toast) return window.mineAIEditor.toast(msg, kind);
    var t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:999999;background:" + (kind === "error" ? "#dc2626" : "#111") + ";color:#fff;padding:12px 18px;border-radius:10px;font:600 13px/1.4 system-ui;box-shadow:0 8px 24px rgba(0,0,0,.2)";
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

  async function loadCurrentHtml() {
    if (window.STATE?.currentHtml) return window.STATE.currentHtml;
    var iframe = document.querySelector("iframe[data-site-preview]");
    if (iframe?.srcdoc) return iframe.srcdoc;
    var siteId = getCurrentSiteId();
    if (!siteId) return null;
    try {
      var r = await apiCall("GET", "/api/sites/" + siteId);
      return r.site?.html || null;
    } catch (_) { return null; }
  }

  // ─── Parse forms from site HTML ──────────────────────────
  function parseForms(html) {
    if (!html) return [];
    // Use DOMParser to safely extract forms
    var doc;
    try { doc = new DOMParser().parseFromString(html, "text/html"); }
    catch (_) { return []; }

    var forms = Array.from(doc.querySelectorAll("form"));
    return forms.map(function (form, idx) {
      var name = form.getAttribute("data-form-name")
                 || form.getAttribute("name")
                 || form.id
                 || ("Form " + (idx + 1));
      var fields = Array.from(form.querySelectorAll("input,select,textarea")).map(function (el) {
        return {
          type: el.type || el.tagName.toLowerCase(),
          name: el.name || el.id || "",
          placeholder: el.placeholder || "",
          required: el.required || el.hasAttribute("required"),
          label: (el.previousElementSibling?.tagName === "LABEL" ? el.previousElementSibling.textContent : "") || el.getAttribute("aria-label") || ""
        };
      }).filter(function (f) { return f.type !== "hidden" && f.type !== "submit"; });
      var submit = form.querySelector("button[type=submit],input[type=submit],button:last-child");
      var submitText = submit ? (submit.textContent || submit.value || "Submit").trim() : "Submit";
      return { idx: idx, name: name, fields: fields, submitText: submitText };
    });
  }

  // ─── Modal ───────────────────────────────────────────────
  async function openFormWizard() {
    var siteId = getCurrentSiteId();
    if (!siteId) { toast("Open a site first", "error"); return; }

    var overlay = document.createElement("div");
    overlay.id = "mine-form-wizard";
    overlay.style.cssText = "position:fixed;inset:0;z-index:999998;background:rgba(15,15,25,.72);backdrop-filter:blur(6px);display:flex;align-items:flex-end;animation:mineFadeIn .2s";
    overlay.innerHTML =
      '<div style="background:#fff;width:100%;max-height:92vh;border-radius:20px 20px 0 0;display:flex;flex-direction:column;animation:mineSlideUp .3s cubic-bezier(.2,.9,.3,1)">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #eee">' +
          '<div style="font-weight:800;font-size:16px;color:#111">⚙️ Form actions</div>' +
          '<button id="fw-close" style="background:#f4f4f7;border:none;width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:18px">×</button>' +
        '</div>' +
        '<div id="fw-body" style="flex:1;overflow-y:auto;padding:18px">⏳ Scanning your site for forms…</div>' +
      '</div>';

    if (!document.getElementById("mine-import-css")) {
      var style = document.createElement("style");
      style.textContent = "@keyframes mineFadeIn { from { opacity: 0 } to { opacity: 1 } } @keyframes mineSlideUp { from { transform: translateY(100%) } to { transform: translateY(0) } }";
      document.head.appendChild(style);
    }
    document.body.appendChild(overlay);
    overlay.querySelector("#fw-close").addEventListener("click", function () { overlay.remove(); });
    overlay.addEventListener("click", function (e) { if (e.target === overlay) overlay.remove(); });

    // Load forms + config
    var html = await loadCurrentHtml();
    var forms = parseForms(html);
    var configs;
    try {
      var resp = await apiCall("GET", "/api/sites/" + siteId + "/form-configs");
      configs = resp.configs || {};
    } catch (_) { configs = {}; }

    renderForms(forms, configs, siteId);
  }

  function renderForms(forms, configs, siteId) {
    var body = document.getElementById("fw-body");
    if (!body) return;

    if (forms.length === 0) {
      body.innerHTML =
        '<div style="text-align:center;padding:40px 20px">' +
          '<div style="font-size:48px">📋</div>' +
          '<div style="font-weight:700;font-size:16px;margin:12px 0 8px">No forms found</div>' +
          '<div style="font-size:13px;color:#666;line-height:1.5">Your site doesn\'t have any &lt;form&gt; tags. Ask the AI editor to add one:<br><em>"Add a contact form with name, email, and message fields."</em></div>' +
        '</div>';
      return;
    }

    body.innerHTML =
      '<div style="padding:14px;background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.25);border-radius:12px;margin-bottom:16px">' +
        '<div style="font-weight:700;font-size:13px;margin-bottom:4px">✅ All forms already work</div>' +
        '<div style="font-size:12px;color:#444;line-height:1.5">Every submission is saved to your CRM and emails you automatically. Use this to add extra actions — calendar booking, Stripe, etc.</div>' +
      '</div>' +
      '<div id="fw-forms"></div>';

    var list = document.getElementById("fw-forms");
    forms.forEach(function (f) {
      var cfg = configs[f.name] || { action: "crm_email" };
      list.appendChild(renderFormCard(f, cfg, siteId));
    });
  }

  function renderFormCard(form, cfg, siteId) {
    var card = document.createElement("div");
    card.style.cssText = "background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:16px;margin-bottom:12px";

    var fieldsHtml = form.fields.map(function (f) {
      return '<span style="display:inline-block;padding:3px 8px;background:#f4f4f7;border-radius:6px;font-size:11px;font-family:monospace;margin:2px">' +
        esc(f.name || f.type) + (f.required ? ' *' : '') + '</span>';
    }).join("");

    card.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
        '<div>' +
          '<div style="font-weight:700;font-size:14px">📋 ' + esc(form.name) + '</div>' +
          '<div style="font-size:11px;color:#888">' + form.fields.length + ' field' + (form.fields.length === 1 ? '' : 's') + ' · submits "' + esc(form.submitText) + '"</div>' +
        '</div>' +
      '</div>' +
      '<div style="margin-bottom:14px">' + fieldsHtml + '</div>' +
      '<label style="display:block;font:600 12px/1 system-ui;color:#444;margin-bottom:6px">When someone submits this form:</label>' +
      '<select data-fw-action style="width:100%;padding:12px;border:1.5px solid #e5e7eb;border-radius:10px;font:500 14px/1 system-ui;background:#fff;outline:none">' +
        option("crm_email", cfg.action, "📧 Email me + save as lead (default)") +
        option("booking", cfg.action, "📅 Create a calendar booking") +
        option("course_enroll", cfg.action, "🎓 Enrol in a course") +
        option("membership", cfg.action, "👑 Start a membership (requires Stripe)") +
        option("waitlist", cfg.action, "⏳ Add to a waitlist") +
        option("webhook", cfg.action, "🔌 Send to a custom webhook URL") +
      '</select>' +
      '<div data-fw-extras style="margin-top:12px"></div>' +
      '<div style="margin-top:14px;display:flex;gap:8px">' +
        '<button data-fw-save style="flex:1;padding:11px;border:none;border-radius:10px;background:linear-gradient(90deg,#635bff,#a855f7);color:#fff;font:700 13px/1 system-ui;cursor:pointer">Save this action</button>' +
        '<button data-fw-test style="padding:11px 14px;border:1.5px solid #e5e7eb;border-radius:10px;background:#fff;font:700 13px/1 system-ui;cursor:pointer">Test</button>' +
      '</div>' +
      '<div data-fw-status style="margin-top:8px;font-size:12px;color:#888"></div>';

    var sel = card.querySelector("[data-fw-action]");
    var extras = card.querySelector("[data-fw-extras]");
    var saveBtn = card.querySelector("[data-fw-save]");
    var testBtn = card.querySelector("[data-fw-test]");
    var status = card.querySelector("[data-fw-status]");

    function renderExtras() {
      extras.innerHTML = "";
      var val = sel.value;
      if (val === "booking") {
        extras.innerHTML =
          '<label style="display:block;font:600 12px/1 system-ui;color:#444;margin:10px 0 6px">Default duration (minutes)</label>' +
          '<input type="number" data-fw-param="duration" value="' + (cfg.duration || 30) + '" min="15" max="240" style="width:100%;padding:12px;border:1.5px solid #e5e7eb;border-radius:10px;font:500 14px/1 system-ui;outline:none">';
      } else if (val === "course_enroll") {
        extras.innerHTML =
          '<label style="display:block;font:600 12px/1 system-ui;color:#444;margin:10px 0 6px">Course ID</label>' +
          '<input type="text" data-fw-param="courseId" value="' + esc(cfg.courseId || "") + '" placeholder="e.g. course_abc123" style="width:100%;padding:12px;border:1.5px solid #e5e7eb;border-radius:10px;font:500 14px/1 system-ui;outline:none">';
      } else if (val === "membership") {
        extras.innerHTML =
          '<label style="display:block;font:600 12px/1 system-ui;color:#444;margin:10px 0 6px">Stripe price ID</label>' +
          '<input type="text" data-fw-param="priceId" value="' + esc(cfg.priceId || "") + '" placeholder="price_1Oxxx..." style="width:100%;padding:12px;border:1.5px solid #e5e7eb;border-radius:10px;font:500 14px/1 system-ui;outline:none">';
      } else if (val === "waitlist") {
        extras.innerHTML =
          '<label style="display:block;font:600 12px/1 system-ui;color:#444;margin:10px 0 6px">Waitlist name</label>' +
          '<input type="text" data-fw-param="waitlistName" value="' + esc(cfg.waitlistName || form.name) + '" style="width:100%;padding:12px;border:1.5px solid #e5e7eb;border-radius:10px;font:500 14px/1 system-ui;outline:none">';
      } else if (val === "webhook") {
        extras.innerHTML =
          '<label style="display:block;font:600 12px/1 system-ui;color:#444;margin:10px 0 6px">Webhook URL</label>' +
          '<input type="url" data-fw-param="webhookUrl" value="' + esc(cfg.webhookUrl || "") + '" placeholder="https://hooks.zapier.com/..." style="width:100%;padding:12px;border:1.5px solid #e5e7eb;border-radius:10px;font:500 14px/1 system-ui;outline:none">' +
          '<div style="margin-top:6px;font-size:11px;color:#888">Submissions will POST as JSON.</div>';
      }
    }
    sel.addEventListener("change", renderExtras);
    renderExtras();

    saveBtn.addEventListener("click", async function () {
      saveBtn.disabled = true; saveBtn.textContent = "Saving…";
      var config = { action: sel.value };
      extras.querySelectorAll("[data-fw-param]").forEach(function (el) {
        config[el.dataset.fwParam] = el.value;
      });
      try {
        await apiCall("PUT", "/api/sites/" + siteId + "/form-configs", {
          formName: form.name,
          config: config
        });
        status.textContent = "✅ Saved — takes effect on next published version.";
        status.style.color = "#16a34a";
      } catch (e) {
        status.textContent = "❌ " + e.message;
        status.style.color = "#dc2626";
      } finally {
        saveBtn.disabled = false; saveBtn.textContent = "Save this action";
      }
    });

    testBtn.addEventListener("click", async function () {
      testBtn.disabled = true; testBtn.textContent = "Testing…";
      status.textContent = "Sending a test submission…";
      status.style.color = "#666";
      var fields = {};
      form.fields.forEach(function (f) {
        if (f.name) fields[f.name] = "test_" + (f.type === "email" ? "test@mine.app" : f.name);
      });
      try {
        var r = await fetch("/api/features/forms/submission-notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            siteId: siteId,
            formName: form.name,
            submitterEmail: "test@mine.app",
            submitterName: "Test Submission",
            fields: fields
          })
        });
        if (r.ok) {
          status.textContent = "✅ Test submission sent. Check your inbox + CRM.";
          status.style.color = "#16a34a";
        } else {
          status.textContent = "❌ HTTP " + r.status;
          status.style.color = "#dc2626";
        }
      } catch (e) {
        status.textContent = "❌ " + e.message;
        status.style.color = "#dc2626";
      } finally {
        testBtn.disabled = false; testBtn.textContent = "Test";
      }
    });

    return card;
  }

  function option(value, current, label) {
    return '<option value="' + value + '"' + (current === value ? ' selected' : '') + '>' + esc(label) + '</option>';
  }

  // ─── Inject "Wire forms" button ──────────────────────────
  function injectButton() {
    var bar = document.querySelector("#mine-rescue-bar, [data-mine-rescue-bar]");
    if (!bar) return false;
    if (bar.querySelector("[data-mine-form-wizard-btn]")) return true;

    var btn = document.createElement("button");
    btn.setAttribute("data-mine-form-wizard-btn", "1");
    btn.type = "button";
    btn.textContent = "⚙️ Forms";
    btn.style.cssText = "border:1px solid #e5e7eb;background:#fff;border-radius:8px;padding:7px 12px;font:600 12px/1 system-ui;color:#111;cursor:pointer;white-space:nowrap";
    btn.addEventListener("click", function (e) { e.preventDefault(); openFormWizard(); });
    bar.appendChild(btn);
    return true;
  }

  function boot() {
    var tries = 0;
    var interval = setInterval(function () {
      tries++;
      if (injectButton() || tries > 40) clearInterval(interval);
    }, 500);
    new MutationObserver(function () { injectButton(); })
      .observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.mineFormWizard = { open: openFormWizard, parseForms: parseForms };
})();
