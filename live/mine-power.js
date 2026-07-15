/**
 * MINE — Power Editor UI (Tier 1)
 * ═══════════════════════════════════════════════════════════════
 * Adds the power-user editor features to the Site Editor:
 *   1. Surgical section edit — tap a section, type instruction, 3-8s edit
 *   2. Image upload — user's own photos via presigned S3
 *   3. AI image generate — describe an image, Claude/NanoBanana builds it
 *   4. Image replace — swap any <img> in the rendered site
 *
 * Backend endpoints used:
 *   POST /api/ai-agent/edit-section        ← surgical edit
 *   POST /api/ai-agent/image/upload-url    ← get presigned S3 URL
 *   POST /api/ai-agent/image/register      ← record after client upload
 *   POST /api/ai-agent/image/generate      ← AI image from description
 *   POST /api/ai-agent/image/replace       ← swap image src in site
 *   GET  /api/ai-agent/image/list          ← user's image gallery
 *
 * Include this AFTER mine-rescue.js loads. Exposes globals:
 *   window.minePower.editSection(prompt, selector, label)
 *   window.minePower.uploadImage(file, siteId)
 *   window.minePower.generateImage(prompt, aspectRatio)
 *   window.minePower.replaceImage(oldSrc, newUrl)
 *   window.minePower.openImagePicker(onPick)
 */
(function() {
  'use strict';

  var API = window.mineAPI || null;

  function getSiteId() {
    try {
      var s = JSON.parse(localStorage.getItem('mine_current_site') || '{}');
      return s.id || '';
    } catch (_) { return ''; }
  }

  function toast(msg, kind) {
    if (window.mineRescue && window.mineRescue._toast) return window.mineRescue._toast(msg, kind);
    if (typeof window.toast === 'function') { try { return window.toast(msg, kind); } catch (_) {} }
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:' +
      (kind === 'error' ? '#DC2626' : kind === 'success' ? '#10B981' : '#0F172A') +
      ';color:#fff;padding:12px 20px;border-radius:10px;font:14px system-ui;z-index:100002;max-width:90vw;box-shadow:0 10px 30px rgba(0,0,0,.2)';
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

  // ═════════════════════════════════════════════════════════════
  // FEATURE 1: Surgical section edit
  // ═════════════════════════════════════════════════════════════

  function editSection(prompt, sectionSelector, sectionLabel) {
    var siteId = getSiteId();
    if (!siteId) { toast('No site selected', 'error'); return Promise.reject(); }
    if (!prompt || prompt.trim().length < 3) { toast('Describe your change', 'error'); return Promise.reject(); }

    toast('Editing section…');
    var started = Date.now();
    return apiCall('POST', '/api/ai-agent/edit-section', {
      siteId: siteId,
      sectionSelector: sectionSelector || '',
      sectionLabel: sectionLabel || '',
      prompt: prompt
    })
      .then(function(d) {
        if (d.use_full_rebuild) {
          toast('Section not found — falling back to full rebuild…');
          // Caller should trigger full rebuild
          return { fallback: true, reason: d.reason };
        }
        var elapsed = Date.now() - started;
        toast('Updated in ' + (elapsed/1000).toFixed(1) + 's ✓', 'success');
        // Refresh preview
        var iframe = document.querySelector('iframe[data-mine-preview]') || document.querySelector('#d2-prev-iframe');
        if (iframe && d.html) {
          try { iframe.srcdoc = d.html; } catch (_) {}
        }
        return d;
      })
      .catch(function(e) {
        toast(e.message || 'Edit failed', 'error');
        throw e;
      });
  }

  // ═════════════════════════════════════════════════════════════
  // FEATURE 2: Image upload (user's own photos)
  // ═════════════════════════════════════════════════════════════

  function uploadImage(file, siteId) {
    if (!file) return Promise.reject(new Error('No file'));
    if (!/^image\//.test(file.type)) return Promise.reject(new Error('Not an image'));
    if (file.size > 10 * 1024 * 1024) return Promise.reject(new Error('Image too large (max 10MB)'));
    siteId = siteId || getSiteId();

    toast('Uploading image…');
    return apiCall('POST', '/api/ai-agent/image/upload-url', {
      filename: file.name,
      mimeType: file.type,
      siteId: siteId
    })
      .then(function(d) {
        // Direct PUT to S3 with the presigned URL
        return fetch(d.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.type },
          body: file
        }).then(function(r) {
          if (!r.ok) throw new Error('S3 upload failed: ' + r.status);
          return d;
        });
      })
      .then(function(d) {
        // Get image dimensions then register
        return getImageDimensions(file).then(function(dims) {
          return apiCall('POST', '/api/ai-agent/image/register', {
            url: d.finalUrl,
            siteId: siteId,
            kind: 'user_upload',
            width: dims.width,
            height: dims.height,
            sizeBytes: file.size
          }).then(function(r) {
            toast('Image uploaded ✓', 'success');
            return { url: d.finalUrl, id: r.id, dims: dims };
          });
        });
      })
      .catch(function(e) {
        toast(e.message || 'Upload failed', 'error');
        throw e;
      });
  }

  function getImageDimensions(file) {
    return new Promise(function(resolve) {
      var img = new Image();
      var objUrl = URL.createObjectURL(file);
      img.onload = function() {
        URL.revokeObjectURL(objUrl);
        resolve({ width: img.width, height: img.height });
      };
      img.onerror = function() {
        URL.revokeObjectURL(objUrl);
        resolve({ width: 0, height: 0 });
      };
      img.src = objUrl;
    });
  }

  // ═════════════════════════════════════════════════════════════
  // FEATURE 3: AI image generation
  // ═════════════════════════════════════════════════════════════

  function generateImage(prompt, aspectRatio) {
    if (!prompt || prompt.trim().length < 5) return Promise.reject(new Error('Describe your image (5+ chars)'));
    var siteId = getSiteId();
    toast('Generating image…');
    return apiCall('POST', '/api/ai-agent/image/generate', {
      prompt: prompt,
      aspectRatio: aspectRatio || '16:9',
      siteId: siteId
    })
      .then(function(d) {
        toast('Image ready ✓', 'success');
        return d;
      })
      .catch(function(e) {
        toast(e.message || 'Image generation failed', 'error');
        throw e;
      });
  }

  // ═════════════════════════════════════════════════════════════
  // FEATURE 4: Image replace (swap one <img> in the site)
  // ═════════════════════════════════════════════════════════════

  function replaceImage(oldSrc, newUrl) {
    var siteId = getSiteId();
    if (!siteId) { toast('No site selected', 'error'); return Promise.reject(); }
    if (!oldSrc || !newUrl) return Promise.reject(new Error('Both oldSrc and newUrl required'));
    return apiCall('POST', '/api/ai-agent/image/replace', {
      siteId: siteId,
      oldSrc: oldSrc,
      newUrl: newUrl
    })
      .then(function(d) {
        toast('Image replaced ✓', 'success');
        return d;
      })
      .catch(function(e) {
        toast(e.message || 'Replace failed', 'error');
        throw e;
      });
  }

  // ═════════════════════════════════════════════════════════════
  // Image picker modal — combines upload / AI-gen / gallery
  // ═════════════════════════════════════════════════════════════

  function openImagePicker(onPick) {
    var existing = document.getElementById('mine-image-picker');
    if (existing) existing.remove();

    var backdrop = document.createElement('div');
    backdrop.id = 'mine-image-picker';
    backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.6);backdrop-filter:blur(4px);z-index:100001;display:flex;align-items:center;justify-content:center;padding:20px;font-family:system-ui,sans-serif';
    backdrop.innerHTML =
      '<div style="background:#fff;border-radius:18px;max-width:560px;width:100%;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 30px 80px rgba(0,0,0,.25);overflow:hidden">' +
        '<div style="padding:22px 28px 14px;border-bottom:1px solid #F1F5F9;display:flex;justify-content:space-between;align-items:center">' +
          '<h2 style="margin:0;font-size:18px;font-weight:800;color:#0F172A;display:flex;align-items:center;gap:8px">🖼️ Pick an image</h2>' +
          '<button id="mip-close" type="button" style="background:transparent;border:0;font-size:22px;cursor:pointer;color:#64748b;padding:4px 10px;border-radius:6px">×</button>' +
        '</div>' +
        '<div style="display:flex;border-bottom:1px solid #F1F5F9;background:#F8FAFC">' +
          '<button id="mip-tab-upload" type="button" data-tab="upload" class="mip-tab" style="flex:1;background:#fff;border:0;padding:14px;font:700 13px system-ui;color:#0F172A;cursor:pointer;border-bottom:2px solid #4F46E5">📤 Upload</button>' +
          '<button id="mip-tab-ai" type="button" data-tab="ai" class="mip-tab" style="flex:1;background:transparent;border:0;padding:14px;font:700 13px system-ui;color:#64748b;cursor:pointer;border-bottom:2px solid transparent">✨ AI generate</button>' +
          '<button id="mip-tab-gallery" type="button" data-tab="gallery" class="mip-tab" style="flex:1;background:transparent;border:0;padding:14px;font:700 13px system-ui;color:#64748b;cursor:pointer;border-bottom:2px solid transparent">🗂️ My images</button>' +
        '</div>' +
        '<div id="mip-body" style="padding:24px 28px;overflow-y:auto;flex:1"></div>' +
      '</div>';
    document.body.appendChild(backdrop);

    var close = function() { try { backdrop.remove(); } catch(_){} };
    backdrop.addEventListener('click', function(e) { if (e.target === backdrop) close(); });
    document.getElementById('mip-close').addEventListener('click', close);

    function renderTab(tab) {
      // Update tab buttons
      document.querySelectorAll('.mip-tab').forEach(function(t) {
        var active = t.dataset.tab === tab;
        t.style.background = active ? '#fff' : 'transparent';
        t.style.color = active ? '#0F172A' : '#64748b';
        t.style.borderBottom = '2px solid ' + (active ? '#4F46E5' : 'transparent');
      });
      var body = document.getElementById('mip-body');
      if (tab === 'upload') renderUpload(body);
      if (tab === 'ai') renderAI(body);
      if (tab === 'gallery') renderGallery(body);
    }

    function renderUpload(body) {
      body.innerHTML =
        '<div id="mip-drop" style="border:2px dashed #CBD5E1;border-radius:14px;padding:40px 20px;text-align:center;cursor:pointer;transition:all .2s">' +
          '<div style="font-size:48px;margin-bottom:8px">📤</div>' +
          '<div style="font-weight:700;color:#0F172A;margin-bottom:4px">Drop an image here</div>' +
          '<div style="color:#64748b;font-size:13px;margin-bottom:12px">or tap to choose a file</div>' +
          '<div style="color:#94A3B8;font-size:11px">JPG · PNG · WEBP · max 10MB</div>' +
          '<input type="file" id="mip-file" accept="image/*" style="display:none">' +
        '</div>' +
        '<div id="mip-preview" style="margin-top:16px;display:none"></div>';
      var drop = document.getElementById('mip-drop');
      var input = document.getElementById('mip-file');
      drop.addEventListener('click', function() { input.click(); });
      drop.addEventListener('dragover', function(e) { e.preventDefault(); drop.style.borderColor = '#4F46E5'; drop.style.background = '#F5F3FF'; });
      drop.addEventListener('dragleave', function() { drop.style.borderColor = '#CBD5E1'; drop.style.background = ''; });
      drop.addEventListener('drop', function(e) {
        e.preventDefault();
        drop.style.borderColor = '#CBD5E1'; drop.style.background = '';
        if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
      });
      input.addEventListener('change', function(e) {
        if (e.target.files[0]) handleFile(e.target.files[0]);
      });
      function handleFile(file) {
        uploadImage(file, getSiteId()).then(function(r) {
          if (onPick) onPick(r.url);
          close();
        });
      }
    }

    function renderAI(body) {
      body.innerHTML =
        '<div style="display:flex;flex-direction:column;gap:14px">' +
          '<div>' +
            '<label style="font-weight:700;color:#0F172A;font-size:13px;display:block;margin-bottom:6px">Describe the image</label>' +
            '<textarea id="mip-ai-prompt" rows="3" placeholder="e.g. Warm sunrise yoga class on wooden deck overlooking ocean, minimal, soft natural light" style="width:100%;padding:12px;border:1.5px solid #E2E8F0;border-radius:10px;font:14px system-ui;resize:vertical;box-sizing:border-box;color:#0F172A"></textarea>' +
          '</div>' +
          '<div>' +
            '<label style="font-weight:700;color:#0F172A;font-size:13px;display:block;margin-bottom:6px">Shape</label>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap" id="mip-ratio-group">' +
              '<button type="button" data-ratio="16:9" class="mip-ratio" style="background:#4F46E5;color:#fff;border:0;padding:8px 16px;border-radius:8px;font:700 12px system-ui;cursor:pointer">📺 Wide 16:9</button>' +
              '<button type="button" data-ratio="1:1" class="mip-ratio" style="background:#F1F5F9;color:#0F172A;border:0;padding:8px 16px;border-radius:8px;font:700 12px system-ui;cursor:pointer">⬜ Square 1:1</button>' +
              '<button type="button" data-ratio="4:5" class="mip-ratio" style="background:#F1F5F9;color:#0F172A;border:0;padding:8px 16px;border-radius:8px;font:700 12px system-ui;cursor:pointer">📱 Portrait 4:5</button>' +
              '<button type="button" data-ratio="3:2" class="mip-ratio" style="background:#F1F5F9;color:#0F172A;border:0;padding:8px 16px;border-radius:8px;font:700 12px system-ui;cursor:pointer">🖼️ Classic 3:2</button>' +
            '</div>' +
          '</div>' +
          '<button type="button" id="mip-generate" style="background:#0F172A;color:#fff;border:0;padding:13px;border-radius:10px;font:700 14px system-ui;cursor:pointer;margin-top:4px">✨ Generate image</button>' +
          '<div id="mip-ai-result" style="display:none;margin-top:12px"></div>' +
        '</div>';
      var selectedRatio = '16:9';
      document.querySelectorAll('.mip-ratio').forEach(function(b) {
        b.addEventListener('click', function() {
          document.querySelectorAll('.mip-ratio').forEach(function(o) {
            o.style.background = '#F1F5F9'; o.style.color = '#0F172A';
          });
          this.style.background = '#4F46E5'; this.style.color = '#fff';
          selectedRatio = this.dataset.ratio;
        });
      });
      document.getElementById('mip-generate').addEventListener('click', function() {
        var prompt = (document.getElementById('mip-ai-prompt').value || '').trim();
        var btn = document.getElementById('mip-generate');
        btn.disabled = true; btn.textContent = 'Generating…';
        generateImage(prompt, selectedRatio).then(function(r) {
          var result = document.getElementById('mip-ai-result');
          result.style.display = 'block';
          result.innerHTML =
            '<img src="' + r.url + '" style="width:100%;border-radius:10px;border:1px solid #E2E8F0;margin-bottom:10px"/>' +
            '<div style="display:flex;gap:8px"><button type="button" id="mip-use" style="flex:1;background:#10B981;color:#fff;border:0;padding:11px;border-radius:8px;font:700 13px system-ui;cursor:pointer">Use this image</button>' +
            '<button type="button" id="mip-retry" style="background:#F1F5F9;color:#0F172A;border:0;padding:11px 16px;border-radius:8px;font:700 13px system-ui;cursor:pointer">Try again</button></div>';
          document.getElementById('mip-use').addEventListener('click', function() {
            if (onPick) onPick(r.url);
            close();
          });
          document.getElementById('mip-retry').addEventListener('click', function() {
            document.getElementById('mip-ai-result').style.display = 'none';
            btn.disabled = false; btn.textContent = '✨ Generate image';
          });
          btn.disabled = false; btn.textContent = '✨ Generate image';
        }).catch(function() {
          btn.disabled = false; btn.textContent = '✨ Generate image';
        });
      });
    }

    function renderGallery(body) {
      body.innerHTML = '<div style="text-align:center;padding:20px;color:#64748b">Loading your images…</div>';
      apiCall('GET', '/api/ai-agent/image/list?siteId=' + encodeURIComponent(getSiteId())).then(function(d) {
        var imgs = d.images || [];
        if (imgs.length === 0) {
          body.innerHTML = '<div style="text-align:center;padding:40px 20px;color:#64748b"><div style="font-size:48px;margin-bottom:12px">📭</div><div style="font-weight:700;color:#0F172A;margin-bottom:4px">No images yet</div><div style="font-size:13px">Upload or generate one to get started.</div></div>';
          return;
        }
        body.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px">' +
          imgs.map(function(i) {
            return '<div style="cursor:pointer;border-radius:8px;overflow:hidden;aspect-ratio:1;background:#F1F5F9;position:relative" data-url="' + esc(i.url) + '">' +
              '<img src="' + esc(i.url) + '" style="width:100%;height:100%;object-fit:cover" loading="lazy"/>' +
              (i.kind === 'ai_generated' ? '<div style="position:absolute;top:4px;right:4px;background:rgba(79,70,229,.9);color:#fff;font:700 9px system-ui;padding:2px 5px;border-radius:4px">AI</div>' : '') +
            '</div>';
          }).join('') + '</div>';
        body.querySelectorAll('[data-url]').forEach(function(el) {
          el.addEventListener('click', function() {
            var url = el.getAttribute('data-url');
            if (onPick) onPick(url);
            close();
          });
        });
      }).catch(function() {
        body.innerHTML = '<div style="text-align:center;padding:30px;color:#DC2626">Could not load images</div>';
      });
    }

    function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

    // Wire tabs
    document.getElementById('mip-tab-upload').addEventListener('click', function() { renderTab('upload'); });
    document.getElementById('mip-tab-ai').addEventListener('click', function() { renderTab('ai'); });
    document.getElementById('mip-tab-gallery').addEventListener('click', function() { renderTab('gallery'); });
    // Start on upload
    renderTab('upload');
  }

  // ═════════════════════════════════════════════════════════════
  // AUTO-WIRE: intercept existing "Apply with AI" / "Rewrite with AI" clicks
  // ═════════════════════════════════════════════════════════════
  // When user clicks the existing apply button, try the fast surgical edit
  // endpoint first. If it returns use_full_rebuild, fall back to /build.
  //
  // This is opt-in via localStorage flag so it doesn't break existing flows
  // for users who prefer the old behavior.
  function wireFastEditIntercept() {
    if (localStorage.getItem('mine_disable_fast_edit') === '1') return;
    document.addEventListener('click', function(e) {
      var btn = e.target && e.target.closest && e.target.closest('button');
      if (!btn) return;
      if (btn.id === 'mip-generate' || btn.closest('#mine-image-picker')) return;
      var text = (btn.textContent || '').trim().toLowerCase();
      // Match "apply with ai" or "rewrite with ai"
      if (!/^(✨\s*)?(apply|rewrite)\s+with\s+ai$/.test(text)) return;
      if (btn.getAttribute('data-fast-intercepted') === '1') return;

      // Try to find the current prompt + section context
      var promptEl = document.getElementById('d2-ai-prompt') ||
                     document.getElementById('d2-ai-global-prompt');
      if (!promptEl || !promptEl.value.trim()) return; // let default handler run

      // Figure out which section is being edited
      var sectionLabel = '';
      var selChip = document.querySelector('#d2-chips [data-sec][style*="border:2px"]');
      if (selChip) sectionLabel = selChip.getAttribute('data-sec') || '';
      // If it's the GLOBAL prompt, don't intercept — use /build instead
      if (promptEl.id === 'd2-ai-global-prompt') return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      btn.setAttribute('data-fast-intercepted', '1');

      editSection(promptEl.value.trim(), '', sectionLabel)
        .then(function(r) {
          if (r && r.fallback) {
            // Fall back to existing /build flow — click through
            btn.removeAttribute('data-fast-intercepted');
            btn.click();
          } else {
            promptEl.value = '';
          }
        })
        .catch(function() { btn.removeAttribute('data-fast-intercepted'); });
      setTimeout(function() { btn.removeAttribute('data-fast-intercepted'); }, 5000);
    }, true);
  }

  // ═════════════════════════════════════════════════════════════
  // AUTO-WIRE: Replace image button → opens picker
  // ═════════════════════════════════════════════════════════════
  function wireImageButtons() {
    document.addEventListener('click', function(e) {
      var btn = e.target && e.target.closest && e.target.closest('button');
      if (!btn) return;
      if (btn.closest('#mine-image-picker')) return;
      var text = (btn.textContent || '').trim().toLowerCase();
      if (!/replace\s+image|change\s+image|upload\s+image|pick\s+image/.test(text)) return;
      if (btn.getAttribute('data-img-wired') === '1') return;
      btn.setAttribute('data-img-wired', '1');

      e.preventDefault();
      e.stopPropagation();
      openImagePicker(function(url) {
        // Got a URL — set it as the background/src of the section being edited
        toast('Image selected — applying…');
        // Use a generic "set hero image" edit via surgical edit
        var sectionLabel = '';
        var selChip = document.querySelector('#d2-chips [data-sec][style*="border:2px"]');
        if (selChip) sectionLabel = selChip.getAttribute('data-sec') || '';
        editSection('Replace the main image in this section with: ' + url, '', sectionLabel);
      });
      setTimeout(function() { btn.removeAttribute('data-img-wired'); }, 3000);
    }, true);
  }

  function init() {
    wireFastEditIntercept();
    wireImageButtons();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.minePower = {
    editSection: editSection,
    uploadImage: uploadImage,
    generateImage: generateImage,
    replaceImage: replaceImage,
    openImagePicker: openImagePicker
  };
})();
