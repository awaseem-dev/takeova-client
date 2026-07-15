/**
 * MINE — User Rescue UI
 * ═══════════════════════════════════════════════════════════════
 * Adds three user-safety features to the Site Editor:
 *   1. Undo — restores the previous AI-generated version (server-side)
 *   2. Report a problem — sends issue + site bundle to support
 *   3. Health check — scans site for issues before Publish
 *
 * Strategy:
 *   (A) Injects a visible "🛟 Safety" bar above Describe-a-change
 *       prompt — works in BOTH editor layouts (mine-live + agency-live)
 *   (B) Hijacks existing Publish button clicks → runs health check first
 *   (C) Hijacks existing Undo/History buttons → calls server undo
 *
 * Exposed globals: window.mineRescue.{undo, report, checkHealth, trackPrompt}
 */
(function() {
  'use strict';

  var API = window.mineAPI || null;
  var PROMPT_HISTORY_KEY = 'mine_recent_prompts';
  var MAX_PROMPT_HISTORY = 10;

  function getCurrentSiteId(explicit) {
    if (explicit) return explicit;
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

  // ── FEATURE 1: Undo ────────────────────────────────────────────
  function undo(siteId) {
    var id = getCurrentSiteId(siteId);
    if (!id) { toast('No site selected', 'error'); return Promise.reject(); }
    toast('Undoing last edit…');
    return apiPost('/api/sites/' + id + '/undo', {})
      .then(function(d) {
        toast('Reverted: ' + (d.restoredFrom || 'previous version'), 'success');
        // Refresh preview iframe if present
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
          try {
            if (d.html && (iframes[i].id || '').match(/preview|d2|site/i)) {
              iframes[i].srcdoc = d.html;
            }
          } catch (_) {}
        }
        return d;
      })
      .catch(function(e) {
        toast(e.message || 'Undo failed — no previous version', 'error');
        throw e;
      });
  }

  // ── prompt tracking ─────────────────────────────────────────────
  function trackPrompt(text) {
    if (!text || typeof text !== 'string') return;
    try {
      var arr = JSON.parse(localStorage.getItem(PROMPT_HISTORY_KEY) || '[]');
      arr.push({ t: text.slice(0, 500), at: Date.now() });
      if (arr.length > MAX_PROMPT_HISTORY) arr = arr.slice(-MAX_PROMPT_HISTORY);
      localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(arr));
    } catch (_) {}
  }

  function getRecentPrompts() {
    try {
      var arr = JSON.parse(localStorage.getItem(PROMPT_HISTORY_KEY) || '[]');
      return arr.map(function(p) { return p.t; });
    } catch (_) { return []; }
  }

  // ── FEATURE 2: Report a problem ─────────────────────────────────
  function report(siteId) {
    var id = getCurrentSiteId(siteId);
    if (!id) { toast('No site selected', 'error'); return; }

    var existing = document.getElementById('mine-rescue-modal');
    if (existing) existing.remove();

    var backdrop = document.createElement('div');
    backdrop.id = 'mine-rescue-modal';
    backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.6);backdrop-filter:blur(4px);z-index:100001;display:flex;align-items:center;justify-content:center;padding:20px;font-family:system-ui,sans-serif';
    backdrop.innerHTML =
      '<div style="background:#fff;border-radius:18px;max-width:520px;width:100%;padding:28px;box-shadow:0 30px 80px rgba(0,0,0,.25);max-height:90vh;overflow-y:auto">' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">' +
          '<span style="font-size:24px">🚨</span>' +
          '<h2 style="margin:0;font-size:20px;font-weight:800;color:#0F172A">Report a problem</h2>' +
        '</div>' +
        '<p style="margin:0 0 18px 0;font-size:14px;color:#64748b;line-height:1.5">Tell us what went wrong. We\'ll bundle your site, recent AI prompts, and browser info — a human will reply within 1 business day.</p>' +
        '<textarea id="mine-rescue-desc" rows="5" placeholder="Describe what\'s broken. The more detail, the faster we can help. (e.g. \'The pricing section disappeared after I asked AI to change the colors and now it\'s gone\')" style="width:100%;padding:12px 14px;border:1.5px solid #E2E8F0;border-radius:10px;font:14px system-ui;resize:vertical;box-sizing:border-box;margin-bottom:14px;color:#0F172A"></textarea>' +
        '<div style="background:#F8FAFC;border-radius:10px;padding:12px;margin-bottom:16px;font-size:12px;color:#64748b">' +
          '<div style="font-weight:700;color:#0F172A;margin-bottom:4px">📎 We\'ll include:</div>' +
          '<div style="line-height:1.65">• Your current site HTML<br>• Your last ' + getRecentPrompts().length + ' AI prompts<br>• Browser &amp; screen info (no personal data)<br>• Your account email so we can reply</div>' +
        '</div>' +
        '<div style="display:flex;gap:10px;justify-content:flex-end">' +
          '<button id="mine-rescue-cancel" type="button" style="background:transparent;border:1px solid #E2E8F0;color:#0F172A;padding:11px 18px;border-radius:10px;font:600 14px system-ui;cursor:pointer">Cancel</button>' +
          '<button id="mine-rescue-submit" type="button" style="background:#0F172A;color:#fff;border:0;padding:11px 22px;border-radius:10px;font:700 14px system-ui;cursor:pointer">Send report</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(backdrop);

    var close = function() { try { backdrop.remove(); } catch(_){} };
    backdrop.addEventListener('click', function(e) { if (e.target === backdrop) close(); });
    document.getElementById('mine-rescue-cancel').addEventListener('click', close);
    try { document.getElementById('mine-rescue-desc').focus(); } catch(_){}

    document.getElementById('mine-rescue-submit').addEventListener('click', function() {
      var desc = (document.getElementById('mine-rescue-desc').value || '').trim();
      if (desc.length < 5) { toast('Please describe what went wrong (a few words)', 'error'); return; }
      var submitBtn = document.getElementById('mine-rescue-submit');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';

      var browserInfo = {
        userAgent: navigator.userAgent,
        screen: (screen && screen.width + 'x' + screen.height) || '',
        viewport: window.innerWidth + 'x' + window.innerHeight,
        lang: navigator.language,
        url: location.href
      };

      apiPost('/api/sites/' + id + '/report-issue', {
        description: desc,
        recentPrompts: getRecentPrompts(),
        browserInfo: browserInfo
      })
        .then(function(d) {
          close();
          toast(d.message || 'Report sent — we\'ll be in touch shortly.', 'success');
        })
        .catch(function(e) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Send report';
          toast(e.message || 'Could not send — please try again', 'error');
        });
    });
  }

  // ── FEATURE 3: Health check ─────────────────────────────────────
  function checkHealth(siteId, opts) {
    opts = opts || {};
    var id = getCurrentSiteId(siteId);
    if (!id) { toast('No site selected', 'error'); return Promise.reject(); }
    return apiGet('/api/sites/' + id + '/health-check')
      .then(function(d) {
        if (!opts.silent) showHealthModal(d, id);
        return d;
      })
      .catch(function(e) {
        if (!opts.silent) toast(e.message || 'Could not run health check', 'error');
        throw e;
      });
  }

  function showHealthModal(result, siteId) {
    var issues = result.issues || [];
    var summary = result.summary || {};
    var canPublish = !!result.canPublish;

    var existing = document.getElementById('mine-rescue-modal');
    if (existing) existing.remove();

    var backdrop = document.createElement('div');
    backdrop.id = 'mine-rescue-modal';
    backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.6);backdrop-filter:blur(4px);z-index:100001;display:flex;align-items:center;justify-content:center;padding:20px;font-family:system-ui,sans-serif';

    var issuesHtml = issues.length
      ? issues.map(function(issue) {
          var color = issue.severity === 'error' ? '#DC2626' : issue.severity === 'warning' ? '#F59E0B' : '#3B82F6';
          var bg = issue.severity === 'error' ? '#FEF2F2' : issue.severity === 'warning' ? '#FFFBEB' : '#EFF6FF';
          var icon = issue.severity === 'error' ? '❌' : issue.severity === 'warning' ? '⚠️' : 'ℹ️';
          return '<div style="background:' + bg + ';border-left:3px solid ' + color + ';border-radius:8px;padding:12px 14px;margin-bottom:8px">' +
            '<div style="display:flex;align-items:flex-start;gap:10px">' +
              '<span style="font-size:16px;line-height:1.2;flex-shrink:0">' + icon + '</span>' +
              '<div style="flex:1;min-width:0">' +
                '<div style="font-weight:700;color:#0F172A;font-size:13px;margin-bottom:3px">' + esc(issue.message) + '</div>' +
                '<div style="color:#64748b;font-size:12px;line-height:1.5">' + esc(issue.fix) + '</div>' +
                '<div style="color:#94A3B8;font-size:10px;margin-top:4px;text-transform:uppercase;letter-spacing:.05em;font-weight:700">' + esc(issue.area) + '</div>' +
              '</div></div></div>';
        }).join('')
      : '<div style="text-align:center;padding:40px 20px"><div style="font-size:48px;margin-bottom:12px">✨</div><div style="font-weight:800;font-size:16px;color:#0F172A;margin-bottom:4px">Your site looks great!</div><div style="color:#64748b;font-size:13px">No issues found. Ready to publish.</div></div>';

    backdrop.innerHTML =
      '<div style="background:#fff;border-radius:18px;max-width:560px;width:100%;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 30px 80px rgba(0,0,0,.25);overflow:hidden">' +
        '<div style="padding:24px 28px 16px;border-bottom:1px solid #F1F5F9">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px">' +
            '<h2 style="margin:0;font-size:20px;font-weight:800;color:#0F172A;display:flex;align-items:center;gap:8px"><span>🔍</span> Site health check</h2>' +
            '<button id="mine-rescue-close-hc" type="button" style="background:transparent;border:0;font-size:20px;cursor:pointer;color:#64748b;padding:4px 10px;border-radius:6px">×</button>' +
          '</div>' +
          '<p style="margin:0;font-size:13px;color:#64748b;line-height:1.5">' + esc(result.message || '') + '</p>' +
          (issues.length ?
            '<div style="display:flex;gap:14px;margin-top:12px;font-size:12px">' +
              (summary.errors ? '<span style="color:#DC2626;font-weight:700">❌ ' + summary.errors + ' error' + (summary.errors===1?'':'s') + '</span>' : '') +
              (summary.warnings ? '<span style="color:#F59E0B;font-weight:700">⚠️ ' + summary.warnings + ' warning' + (summary.warnings===1?'':'s') + '</span>' : '') +
              (summary.info ? '<span style="color:#3B82F6;font-weight:700">ℹ️ ' + summary.info + ' tip' + (summary.info===1?'':'s') + '</span>' : '') +
            '</div>' : '') +
        '</div>' +
        '<div style="padding:18px 28px;overflow-y:auto;flex:1">' + issuesHtml + '</div>' +
        '<div style="padding:16px 28px;border-top:1px solid #F1F5F9;display:flex;gap:10px;justify-content:flex-end;background:#F8FAFC">' +
          '<button id="mine-rescue-close-hc2" type="button" style="background:transparent;border:1px solid #E2E8F0;color:#0F172A;padding:11px 18px;border-radius:10px;font:600 14px system-ui;cursor:pointer">Close</button>' +
          '<button id="mine-rescue-publish" type="button" ' + (canPublish ? '' : 'disabled') +
            ' style="background:' + (canPublish ? '#10B981' : '#94A3B8') + ';color:#fff;border:0;padding:11px 22px;border-radius:10px;font:700 14px system-ui;cursor:' + (canPublish ? 'pointer' : 'not-allowed') + ';opacity:' + (canPublish ? '1' : '.5') + '">' +
            (canPublish ? '🚀 Publish now' : 'Fix errors first') +
          '</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(backdrop);
    var close = function() { try { backdrop.remove(); } catch(_){} };
    backdrop.addEventListener('click', function(e) { if (e.target === backdrop) close(); });
    document.getElementById('mine-rescue-close-hc').addEventListener('click', close);
    document.getElementById('mine-rescue-close-hc2').addEventListener('click', close);

    if (canPublish) {
      document.getElementById('mine-rescue-publish').addEventListener('click', function() {
        close();
        toast('Publishing…');
        apiPost('/api/sites/' + siteId + '/deploy', {})
          .then(function() { toast('Published ✓', 'success'); })
          .catch(function(e) { toast(e.message || 'Publish failed', 'error'); });
      });
    }
  }

  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  // ─── STRATEGY A: inject visible safety bar ─────────────────────
  function injectBar() {
    if (document.getElementById('mine-rescue-bar')) return true;
    // Anchor IDs — dashboards use different conventions:
    //   - mine-live / admin-live: d2-ai-global-prompt (new AI Site Editor)
    //   - mine-live per-section:  d2-ai-prompt
    //   - agency-live (v1):       d2-ai-global-prompt
    //   - agency-live (v2):       se-ai-input ← agency's alt editor
    // We inject the bar at the FIRST one we find that's visible on screen.
    var candidates = ['d2-ai-global-prompt', 'se-ai-input', 'd2-ai-prompt'];
    var anchor = null;
    for (var i = 0; i < candidates.length; i++) {
      var el = document.getElementById(candidates[i]);
      if (el && el.parentNode) {
        // Check if visible (offsetParent is null for hidden elements)
        if (el.offsetParent !== null || el.getClientRects().length > 0) {
          anchor = el; break;
        }
      }
    }
    // Fallback: any visible one
    if (!anchor) {
      for (var j = 0; j < candidates.length; j++) {
        var el2 = document.getElementById(candidates[j]);
        if (el2 && el2.parentNode) { anchor = el2; break; }
      }
    }
    if (!anchor) return false;

    var bar = document.createElement('div');
    bar.id = 'mine-rescue-bar';
    bar.style.cssText = 'display:flex;gap:6px;margin:10px 0 14px;flex-wrap:wrap;align-items:center;padding:10px 12px;background:linear-gradient(135deg,#eff6ff,#f5f3ff);border:1px solid #c7d2fe;border-radius:12px';
    bar.innerHTML =
      '<div style="font-size:10px;font-weight:800;color:#4F46E5;margin-right:2px;text-transform:uppercase;letter-spacing:.5px">🛟 Safety</div>' +
      '<button type="button" id="mine-rescue-btn-undo" style="background:#fff;border:1px solid #c7d2fe;color:#0F172A;padding:7px 13px;border-radius:8px;font:700 12px system-ui;cursor:pointer" title="Revert the last AI edit">↩ Undo</button>' +
      '<button type="button" id="mine-rescue-btn-check" style="background:#fff;border:1px solid #c7d2fe;color:#0F172A;padding:7px 13px;border-radius:8px;font:700 12px system-ui;cursor:pointer" title="Scan site for issues before publishing">🔍 Health check</button>' +
      '<div style="flex:1"></div>' +
      '<button type="button" id="mine-rescue-btn-report" style="background:#fff;border:1px solid #fecaca;color:#DC2626;padding:7px 13px;border-radius:8px;font:700 12px system-ui;cursor:pointer" title="Report a problem to support">🚨 Report</button>';
    anchor.parentNode.insertBefore(bar, anchor);

    document.getElementById('mine-rescue-btn-undo').addEventListener('click', function(e){e.preventDefault(); undo();});
    document.getElementById('mine-rescue-btn-check').addEventListener('click', function(e){e.preventDefault(); checkHealth();});
    document.getElementById('mine-rescue-btn-report').addEventListener('click', function(e){e.preventDefault(); report();});
    return true;
  }

  // ─── STRATEGY B: hijack existing Publish button ────────────────
  // Replace ALL publish click handlers with: run health check → only publish if OK
  function wirePublishButtons() {
    document.addEventListener('click', function(e) {
      var btn = e.target && e.target.closest && e.target.closest('button');
      if (!btn) return;
      var text = (btn.textContent || '').trim().toLowerCase();
      // Skip our own publish buttons
      if (btn.id === 'mine-rescue-publish') return;
      if (btn.closest('#mine-rescue-modal')) return;
      if (btn.closest('#mine-rescue-bar')) return;
      // Match "publish" or "🚀 publish" — but NOT "publish a post" etc
      if (!/^(🚀\s*)?publish(\s*site)?\s*✓?$/.test(text) && !/^publish$/.test(text)) return;
      // Skip if user opted out
      if (localStorage.getItem('mine_skip_health_check') === '1') return;
      // Skip if already intercepted once (let second click through)
      if (btn.getAttribute('data-rescue-intercepted') === '1') return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      btn.setAttribute('data-rescue-intercepted', '1');
      checkHealth(null).then(function() {
        // Modal handles publish inside it
      }).catch(function() {
        // If check fails (no site etc.), allow original click after clearing flag
        btn.removeAttribute('data-rescue-intercepted');
      });
      setTimeout(function() { btn.removeAttribute('data-rescue-intercepted'); }, 3000);
    }, true); // capture phase
  }

  // ─── STRATEGY C: hijack existing Undo buttons ──────────────────
  // Any button whose text matches Undo (but NOT our own + NOT redo) gets
  // its click redirected to server-side undo AFTER the local undo runs
  function wireUndoButtons() {
    document.addEventListener('click', function(e) {
      var btn = e.target && e.target.closest && e.target.closest('button');
      if (!btn) return;
      // Skip our own
      if (btn.id === 'mine-rescue-btn-undo') return;
      if (btn.closest('#mine-rescue-bar')) return;
      if (btn.closest('#mine-rescue-modal')) return;

      var text = (btn.textContent || '').trim().toLowerCase();
      // Match "undo" or "↩ undo" but NOT "redo" or "undo all"
      if (text === 'redo' || /redo/.test(text)) return;
      if (!/^(↩\s*)?undo$/.test(text)) return;

      // Let the local handler run, then try server undo as well
      setTimeout(function() {
        var id = getCurrentSiteId();
        if (!id) return;
        apiPost('/api/sites/' + id + '/undo', {}).then(function(d) {
          // Local undo already ran — refresh preview with server truth
          var iframes = document.querySelectorAll('iframe');
          for (var i = 0; i < iframes.length; i++) {
            try { if (d.html && (iframes[i].id || '').match(/preview|d2|site/i)) iframes[i].srcdoc = d.html; } catch (_) {}
          }
        }).catch(function(){ /* silent — local undo already happened */ });
      }, 50);
    }, false); // bubble phase — let local handler run first
  }

  // ─── prompt auto-tracking ──────────────────────────────────────
  function wirePromptTracking() {
    document.addEventListener('click', function(e) {
      var btn = e.target && e.target.closest && e.target.closest('button');
      if (!btn) return;
      var text = (btn.textContent || '').trim();
      if (/apply with ai|rewrite with ai|✨|regenerate/i.test(text)) {
        var input = document.getElementById('d2-ai-global-prompt') || document.getElementById('d2-ai-prompt');
        if (input && input.value) trackPrompt(input.value.trim());
      }
    }, true);
  }


  // ─── STRATEGY D: normalize editor layout to match mine-live/admin ─────
  // Agency dashboard shows a per-section editor with "Rewrite with AI" +
  // small Undo. Mine/admin show a bigger "AI Site Editor" card with
  // full-width "Apply with AI". Make agency look like mine/admin.
  function normalizeEditorLayout() {
    if (document.getElementById('mine-rescue-normalized')) return;
    // Find the OLD "Rewrite with AI" button — it's the tell of agency's
    // per-section editor
    var rewriteBtn = null;
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var txt = (btns[i].textContent || '').trim();
      if (/^✨?\s*Rewrite with AI\s*$/i.test(txt) || /Rewrite with AI/i.test(txt)) {
        rewriteBtn = btns[i]; break;
      }
    }
    if (!rewriteBtn) return;
    // Find its container — walk up until we find the wrapper with the
    // prompt textarea inside
    var container = rewriteBtn.closest('div');
    while (container && container !== document.body) {
      if (container.querySelector('#d2-ai-prompt')) break;
      container = container.parentElement;
    }
    if (!container || !container.querySelector('#d2-ai-prompt')) return;

    // Apply the new "AI Site Editor" styling to this container
    container.style.background = 'linear-gradient(135deg,rgba(99,91,255,.04),rgba(139,92,246,.04))';
    container.style.border = '1.5px solid rgba(99,91,255,.25)';
    container.style.borderRadius = '16px';
    container.style.padding = '18px';
    container.style.marginBottom = '14px';

    // Replace the header label if it's just "Describe a change"
    var headers = container.querySelectorAll('div');
    for (var j = 0; j < headers.length; j++) {
      var hText = (headers[j].textContent || '').trim();
      if (hText === '✨ Describe a change' || hText === 'Describe a change') {
        headers[j].innerHTML = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><span style="font-size:18px">✨</span><span style="font-weight:800;font-size:15px;color:#4F46E5">AI Site Editor</span></div><div style="font-size:12px;color:#64748b;margin-bottom:10px">Describe what you want to change — AI updates the site instantly</div>';
        break;
      }
    }

    // Upgrade "Rewrite with AI" button to full-width gradient Apply style
    rewriteBtn.innerHTML = '✨ Apply with AI';
    rewriteBtn.style.cssText = 'width:100%;background:linear-gradient(135deg,#4F46E5,#7C3AED);color:#fff;border:0;padding:14px;border-radius:10px;font:800 14px system-ui;cursor:pointer;margin-top:10px;text-align:center';
    // Move the old Undo that was next to it — hide it (we have Safety bar Undo)
    var parent = rewriteBtn.parentElement;
    if (parent) {
      var siblings = parent.querySelectorAll('button');
      for (var k = 0; k < siblings.length; k++) {
        var sTxt = (siblings[k].textContent || '').trim();
        // Hide the small Undo next to Rewrite with AI — our Safety Undo replaces it
        if ((sTxt === '↩ Undo' || sTxt === 'Undo' || /^↩\s*Undo$/.test(sTxt)) && siblings[k] !== rewriteBtn) {
          siblings[k].style.display = 'none';
        }
      }
      // Make the row full-width flex column so Apply with AI gets full width
      parent.style.display = 'block';
    }

    document.body.setAttribute('data-mine-rescue-normalized', '1');
    // Add a marker so we don't re-run
    var marker = document.createElement('div');
    marker.id = 'mine-rescue-normalized';
    marker.style.display = 'none';
    container.appendChild(marker);
  }

  // ─── init: try multiple times because panels render dynamically ──
  function init() {
    injectBar();
    normalizeEditorLayout();
    wirePublishButtons();
    wireUndoButtons();
    wirePromptTracking();

    // Retry bar injection every 500ms until it sticks (dashboard renders
    // editor panel dynamically on tab selection)
    var tries = 0;
    var interval = setInterval(function() {
      tries++;
      injectBar(); normalizeEditorLayout(); if (tries > 120) clearInterval(interval); // give up after 60s
    }, 500);

    // Also watch for DOM mutations to re-inject if editor re-renders
    var mo = new MutationObserver(function() {
      if (!document.getElementById('mine-rescue-bar')) injectBar();
      normalizeEditorLayout();
    });
    try { mo.observe(document.body, { childList: true, subtree: true }); } catch (_){}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.mineRescue = { undo: undo, report: report, checkHealth: checkHealth, trackPrompt: trackPrompt };
})();
