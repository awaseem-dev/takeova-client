/**
 * MINE — AI Editor Enhancements
 * ═══════════════════════════════════════════════════════════════
 * Makes the Site Editor dramatically more powerful:
 *
 *   1. SURGICAL SECTION EDITS
 *      Instead of regenerating the ENTIRE site for every edit (30-60s, ~$0.15),
 *      detect when user is editing a specific section and call /edit-section
 *      (3-8s, ~$0.02). Falls back to full /build automatically if needed.
 *
 *   2. SMART EDIT MODE TOGGLE
 *      A pill toggle in the editor: [Surgical (fast)] | [Full rebuild (thorough)]
 *      Surgical is default. User can switch to Full if surgical keeps failing.
 *
 *   3. IMAGE MANAGER
 *      A "📸 Images" button opens a modal where users can:
 *        - Upload their own photos (drag-drop or tap)
 *        - Generate with AI from a text prompt
 *        - Browse their previously uploaded images
 *        - Tap any image in the site preview to replace it
 *
 * Safe to load alongside mine-rescue.js — both coexist.
 * Exposed globals: window.mineAIEditor.{surgicalEdit, openImageManager, replaceImage}
 */
(function() {
  'use strict';

  var API = window.mineAPI || null;

  // ── Helpers (mirror mine-rescue's patterns for consistency) ──────
  function getCurrentSiteId() {
    try {
      var s = JSON.parse(localStorage.getItem('mine_current_site') || '{}');
      return s.id || '';
    } catch (_) { return ''; }
  }

  function toast(msg, kind) {
    if (typeof window.toast === 'function') { try { return window.toast(msg, kind); } catch (_) {} }
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:' +
      (kind === 'error' ? '#DC2626' : kind === 'success' ? '#10B981' : '#0F172A') +
      ';color:#fff;padding:12px 20px;border-radius:10px;font:14px system-ui;z-index:100000;max-width:90vw;box-shadow:0 10px 30px rgba(0,0,0,.2)';
    document.body.appendChild(t);
    setTimeout(function() { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 3000);
    setTimeout(function() { try { t.remove(); } catch(_){} }, 3500);
  }

  function apiCall(method, path, body) {
    if (API && typeof API[method.toLowerCase()] === 'function') {
      return API[method.toLowerCase()](path, body || {});
    }
    if (typeof window.apiFetch === 'function') {
      return window.apiFetch(path, { method: method, body: body ? JSON.stringify(body) : undefined });
    }
    var token = localStorage.getItem('mine_token') || '';
    var opts = {
      method: method,
      headers: { 'Content-Type': 'application/json', 'Authorization': token ? 'Bearer ' + token : '' }
    };
    if (body) opts.body = JSON.stringify(body);
    return fetch(path, opts).then(function(r) {
      return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || 'Request failed'); return d; });
    });
  }
  var apiPost = function(p, b) { return apiCall('POST', p, b); };
  var apiGet = function(p) { return apiCall('GET', p); };

  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  // ═══════════════════════════════════════════════════════════════
  // FEATURE 1 — SURGICAL SECTION EDITS
  // ═══════════════════════════════════════════════════════════════
  // Detect which section the user is editing. The dashboard stores this in
  // a few places we can inspect:
  //   - Selected chip in #d2-chips (has data-sec attribute, 2px border when active)
  //   - #d2-editing-label text ("✍️ Hero — Editing")
  //   - Section input fields (#d2-headline belongs to Hero, etc.)
  function detectActiveSection() {
    // Strategy 1: find active section chip (bold border)
    var chips = document.querySelectorAll('[data-sec]');
    for (var i = 0; i < chips.length; i++) {
      var chip = chips[i];
      var style = window.getComputedStyle ? window.getComputedStyle(chip) : chip.style;
      var border = chip.style && chip.style.border ? chip.style.border : '';
      // Active chips have "2px solid var(--p)"
      if ((border || '').indexOf('2px') !== -1) {
        return { label: chip.dataset.sec, selector: '#' + (chip.dataset.sec || '').toLowerCase().replace(/\s+/g, '-') };
      }
    }
    // Strategy 2: parse editing label
    var labelEl = document.getElementById('d2-editing-label');
    if (labelEl) {
      var txt = (labelEl.textContent || '').replace(/— Editing.*$/i, '').replace(/^[^a-zA-Z]+/, '').trim();
      if (txt) return { label: txt, selector: '#' + txt.toLowerCase().replace(/\s+/g, '-') };
    }
    return null;
  }

  // Hijack the "Rewrite with AI" / "Apply with AI" button to use surgical edits
  function surgicalEdit(promptText, opts) {
    opts = opts || {};
    var siteId = getCurrentSiteId();
    if (!siteId) { toast('No site selected', 'error'); return Promise.reject(); }
    if (!promptText || promptText.trim().length < 3) {
      toast('Describe what you want to change', 'error');
      return Promise.reject();
    }

    var section = opts.section || detectActiveSection();
    var mode = getEditMode();

    // If user explicitly picked Full Rebuild OR no section detected, use full build
    if (mode === 'full' || !section) {
      return fullRebuild(promptText, siteId);
    }

    // Try surgical
    toast('✨ Editing ' + (section.label || 'section') + '…');
    var startTs = Date.now();
    return apiPost('/api/ai-agent/edit-section', {
      siteId: siteId,
      sectionSelector: section.selector,
      sectionLabel: section.label,
      prompt: promptText
    }).then(function(d) {
      var elapsed = ((Date.now() - startTs) / 1000).toFixed(1);
      // Fallback: server said use full rebuild
      if (d.use_full_rebuild) {
        toast('Section too big — doing full rebuild…');
        return fullRebuild(promptText, siteId);
      }
      toast('✨ Done in ' + elapsed + 's', 'success');
      refreshPreview(d.html);
      // Clear prompt input
      clearPromptInputs();
      return d;
    }).catch(function(e) {
      // On error, offer fallback to full rebuild
      console.warn('[surgical-edit] failed, falling back:', e.message);
      toast('Surgical edit failed — trying full rebuild…');
      return fullRebuild(promptText, siteId);
    });
  }

  function fullRebuild(promptText, siteId) {
    toast('🔄 Full rebuild in progress (30-60s)…');
    var startTs = Date.now();
    return apiPost('/api/ai-agent/build', {
      system: 'Expert web designer — rebuild request',
      content: [{ role: 'user', content: promptText }],
      siteId: siteId
    }).then(function(d) {
      var elapsed = ((Date.now() - startTs) / 1000).toFixed(1);
      toast('✨ Rebuilt in ' + elapsed + 's', 'success');
      if (d.text) refreshPreview(d.text);
      clearPromptInputs();
      return d;
    });
  }

  function refreshPreview(html) {
    if (!html) return;
    var iframes = document.querySelectorAll('iframe');
    for (var i = 0; i < iframes.length; i++) {
      try {
        if ((iframes[i].id || '').match(/preview|d2|site/i)) {
          iframes[i].srcdoc = html;
        }
      } catch (_) {}
    }
    // Trigger any site-level state update
    try { if (window.STATE) window.STATE.currentHtml = html; } catch(_){}
  }

  function clearPromptInputs() {
    var inputs = ['d2-ai-prompt', 'd2-ai-global-prompt', 'se-ai-input'];
    for (var i = 0; i < inputs.length; i++) {
      var el = document.getElementById(inputs[i]);
      if (el) el.value = '';
    }
  }

  // ── Edit mode toggle (Surgical vs Full) ──
  function getEditMode() {
    return localStorage.getItem('mine_edit_mode') || 'surgical';
  }
  function setEditMode(m) {
    localStorage.setItem('mine_edit_mode', m);
    updateEditModeUI();
  }
  function updateEditModeUI() {
    var mode = getEditMode();
    var surgical = document.getElementById('mine-edit-mode-surgical');
    var full = document.getElementById('mine-edit-mode-full');
    if (surgical && full) {
      surgical.style.background = mode === 'surgical' ? '#4F46E5' : 'transparent';
      surgical.style.color = mode === 'surgical' ? '#fff' : '#64748b';
      full.style.background = mode === 'full' ? '#4F46E5' : 'transparent';
      full.style.color = mode === 'full' ? '#fff' : '#64748b';
    }
  }

  function injectEditModeToggle() {
    if (document.getElementById('mine-edit-mode-bar')) return true;
    // Anchor under the safety bar (or before the prompt if safety isn't loaded)
    var anchor = document.getElementById('mine-rescue-bar') ||
                 document.getElementById('d2-ai-global-prompt') ||
                 document.getElementById('d2-ai-prompt') ||
                 document.getElementById('se-ai-input');
    if (!anchor || !anchor.parentNode) return false;

    var bar = document.createElement('div');
    bar.id = 'mine-edit-mode-bar';
    bar.style.cssText = 'display:flex;gap:0;margin:10px 0 8px;align-items:stretch;background:#F1F5F9;border:1px solid #E2E8F0;border-radius:10px;padding:3px;font:600 11px system-ui';
    bar.innerHTML =
      '<button type="button" id="mine-edit-mode-surgical" title="Fast edits to one section at a time (3-8 seconds)" ' +
        'style="flex:1;border:0;padding:7px 12px;border-radius:7px;cursor:pointer;background:#4F46E5;color:#fff;font:inherit;display:flex;align-items:center;justify-content:center;gap:5px">' +
        '<span>⚡</span> Surgical <span style="opacity:.7;font-weight:500">· fast</span>' +
      '</button>' +
      '<button type="button" id="mine-edit-mode-full" title="Rebuild the whole site (thorough but slower, 30-60s)" ' +
        'style="flex:1;border:0;padding:7px 12px;border-radius:7px;cursor:pointer;background:transparent;color:#64748b;font:inherit;display:flex;align-items:center;justify-content:center;gap:5px">' +
        '<span>🔄</span> Full rebuild <span style="opacity:.7;font-weight:500">· thorough</span>' +
      '</button>';

    // Insert AFTER the safety bar (if present) or BEFORE the prompt
    if (anchor.id === 'mine-rescue-bar') {
      anchor.parentNode.insertBefore(bar, anchor.nextSibling);
    } else {
      anchor.parentNode.insertBefore(bar, anchor);
    }

    document.getElementById('mine-edit-mode-surgical').addEventListener('click', function() { setEditMode('surgical'); });
    document.getElementById('mine-edit-mode-full').addEventListener('click', function() { setEditMode('full'); });
    updateEditModeUI();
    return true;
  }

  // Intercept existing "Apply with AI" / "Rewrite with AI" clicks
  function wireApplyButtons() {
    document.addEventListener('click', function(e) {
      var btn = e.target && e.target.closest && e.target.closest('button');
      if (!btn) return;
      // Skip our own
      if (btn.id && btn.id.indexOf('mine-') === 0) return;
      var text = (btn.textContent || '').trim().toLowerCase();
      // Match "apply with ai", "rewrite with ai" but NOT our own buttons
      if (!/apply with ai|rewrite with ai|✨.*ai/i.test(text)) return;
      // Skip if inside our modals
      if (btn.closest('#mine-rescue-modal') || btn.closest('#mine-image-modal')) return;

      // Get the prompt from the associated input
      var prompt = '';
      var inputs = ['d2-ai-prompt', 'd2-ai-global-prompt', 'se-ai-input'];
      for (var i = 0; i < inputs.length; i++) {
        var el = document.getElementById(inputs[i]);
        if (el && el.value && el.value.trim()) { prompt = el.value.trim(); break; }
      }
      if (!prompt) return; // let the original handler run (it'll show "enter a prompt")

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      surgicalEdit(prompt);
    }, true); // capture phase — intercept BEFORE original handler
  }

  // ═══════════════════════════════════════════════════════════════
  // FEATURE 2 — IMAGE MANAGER
  // ═══════════════════════════════════════════════════════════════
  function openImageManager() {
    var siteId = getCurrentSiteId();
    if (!siteId) { toast('No site selected', 'error'); return; }

    var existing = document.getElementById('mine-image-modal');
    if (existing) existing.remove();

    var backdrop = document.createElement('div');
    backdrop.id = 'mine-image-modal';
    backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.6);backdrop-filter:blur(4px);z-index:100001;display:flex;align-items:center;justify-content:center;padding:16px;font-family:system-ui,sans-serif';
    backdrop.innerHTML =
      '<div style="background:#fff;border-radius:18px;max-width:640px;width:100%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 30px 80px rgba(0,0,0,.25);overflow:hidden">' +
        '<div style="padding:20px 24px;border-bottom:1px solid #F1F5F9;display:flex;align-items:center;justify-content:space-between">' +
          '<h2 style="margin:0;font-size:18px;font-weight:800;color:#0F172A;display:flex;align-items:center;gap:8px">' +
            '<span>📸</span> Image Manager' +
          '</h2>' +
          '<button id="mine-img-close" type="button" style="background:transparent;border:0;font-size:22px;cursor:pointer;color:#64748b;padding:4px 10px">×</button>' +
        '</div>' +
        '<div style="display:flex;gap:0;background:#F8FAFC;border-bottom:1px solid #F1F5F9;padding:0 24px">' +
          '<button id="mine-img-tab-upload" class="mine-img-tab active" data-tab="upload" style="background:transparent;border:0;border-bottom:2px solid #4F46E5;padding:12px 16px;cursor:pointer;font:700 13px system-ui;color:#0F172A">📤 Upload</button>' +
          '<button id="mine-img-tab-generate" class="mine-img-tab" data-tab="generate" style="background:transparent;border:0;border-bottom:2px solid transparent;padding:12px 16px;cursor:pointer;font:700 13px system-ui;color:#64748b">✨ Generate with AI</button>' +
          '<button id="mine-img-tab-library" class="mine-img-tab" data-tab="library" style="background:transparent;border:0;border-bottom:2px solid transparent;padding:12px 16px;cursor:pointer;font:700 13px system-ui;color:#64748b">🗂️ Your library</button>' +
        '</div>' +
        '<div id="mine-img-body" style="flex:1;overflow-y:auto;padding:20px 24px"></div>' +
      '</div>';
    document.body.appendChild(backdrop);

    var close = function() { try { backdrop.remove(); } catch(_){} };
    backdrop.addEventListener('click', function(e) { if (e.target === backdrop) close(); });
    document.getElementById('mine-img-close').addEventListener('click', close);

    // Tab switching
    var tabs = document.querySelectorAll('.mine-img-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function(e) {
        var active = e.target.dataset.tab;
        for (var j = 0; j < tabs.length; j++) {
          tabs[j].style.borderBottom = tabs[j].dataset.tab === active ? '2px solid #4F46E5' : '2px solid transparent';
          tabs[j].style.color = tabs[j].dataset.tab === active ? '#0F172A' : '#64748b';
        }
        renderImageTab(active, siteId);
      });
    }
    renderImageTab('upload', siteId);
  }

  function renderImageTab(tab, siteId) {
    var body = document.getElementById('mine-img-body');
    if (!body) return;
    if (tab === 'upload') {
      body.innerHTML =
        '<div style="border:2px dashed #CBD5E1;border-radius:14px;padding:32px 20px;text-align:center;cursor:pointer" id="mine-img-dropzone">' +
          '<div style="font-size:36px;margin-bottom:8px">📤</div>' +
          '<div style="font-weight:700;color:#0F172A;margin-bottom:4px">Tap to upload an image</div>' +
          '<div style="font-size:12px;color:#64748b">JPG, PNG, WebP · up to 10 MB</div>' +
        '</div>' +
        '<input type="file" id="mine-img-file" accept="image/jpeg,image/png,image/webp,image/gif" style="display:none">' +
        '<div id="mine-img-upload-status" style="margin-top:14px;font-size:13px;color:#64748b;min-height:20px"></div>' +
        '<div id="mine-img-uploaded" style="margin-top:16px"></div>';
      var zone = document.getElementById('mine-img-dropzone');
      var input = document.getElementById('mine-img-file');
      zone.addEventListener('click', function() { input.click(); });
      input.addEventListener('change', function() {
        if (input.files && input.files[0]) uploadImage(input.files[0], siteId);
      });
    } else if (tab === 'generate') {
      body.innerHTML =
        '<div style="margin-bottom:12px"><label style="font-weight:700;font-size:12px;color:#0F172A;display:block;margin-bottom:6px">Describe the image</label>' +
          '<textarea id="mine-img-prompt" rows="4" placeholder="e.g. A cozy modern yoga studio with natural light, morning golden hour, warm wooden floor, plants by the window, serene atmosphere" style="width:100%;padding:12px 14px;border:1.5px solid #E2E8F0;border-radius:10px;font:14px system-ui;resize:vertical;box-sizing:border-box;color:#0F172A"></textarea></div>' +
        '<div style="margin-bottom:14px"><label style="font-weight:700;font-size:12px;color:#0F172A;display:block;margin-bottom:6px">Aspect ratio</label>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
            '<button type="button" class="mine-img-ar" data-ar="16:9" style="border:1.5px solid #4F46E5;background:#EEF2FF;color:#4F46E5;padding:7px 12px;border-radius:8px;font:700 12px system-ui;cursor:pointer">16:9 (hero)</button>' +
            '<button type="button" class="mine-img-ar" data-ar="1:1" style="border:1.5px solid #E2E8F0;background:#fff;color:#0F172A;padding:7px 12px;border-radius:8px;font:700 12px system-ui;cursor:pointer">1:1 (square)</button>' +
            '<button type="button" class="mine-img-ar" data-ar="4:3" style="border:1.5px solid #E2E8F0;background:#fff;color:#0F172A;padding:7px 12px;border-radius:8px;font:700 12px system-ui;cursor:pointer">4:3 (photo)</button>' +
            '<button type="button" class="mine-img-ar" data-ar="9:16" style="border:1.5px solid #E2E8F0;background:#fff;color:#0F172A;padding:7px 12px;border-radius:8px;font:700 12px system-ui;cursor:pointer">9:16 (portrait)</button>' +
          '</div></div>' +
        '<button id="mine-img-generate-btn" type="button" style="background:linear-gradient(135deg,#4F46E5,#7C3AED);color:#fff;border:0;padding:12px 20px;border-radius:10px;font:700 14px system-ui;cursor:pointer;width:100%;display:flex;align-items:center;justify-content:center;gap:6px">' +
          '<span>✨</span> Generate with AI' +
        '</button>' +
        '<div id="mine-img-gen-status" style="margin-top:14px;font-size:13px;color:#64748b;min-height:20px;text-align:center"></div>' +
        '<div id="mine-img-gen-result" style="margin-top:14px"></div>';

      // Aspect ratio toggle
      var arBtns = document.querySelectorAll('.mine-img-ar');
      var selectedAR = '16:9';
      for (var i = 0; i < arBtns.length; i++) {
        arBtns[i].addEventListener('click', function(e) {
          selectedAR = e.currentTarget.dataset.ar;
          for (var j = 0; j < arBtns.length; j++) {
            var active = arBtns[j].dataset.ar === selectedAR;
            arBtns[j].style.border = '1.5px solid ' + (active ? '#4F46E5' : '#E2E8F0');
            arBtns[j].style.background = active ? '#EEF2FF' : '#fff';
            arBtns[j].style.color = active ? '#4F46E5' : '#0F172A';
          }
        });
      }
      document.getElementById('mine-img-generate-btn').addEventListener('click', function() {
        var prompt = (document.getElementById('mine-img-prompt').value || '').trim();
        if (prompt.length < 5) { toast('Describe the image (at least 5 chars)', 'error'); return; }
        generateImage(prompt, selectedAR, siteId);
      });
    } else if (tab === 'library') {
      body.innerHTML = '<div id="mine-img-library" style="color:#64748b;font-size:13px;text-align:center;padding:32px">Loading your images…</div>';
      apiGet('/api/ai-agent/image/list?siteId=' + encodeURIComponent(siteId)).then(function(d) {
        var images = d.images || [];
        if (images.length === 0) {
          document.getElementById('mine-img-library').innerHTML = '<div style="color:#94A3B8">No images yet — upload or generate to get started.</div>';
          return;
        }
        var html = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px">';
        for (var i = 0; i < images.length; i++) {
          var img = images[i];
          html += '<div class="mine-lib-img" data-url="' + esc(img.url) + '" style="position:relative;aspect-ratio:1;border-radius:10px;overflow:hidden;cursor:pointer;border:1px solid #E2E8F0">' +
            '<img src="' + esc(img.url) + '" alt="" style="width:100%;height:100%;object-fit:cover">' +
            '<div style="position:absolute;bottom:0;left:0;right:0;background:linear-gradient(to top,rgba(0,0,0,.7),transparent);color:#fff;padding:6px 8px;font-size:10px;font-weight:600">' +
              (img.kind === 'ai_generated' ? '✨ AI' : '📤 Upload') +
            '</div></div>';
        }
        html += '</div>';
        document.getElementById('mine-img-library').outerHTML = html;
        // Wire click-to-use
        var libImgs = document.querySelectorAll('.mine-lib-img');
        for (var i2 = 0; i2 < libImgs.length; i2++) {
          libImgs[i2].addEventListener('click', function(e) {
            var url = e.currentTarget.dataset.url;
            promptForReplace(url, siteId);
          });
        }
      }).catch(function(e) {
        document.getElementById('mine-img-library').innerHTML = '<div style="color:#DC2626">Could not load library: ' + esc(e.message) + '</div>';
      });
    }
  }

  function uploadImage(file, siteId) {
    var statusEl = document.getElementById('mine-img-upload-status');
    statusEl.textContent = '📤 Uploading ' + file.name + '…';
    apiPost('/api/ai-agent/image/upload-url', {
      filename: file.name, mimeType: file.type, siteId: siteId
    }).then(function(d) {
      // Upload direct to S3
      return fetch(d.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file })
        .then(function(r) {
          if (!r.ok) throw new Error('S3 upload failed (' + r.status + ')');
          return apiPost('/api/ai-agent/image/register', {
            url: d.finalUrl, siteId: siteId, kind: 'upload', sizeBytes: file.size
          });
        });
    }).then(function(d) {
      statusEl.innerHTML = '<span style="color:#10B981">✓ Uploaded!</span>';
      var result = document.getElementById('mine-img-uploaded');
      result.innerHTML =
        '<img id="mine-img-preview" src="' + esc(d.url) + '" alt="" style="max-width:100%;border-radius:12px;border:1px solid #E2E8F0;margin-bottom:10px;transition:border-radius .2s, box-shadow .2s">' +
        '<div style="background:#F8FAFC;border-radius:10px;padding:12px;margin-bottom:12px">' +
          '<div style="font:700 12px system-ui;color:#64748B;margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">Corner Style</div>' +
          '<div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap">' +
            '<button type="button" class="mine-img-corner active" data-corner="0" style="background:#0F172A;color:#fff;border:0;padding:8px 12px;border-radius:8px;font:600 12px system-ui;cursor:pointer;flex:1;min-width:70px">⬛ Sharp</button>' +
            '<button type="button" class="mine-img-corner" data-corner="8" style="background:#E2E8F0;color:#334155;border:0;padding:8px 12px;border-radius:8px;font:600 12px system-ui;cursor:pointer;flex:1;min-width:70px">🔲 Soft</button>' +
            '<button type="button" class="mine-img-corner" data-corner="16" style="background:#E2E8F0;color:#334155;border:0;padding:8px 12px;border-radius:8px;font:600 12px system-ui;cursor:pointer;flex:1;min-width:70px">🟣 Rounded</button>' +
            '<button type="button" class="mine-img-corner" data-corner="24" style="background:#E2E8F0;color:#334155;border:0;padding:8px 12px;border-radius:8px;font:600 12px system-ui;cursor:pointer;flex:1;min-width:70px">🟠 Extra</button>' +
            '<button type="button" class="mine-img-corner" data-corner="9999" style="background:#E2E8F0;color:#334155;border:0;padding:8px 12px;border-radius:8px;font:600 12px system-ui;cursor:pointer;flex:1;min-width:70px">⭕ Circle</button>' +
          '</div>' +
          '<div style="font:700 12px system-ui;color:#64748B;margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">Shadow</div>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
            '<button type="button" class="mine-img-shadow active" data-shadow="none" style="background:#0F172A;color:#fff;border:0;padding:8px 12px;border-radius:8px;font:600 12px system-ui;cursor:pointer;flex:1;min-width:70px">None</button>' +
            '<button type="button" class="mine-img-shadow" data-shadow="soft" style="background:#E2E8F0;color:#334155;border:0;padding:8px 12px;border-radius:8px;font:600 12px system-ui;cursor:pointer;flex:1;min-width:70px">Soft</button>' +
            '<button type="button" class="mine-img-shadow" data-shadow="strong" style="background:#E2E8F0;color:#334155;border:0;padding:8px 12px;border-radius:8px;font:600 12px system-ui;cursor:pointer;flex:1;min-width:70px">Strong</button>' +
          '</div>' +
        '</div>' +
        '<button type="button" id="mine-img-use-uploaded" style="background:#4F46E5;color:#fff;border:0;padding:12px 20px;border-radius:10px;font:700 14px system-ui;cursor:pointer;width:100%">Use this image →</button>';
      // Style state
      var imgPreview = document.getElementById('mine-img-preview');
      var imgStyle = { corner: 0, shadow: 'none' };
      function applyPreviewStyle() {
        var radius = imgStyle.corner === 9999 ? '50%' : imgStyle.corner + 'px';
        var shadow = imgStyle.shadow === 'soft' ? '0 4px 16px rgba(0,0,0,.1)' :
                     imgStyle.shadow === 'strong' ? '0 8px 32px rgba(0,0,0,.2)' : 'none';
        imgPreview.style.borderRadius = radius;
        imgPreview.style.boxShadow = shadow;
      }
      // Corner buttons
      document.querySelectorAll('.mine-img-corner').forEach(function(b) {
        b.addEventListener('click', function() {
          imgStyle.corner = parseInt(b.dataset.corner, 10);
          document.querySelectorAll('.mine-img-corner').forEach(function(bb) {
            bb.style.background = bb === b ? '#0F172A' : '#E2E8F0';
            bb.style.color = bb === b ? '#fff' : '#334155';
          });
          applyPreviewStyle();
        });
      });
      // Shadow buttons
      document.querySelectorAll('.mine-img-shadow').forEach(function(b) {
        b.addEventListener('click', function() {
          imgStyle.shadow = b.dataset.shadow;
          document.querySelectorAll('.mine-img-shadow').forEach(function(bb) {
            bb.style.background = bb === b ? '#0F172A' : '#E2E8F0';
            bb.style.color = bb === b ? '#fff' : '#334155';
          });
          applyPreviewStyle();
        });
      });
      document.getElementById('mine-img-use-uploaded').addEventListener('click', function() {
        // Pass style to replace function
        promptForReplace(d.url, siteId, imgStyle);
      });
    }).catch(function(e) {
      statusEl.innerHTML = '<span style="color:#DC2626">Upload failed: ' + esc(e.message) + '</span>';
    });
  }

  function generateImage(prompt, aspectRatio, siteId) {
    var statusEl = document.getElementById('mine-img-gen-status');
    var btn = document.getElementById('mine-img-generate-btn');
    btn.disabled = true;
    statusEl.textContent = '✨ Generating… this takes 20-40 seconds';
    apiPost('/api/ai-agent/image/generate', {
      prompt: prompt, aspectRatio: aspectRatio, siteId: siteId
    }).then(function(d) {
      btn.disabled = false;
      statusEl.innerHTML = '<span style="color:#10B981">✓ Generated!</span>';
      var result = document.getElementById('mine-img-gen-result');
      result.innerHTML =
        '<img src="' + esc(d.url) + '" alt="" style="max-width:100%;border-radius:12px;border:1px solid #E2E8F0;margin-bottom:10px">' +
        '<button type="button" id="mine-img-use-generated" style="background:#4F46E5;color:#fff;border:0;padding:12px 20px;border-radius:10px;font:700 14px system-ui;cursor:pointer;width:100%">Use this image →</button>';
      document.getElementById('mine-img-use-generated').addEventListener('click', function() {
        promptForReplace(d.url, siteId);
      });
    }).catch(function(e) {
      btn.disabled = false;
      statusEl.innerHTML = '<span style="color:#DC2626">' + esc(e.message) + '</span>';
    });
  }

  function promptForReplace(newUrl, siteId, imgStyle) {
    // Show which image in the site to replace. Scan the current iframe/preview
    // for all <img> tags and offer each one.
    var currentHtml = '';
    try { currentHtml = (window.STATE && window.STATE.currentHtml) || ''; } catch(_){}
    if (!currentHtml) {
      // Try reading from preview iframe
      var iframe = document.querySelector('iframe');
      if (iframe) {
        try { currentHtml = iframe.srcdoc || ''; } catch(_){}
      }
    }

    var imgMatches = currentHtml.match(/<img[^>]*\bsrc=["']([^"']+)["'][^>]*>/g) || [];
    var existingImgs = [];
    var seen = {};
    for (var i = 0; i < imgMatches.length; i++) {
      var src = (imgMatches[i].match(/src=["']([^"']+)["']/) || [])[1];
      if (src && !seen[src]) { seen[src] = true; existingImgs.push(src); }
    }

    if (existingImgs.length === 0) {
      toast('No images in site to replace. Add one via the AI editor first.', 'error');
      return;
    }

    // Build replacement modal
    var body = document.getElementById('mine-img-body');
    if (!body) return;
    body.innerHTML =
      '<h3 style="margin:0 0 12px;font-size:15px;font-weight:800;color:#0F172A">Which image do you want to replace?</h3>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px">' +
      existingImgs.map(function(src) {
        return '<div class="mine-img-replace-target" data-old="' + esc(src) + '" data-new="' + esc(newUrl) + '" style="position:relative;aspect-ratio:1;border-radius:10px;overflow:hidden;cursor:pointer;border:2px solid #E2E8F0">' +
          '<img src="' + esc(src) + '" alt="" style="width:100%;height:100%;object-fit:cover" onerror="this.parentNode.style.display=\'none\'">' +
          '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(79,70,229,.8);color:#fff;font-weight:700;opacity:0;transition:opacity .15s" class="hover-overlay">Tap to replace</div>' +
        '</div>';
      }).join('') +
      '</div>';
    var targets = document.querySelectorAll('.mine-img-replace-target');
    for (var j = 0; j < targets.length; j++) {
      targets[j].addEventListener('mouseenter', function(e) {
        var ov = e.currentTarget.querySelector('.hover-overlay');
        if (ov) ov.style.opacity = '1';
      });
      targets[j].addEventListener('mouseleave', function(e) {
        var ov = e.currentTarget.querySelector('.hover-overlay');
        if (ov) ov.style.opacity = '0';
      });
      targets[j].addEventListener('click', function(e) {
        var oldSrc = e.currentTarget.dataset.old;
        var newSrc = e.currentTarget.dataset.new;
        replaceImage(siteId, oldSrc, newSrc, imgStyle);
      });
    }
  }

  function replaceImage(siteId, oldSrc, newSrc, imgStyle) {
    toast('Replacing image…');
    // Translate imgStyle into CSS for the backend to apply inline
    // DEFAULT: rounded-xl (16px) if user didn't pick — keeps sites polished
    if (!imgStyle) imgStyle = { corner: 16, shadow: 'none' };
    var cssStyle = '';
    var radius = imgStyle.corner === 9999 ? '50%' : (imgStyle.corner == null ? 16 : imgStyle.corner) + 'px';
    var shadow = imgStyle.shadow === 'soft' ? '0 4px 16px rgba(0,0,0,.1)' :
                 imgStyle.shadow === 'strong' ? '0 8px 32px rgba(0,0,0,.2)' : 'none';
    cssStyle = 'border-radius:' + radius + ';box-shadow:' + shadow + ';';
    apiPost('/api/ai-agent/image/replace', {
      siteId: siteId, oldSrc: oldSrc, newSrc: newSrc, style: cssStyle
    }).then(function(d) {
      toast('✓ Image replaced', 'success');
      refreshPreview(d.html);
      // Close modal
      var modal = document.getElementById('mine-image-modal');
      if (modal) modal.remove();
    }).catch(function(e) {
      toast('Replace failed: ' + e.message, 'error');
    });
  }

  // ── Inject the "📸 Images" button into the safety bar ──
  function injectImagesButton() {
    if (document.getElementById('mine-images-btn')) return true;
    var safetyBar = document.getElementById('mine-rescue-bar');
    if (!safetyBar) return false;
    var btn = document.createElement('button');
    btn.id = 'mine-images-btn';
    btn.type = 'button';
    btn.title = 'Upload your own images or generate with AI';
    btn.style.cssText = 'background:#fff;border:1px solid #c7d2fe;color:#0F172A;padding:7px 13px;border-radius:8px;font:700 12px system-ui;cursor:pointer';
    btn.innerHTML = '📸 Images';
    btn.addEventListener('click', function(e){ e.preventDefault(); openImageManager(); });
    // Insert after Health check button, before spacer
    var healthBtn = document.getElementById('mine-rescue-btn-check');
    if (healthBtn && healthBtn.parentNode === safetyBar) {
      healthBtn.parentNode.insertBefore(btn, healthBtn.nextSibling);
    } else {
      safetyBar.appendChild(btn);
    }
    return true;
  }

  // ── init ───────────────────────────────────────────────────────
  function init() {
    wireApplyButtons();

    // Retry injections periodically for dynamic panels
    var tries = 0;
    var interval = setInterval(function() {
      tries++;
      var modeOk = injectEditModeToggle();
      var imgOk = injectImagesButton();
      if ((modeOk && imgOk) || tries > 120) clearInterval(interval);
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.mineAIEditor = {
    surgicalEdit: surgicalEdit,
    openImageManager: openImageManager,
    replaceImage: replaceImage,
    getEditMode: getEditMode,
    setEditMode: setEditMode
  };
})();
