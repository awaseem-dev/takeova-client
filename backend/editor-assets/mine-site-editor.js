// ═══════════════════════════════════════════════════════════════════
// MINE v49.2 — Site Editor Parent Orchestrator
// Runs in the dashboard. Injects the WYSIWYG editor into the preview
// iframe, listens for selections/edits, and persists via the backend.
// ═══════════════════════════════════════════════════════════════════
(function(global) {
  'use strict';

  const SE = {
    iframe: null,
    siteId: null,
    undoStack: [],   // local HTML snapshots for fast undo
    redoStack: [],
    maxStack: 50,
    apiBase: () => (window.MINE_API || ''),
    token: () => localStorage.getItem('mine_token') || '',
    toast: (m, t) => (typeof window.toast === 'function' ? window.toast(m, t) : console.log('[SE]', m))
  };

  // ─── API wrapper ────────────────────────────────────────────────────
  async function api(path, opts = {}) {
    const r = await fetch(SE.apiBase() + path, Object.assign({
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + SE.token()
      }, opts.headers || {})
    }, opts));
    if (r.status === 402) { SE.toast('Edit cap reached — upgrade plan', 'error'); throw new Error('cap'); }
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'API error'); }
    return r.json();
  }

  async function apiMultipart(path, formData) {
    const r = await fetch(SE.apiBase() + path, {
      method: 'POST', body: formData,
      headers: { 'Authorization': 'Bearer ' + SE.token() }
    });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Upload failed'); }
    return r.json();
  }

  // ─── Inject editor into iframe after load ───────────────────────────
  function injectEditor() {
    if (!SE.iframe || !SE.iframe.contentDocument) return;
    const doc = SE.iframe.contentDocument;
    // Avoid double-inject
    if (doc.getElementById('mine-editor-inject')) return;
    const script = doc.createElement('script');
    script.id = 'mine-editor-inject';
    script.src = (SE.apiBase() || '') + '/mine-editor-inject.js';
    // Fallback: inline the script content if remote fetch fails
    script.onerror = () => {
      const s2 = doc.createElement('script');
      s2.textContent = window.__MINE_EDITOR_INLINE || '';
      doc.body.appendChild(s2);
    };
    doc.body.appendChild(script);
  }

  // ─── Load site into iframe ─────────────────────────────────────────
  SE.loadSite = async function(siteId) {
    if (!siteId) return false;
    SE.siteId = siteId;
    try {
      const data = await api('/api/site-editor/' + siteId);
      if (!data.html) return false;
      if (SE.iframe) {
        SE.iframe.srcdoc = data.html;
        SE.iframe.style.display = 'block';
        const inline = document.getElementById('d2-preview-inline');
        if (inline) inline.style.display = 'none';
        SE.iframe.onload = () => {
          injectEditor();
          setTimeout(() => SE.enableEditMode(), 200);
        };
      }
      return true;
    } catch (e) {
      console.warn('[SE.loadSite]', e.message);
      return false;
    }
  };

  // ─── Enable / disable click-to-edit ────────────────────────────────
  SE.enableEditMode = function() {
    if (!SE.iframe || !SE.iframe.contentWindow) return;
    SE.iframe.contentWindow.postMessage({ type: 'mine:enable' }, '*');
  };
  SE.disableEditMode = function() {
    if (!SE.iframe || !SE.iframe.contentWindow) return;
    SE.iframe.contentWindow.postMessage({ type: 'mine:disable' }, '*');
  };

  // ─── Message handler (iframe → parent) ─────────────────────────────
  window.addEventListener('message', async (ev) => {
    const msg = ev.data || {};
    if (!msg.type || !msg.type.startsWith('mine:')) return;

    switch (msg.type) {
      case 'mine:ready':
        SE.enableEditMode();
        break;

      case 'mine:element-selected':
        // Show "AI rewrite this" bar in parent UI
        const bar = document.getElementById('se-selected-bar');
        if (bar) {
          bar.style.display = 'block';
          bar.dataset.selector = msg.selector;
          bar.dataset.currentText = msg.text;
          const lbl = document.getElementById('se-selected-label');
          if (lbl) lbl.textContent = `Editing: ${msg.tag} — "${(msg.text||'').slice(0, 40)}${msg.text.length>40?'…':''}"`;
        }
        break;

      case 'mine:element-changed':
        if (!SE.siteId) return;
        try {
          await api('/api/site-editor/' + SE.siteId + '/element', {
            method: 'PATCH',
            body: JSON.stringify({ selector: msg.selector, content: msg.content })
          });
          SE.toast('Saved ✓');
        } catch (e) {
          SE.toast('Save failed: ' + e.message, 'error');
        }
        break;

      case 'mine:image-click-requested':
        SE.openImageUpload(msg.selector);
        break;
    }
  });

  // ─── Image replace ─────────────────────────────────────────────────
  SE.openImageUpload = function(selector) {
    if (!SE.siteId) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      SE.toast('Uploading image…');
      const fd = new FormData();
      fd.append('file', file);
      fd.append('selector', selector);
      try {
        const r = await apiMultipart('/api/site-editor/' + SE.siteId + '/image', fd);
        if (SE.iframe && SE.iframe.contentWindow) {
          SE.iframe.contentWindow.postMessage({
            type: 'mine:apply-edit', selector, content: r.url, attr: 'src'
          }, '*');
        }
        SE.toast('Image updated ✓');
      } catch (err) {
        SE.toast('Upload failed: ' + err.message, 'error');
      }
    };
    input.click();
  };

  // ─── AI Rewrite ────────────────────────────────────────────────────
      // \u2328\ufe0f shortcuts: Cmd/Ctrl+Z undo, +Shift redo, +S = autosave reassurance
  document.addEventListener('keydown', function(e){
    var mod = e.metaKey || e.ctrlKey; if (!mod) return;
    var tag = (e.target && e.target.tagName || '').toLowerCase();
    var typing = tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable);
    var k = (e.key || '').toLowerCase();
    if (k === 's') { e.preventDefault(); SE.toast('Everything autosaves \u2713 \u2014 History \u21ba goes back in time'); }
    else if (k === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) { SE.redo && SE.redo(); } else { SE.undo && SE.undo(); } }
    else if (k === 'y' && !typing) { e.preventDefault(); SE.redo && SE.redo(); }
  });

  // \ud83d\udcce Reference-image attach: restyle the whole site to match a picture
  SE._refImg = null;
  SE._pickRef = function(){ var f=document.getElementById('se-ai-file'); if(f) f.click(); };
  (function(){
    function wire(){
      var p=document.getElementById('se-ai-prompt');
      if(!p || document.getElementById('se-ai-attach')) return;
      var b=document.createElement('button'); b.id='se-ai-attach'; b.type='button'; b.title='Attach a reference image \u2014 restyles the whole site to match it'; b.textContent='\ud83d\udcce';
      b.style.cssText='margin-left:6px;border:1px solid #2a2f45;background:#171b2e;color:#cfd6ff;border-radius:8px;padding:6px 9px;cursor:pointer';
      var f=document.createElement('input'); f.id='se-ai-file'; f.type='file'; f.accept='image/png,image/jpeg,image/webp'; f.style.display='none';
      var t=document.createElement('span'); t.id='se-ai-thumb'; t.style.cssText='display:none;font-size:11px;color:#9fe3b3;margin-left:6px;cursor:pointer';
      b.onclick=SE._pickRef;
      f.onchange=function(){ var file=f.files&&f.files[0]; if(!file) return;
        if(file.size>3500000){ SE.toast('Image too large (max 3.5MB)','error'); f.value=''; return; }
        var r=new FileReader();
        r.onload=function(){ var d=String(r.result||''); var m=d.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
          if(!m){ SE.toast('PNG, JPEG or WebP only','error'); return; }
          SE._refImg={media_type:m[1],data:m[2]};
          t.textContent='\ud83d\uddbc\ufe0f '+file.name.slice(0,18)+' \u2715'; t.style.display='inline';
          SE.toast('Reference attached \u2014 \u2728 now restyles the whole site to match'); };
        r.readAsDataURL(file); };
      t.onclick=function(){ SE._refImg=null; t.style.display='none'; f.value=''; SE.toast('Reference removed'); };
      if(p.parentNode){ p.parentNode.insertBefore(b,p.nextSibling); p.parentNode.insertBefore(f,b.nextSibling); p.parentNode.insertBefore(t,f.nextSibling); }
    }
    if(document.readyState!=='loading') setTimeout(wire,400); else document.addEventListener('DOMContentLoaded',function(){setTimeout(wire,400);});
    setInterval(function(){ try{wire();}catch(e){} },2500);
  })();

SE.aiRewrite = async function() {
    if (!SE.siteId) { SE.toast('No site loaded', 'error'); return; }
    if (SE._refImg) {
      const stylePrompt = ((document.getElementById('se-ai-prompt')||{}).value||'').trim();
      SE.toast('Restyling your whole site to match the image\u2026');
      try {
        const r = await api('/api/site-editor/' + SE.siteId + '/ai-restyle', { method:'POST', body: JSON.stringify({ prompt: stylePrompt, referenceImage: SE._refImg }) });
        if (r && r.html && SE.iframe) { SE.iframe.srcdoc = r.html; SE.toast('Restyled \u2728 \u2014 saved. History \u21ba brings the old look back.'); }
        else SE.toast((r && r.error) || 'Restyle failed', 'error');
      } catch (err) { SE.toast('Restyle failed: ' + err.message, 'error'); }
      SE._refImg = null;
      var _t=document.getElementById('se-ai-thumb'); if(_t)_t.style.display='none';
      var _f=document.getElementById('se-ai-file'); if(_f)_f.value='';
      const p0=document.getElementById('se-ai-prompt'); if(p0) p0.value='';
      return;
    }

    const bar = document.getElementById('se-selected-bar');
    const selector = bar?.dataset.selector;
    const currentText = bar?.dataset.currentText || '';
    const prompt = (document.getElementById('se-ai-prompt') || {}).value || '';
    if (!selector) { SE.toast('Click an element first', 'error'); return; }
    if (!prompt.trim()) { SE.toast('Describe the change first', 'error'); return; }

    SE.toast('AI rewriting…');
    try {
      const r = await api('/api/site-editor/' + SE.siteId + '/ai-rewrite', {
        method: 'POST',
        body: JSON.stringify({ selector, currentText, prompt })
      });
      if (SE.iframe && SE.iframe.contentWindow) {
        SE.iframe.contentWindow.postMessage({
          type: 'mine:apply-edit', selector, content: r.rewritten
        }, '*');
      }
      SE.toast('Rewritten ✓');
      // Clear prompt
      const p = document.getElementById('se-ai-prompt'); if (p) p.value = '';
    } catch (err) {
      SE.toast('Rewrite failed: ' + err.message, 'error');
    }
  };

  // ─── Add a section ─────────────────────────────────────────────────
  SE.addSection = async function(sectionKey, position) {
    if (!SE.siteId) return;
    try {
      const r = await api('/api/site-editor/' + SE.siteId + '/section/add', {
        method: 'POST',
        body: JSON.stringify({ sectionKey, position })
      });
      if (SE.iframe) SE.iframe.srcdoc = r.html;
      SE.toast('Section added ✓');
    } catch (e) { SE.toast('Add section failed: ' + e.message, 'error'); }
  };

  SE.removeSection = async function(index) {
    if (!SE.siteId) return;
    try {
      const r = await api('/api/site-editor/' + SE.siteId + '/section/remove', {
        method: 'POST',
        body: JSON.stringify({ index })
      });
      if (SE.iframe) SE.iframe.srcdoc = r.html;
      SE.toast('Section removed ✓');
    } catch (e) { SE.toast('Remove failed: ' + e.message, 'error'); }
  };

  // ─── Undo / Redo (backend-backed) ──────────────────────────────────
  SE.undo = async function() {
    if (!SE.siteId) return;
    try {
      const r = await api('/api/site-editor/' + SE.siteId + '/undo', { method: 'POST' });
      if (SE.iframe) SE.iframe.srcdoc = r.html;
      SE.toast('Undone ↶');
    } catch (e) { SE.toast('Nothing to undo', 'error'); }
  };

  SE.redo = async function() {
    if (!SE.siteId) return;
    try {
      const r = await api('/api/site-editor/' + SE.siteId + '/redo', { method: 'POST' });
      if (SE.iframe) SE.iframe.srcdoc = r.html;
      SE.toast('Redone ↷');
    } catch (e) { SE.toast('Nothing to redo', 'error'); }
  };

  // ─── Init: wire to existing iframe if present ──────────────────────
  SE.init = function() {
    SE.iframe = document.getElementById('d2-preview-iframe');
    if (!SE.iframe) {
      // Not on Site Editor panel yet — try again when user opens it
      return;
    }
    SE.toolbar();
    // Auto-load current site from localStorage
    try {
      const cur = JSON.parse(localStorage.getItem('mine_current_site') || '{}');
      if (cur.id) SE.loadSite(cur.id);
    } catch (e) {}
  };

  // ─── UX pack (audit 2026-06-10): History, Section Library, Reorder + toolbar ───
  function sePanel(title) {
    var old = document.getElementById('se-ux-panel'); if (old) old.remove();
    var p = document.createElement('div'); p.id = 'se-ux-panel';
    p.style.cssText = 'position:fixed;right:16px;bottom:76px;z-index:99996;width:300px;max-height:54vh;overflow:auto;background:#11131F;color:#E7E9F4;border:1px solid rgba(255,255,255,.14);border-radius:12px;box-shadow:0 20px 56px rgba(0,0,0,.5);font:13px/1.45 system-ui';
    var h = document.createElement('div');
    h.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.08);font-weight:700';
    h.textContent = title;
    var x = document.createElement('span'); x.textContent = '\u2715';
    x.style.cssText = 'cursor:pointer;opacity:.7;padding:2px 6px'; x.onclick = function(){ p.remove(); };
    h.appendChild(x); p.appendChild(h);
    var body = document.createElement('div'); body.id = 'se-ux-body'; body.style.padding = '8px';
    p.appendChild(body); document.body.appendChild(p); return body;
  }
  function seRow(label, btnText, fn) {
    var r = document.createElement('div');
    r.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;padding:7px 8px;border-radius:8px';
    r.onmouseenter = function(){ r.style.background = 'rgba(99,91,255,.14)'; };
    r.onmouseleave = function(){ r.style.background = ''; };
    var l = document.createElement('div'); l.textContent = label; l.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    var b = document.createElement('button'); b.textContent = btnText;
    b.style.cssText = 'border:1px solid rgba(255,255,255,.18);background:#1A1D2E;color:#fff;border-radius:7px;padding:4px 10px;cursor:pointer;font-size:12px';
    b.onclick = fn; r.appendChild(l); r.appendChild(b); return r;
  }

  SE.history = async function() {
    if (!SE.siteId) { SE.toast('Open a site first', 'error'); return; }
    var body = sePanel('Version history');
    body.textContent = 'Loading\u2026';
    try {
      var r = await api('/api/site-editor/' + SE.siteId + '/versions');
      body.textContent = '';
      var vs = (r && r.versions) || [];
      if (!vs.length) { body.textContent = 'No saved versions yet \u2014 every edit creates one.'; return; }
      vs.forEach(function(v) {
        var when = (v.created_at || v.createdAt || '').replace('T', ' ').slice(0, 16);
        body.appendChild(seRow((v.label || v.reason || 'Edit') + ' \u00b7 ' + when, 'Restore', async function() {
          try {
            var rr = await api('/api/site-editor/' + SE.siteId + '/restore/' + (v.id || v.version_id), { method: 'POST' });
            if (SE.iframe && rr && rr.html) SE.iframe.srcdoc = rr.html;
            SE.toast('Restored \u2713');
          } catch (e) { SE.toast('Restore failed: ' + e.message, 'error'); }
        }));
      });
    } catch (e) { body.textContent = 'Could not load versions.'; }
  };

  SE.sectionLibrary = async function() {
    if (!SE.siteId) { SE.toast('Open a site first', 'error'); return; }
    var body = sePanel('Add a section');
    body.textContent = 'Loading\u2026';
    try {
      var r = await api('/api/site-editor/sections/library');
      body.textContent = '';
      ((r && r.sections) || []).forEach(function(sec) {
        body.appendChild(seRow(sec.name || sec.key, 'Add', function() {
          SE.addSection(sec.key);
          var p = document.getElementById('se-ux-panel'); if (p) p.remove();
        }));
      });
    } catch (e) { body.textContent = 'Could not load library.'; }
  };

  SE.reorder = async function(fromIndex, toIndex) {
    if (!SE.siteId) return;
    try {
      var r = await api('/api/site-editor/' + SE.siteId + '/section/reorder', {
        method: 'POST', body: JSON.stringify({ fromIndex: fromIndex, toIndex: toIndex })
      });
      if (SE.iframe && r && r.html) SE.iframe.srcdoc = r.html;
      SE.toast('Reordered \u2713');
    } catch (e) { SE.toast('Reorder failed: ' + e.message, 'error'); }
  };

  SE.reorderUI = function() {
    if (!SE.siteId) { SE.toast('Open a site first', 'error'); return; }
    var doc = SE.iframe && SE.iframe.contentDocument; if (!doc) return;
    var secs = doc.querySelectorAll('section, [data-mine-section]');
    var body = sePanel('Reorder sections');
    if (!secs.length) { body.textContent = 'No sections detected on this page.'; return; }
    Array.prototype.forEach.call(secs, function(el, i) {
      var label = (i + 1) + '. ' + ((el.id || el.getAttribute('data-mine-section') || (el.querySelector('h1,h2,h3') || {}).textContent || 'Section').toString().trim().slice(0, 30));
      var row = seRow(label, '\u2191', function() { if (i > 0) SE.reorder(i, i - 1); });
      var down = document.createElement('button'); down.textContent = '\u2193';
      down.style.cssText = 'border:1px solid rgba(255,255,255,.18);background:#1A1D2E;color:#fff;border-radius:7px;padding:4px 10px;cursor:pointer;font-size:12px;margin-left:4px';
      down.onclick = function() { if (i < secs.length - 1) SE.reorder(i, i + 1); };
      row.appendChild(down); body.appendChild(row);
    });
  };

  SE.toolbar = function() {
    if (document.getElementById('se-ux-toolbar') || !SE.iframe) return;
    var t = document.createElement('div'); t.id = 'se-ux-toolbar';
    t.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99996;display:flex;gap:6px;background:#11131F;border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:6px;box-shadow:0 12px 36px rgba(0,0,0,.45)';
    [['\u23F1 History', SE.history], ['\u2795 Section', SE.sectionLibrary], ['\u2195 Reorder', SE.reorderUI], ['\u21B6', SE.undo], ['\u21B7', SE.redo]].forEach(function(it) {
      var b = document.createElement('button'); b.textContent = it[0]; b.title = it[0];
      b.style.cssText = 'border:0;background:transparent;color:#E7E9F4;border-radius:8px;padding:6px 9px;cursor:pointer;font-size:12px';
      b.onmouseenter = function(){ b.style.background = 'rgba(99,91,255,.18)'; };
      b.onmouseleave = function(){ b.style.background = ''; };
      b.onclick = function(){ it[1](); }; t.appendChild(b);
    });
    document.body.appendChild(t);
  };

  // Expose globally
  global.MINE_SE = SE;

  // Auto-init on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', SE.init);
  } else {
    setTimeout(SE.init, 100);
  }
})(window);
