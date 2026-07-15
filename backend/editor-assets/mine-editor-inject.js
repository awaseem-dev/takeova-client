// ═══════════════════════════════════════════════════════════════════
// MINE v49.2 — WYSIWYG Site Editor (client module)
// This script is INJECTED INTO THE PREVIEW IFRAME to enable inline editing.
// It talks to the parent dashboard via postMessage.
//
// Messages from iframe → parent:
//   { type: 'mine:element-selected', selector, text, tag, hasImage }
//   { type: 'mine:element-changed',  selector, content }
//   { type: 'mine:image-click-requested', selector }
//   { type: 'mine:ready' }
//
// Messages from parent → iframe:
//   { type: 'mine:set-html', html }
//   { type: 'mine:apply-edit', selector, content, attr? }
//   { type: 'mine:enable' }  — turn on edit mode
//   { type: 'mine:disable' } — turn off
// ═══════════════════════════════════════════════════════════════════
(function() {
  'use strict';
  if (window.__MINE_EDITOR_LOADED) return;
  window.__MINE_EDITOR_LOADED = true;

  let editMode = false;
  let selectedEl = null;

  // ─── Unique selector for an element (path from body) ────────────────
  function uniqueSelector(el) {
    if (!el || el === document.body) return 'body';
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      let selector = cur.tagName.toLowerCase();
      if (cur.className && typeof cur.className === 'string') {
        const cls = cur.className.trim().split(/\s+/).filter(c => c && !c.startsWith('mine-')).slice(0, 2);
        if (cls.length) selector += '.' + cls.map(c => CSS.escape(c)).join('.');
      }
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(s => s.tagName === cur.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(cur) + 1;
          selector += ':nth-of-type(' + idx + ')';
        }
      }
      parts.unshift(selector);
      cur = cur.parentElement;
    }
    return parts.join(' > ') || 'body';
  }

  // ─── Inject edit-mode styles ────────────────────────────────────────
  const style = document.createElement('style');
  style.id = 'mine-editor-styles';
  style.textContent = `
    .mine-edit-hover {
      outline: 2px dashed #2563EB !important;
      outline-offset: 2px !important;
      cursor: pointer !important;
    }
    .mine-edit-selected {
      outline: 3px solid #2563EB !important;
      outline-offset: 2px !important;
    }
    .mine-edit-selected[contenteditable="true"] {
      cursor: text !important;
      background: rgba(37,99,235,0.05);
    }
    .mine-edit-tooltip {
      position: fixed;
      background: #0F172A;
      color: #fff;
      padding: 6px 10px;
      border-radius: 6px;
      font-size: 12px;
      font-family: -apple-system, system-ui, sans-serif;
      z-index: 999999;
      pointer-events: none;
      white-space: nowrap;
    }
  `;
  document.head.appendChild(style);

  const tooltip = document.createElement('div');
  tooltip.className = 'mine-edit-tooltip';
  tooltip.style.display = 'none';
  document.body.appendChild(tooltip);

  // ─── Selectable: text elements, images, buttons, links ──────────────
  const EDITABLE_TAGS = ['h1','h2','h3','h4','h5','h6','p','span','a','button','li','img','div'];
  function isEditable(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    if (el.closest('.mine-edit-tooltip')) return false;
    const tag = el.tagName.toLowerCase();
    if (!EDITABLE_TAGS.includes(tag)) return false;
    // For divs, only allow ones that have direct text content (not pure containers)
    if (tag === 'div') {
      const hasDirectText = Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim());
      if (!hasDirectText) return false;
    }
    return true;
  }

  // ─── Hover handler ──────────────────────────────────────────────────
  document.addEventListener('mouseover', (e) => {
    if (!editMode) return;
    const el = e.target;
    if (!isEditable(el)) return;
    if (el === selectedEl) return;

    // Remove old hover
    document.querySelectorAll('.mine-edit-hover').forEach(x => x.classList.remove('mine-edit-hover'));
    el.classList.add('mine-edit-hover');

    // Show tooltip
    const tag = el.tagName.toLowerCase();
    const label = tag === 'img' ? '🖼 Click to replace image' : '✎ Click to edit';
    tooltip.textContent = label;
    tooltip.style.display = 'block';
    tooltip.style.left = e.clientX + 12 + 'px';
    tooltip.style.top = e.clientY + 12 + 'px';
  }, true);

  document.addEventListener('mouseout', (e) => {
    if (!editMode) return;
    if (e.target.classList) e.target.classList.remove('mine-edit-hover');
    tooltip.style.display = 'none';
  }, true);

  document.addEventListener('mousemove', (e) => {
    if (!editMode || tooltip.style.display === 'none') return;
    tooltip.style.left = e.clientX + 12 + 'px';
    tooltip.style.top = e.clientY + 12 + 'px';
  }, true);

  // ─── Click to select / start editing ────────────────────────────────
  document.addEventListener('click', (e) => {
    if (!editMode) return;
    const el = e.target;
    if (!isEditable(el)) return;

    e.preventDefault();
    e.stopPropagation();
    tooltip.style.display = 'none';

    // Deselect previous
    if (selectedEl && selectedEl !== el) {
      selectedEl.classList.remove('mine-edit-selected');
      selectedEl.removeAttribute('contenteditable');
    }

    selectedEl = el;
    el.classList.remove('mine-edit-hover');
    el.classList.add('mine-edit-selected');

    const selector = uniqueSelector(el);
    const tag = el.tagName.toLowerCase();

    if (tag === 'img') {
      // Image: tell parent to open file picker
      parent.postMessage({
        type: 'mine:image-click-requested',
        selector: selector,
        currentSrc: el.getAttribute('src') || ''
      }, '*');
    } else {
      // Text: make contentEditable
      el.setAttribute('contenteditable', 'true');
      el.focus();
      // Select all on first click
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      parent.postMessage({
        type: 'mine:element-selected',
        selector: selector,
        text: el.textContent.trim(),
        tag: tag,
        hasImage: false
      }, '*');
    }
  }, true);

  // ─── On blur, commit the change ─────────────────────────────────────
  document.addEventListener('blur', (e) => {
    if (!editMode) return;
    const el = e.target;
    if (!el || el.getAttribute('contenteditable') !== 'true') return;

    const selector = uniqueSelector(el);
    const content = el.textContent.trim();

    el.removeAttribute('contenteditable');
    parent.postMessage({
      type: 'mine:element-changed',
      selector: selector,
      content: content
    }, '*');
  }, true);

  // ─── Receive messages from parent ───────────────────────────────────
  window.addEventListener('message', (e) => {
    const msg = e.data || {};
    if (!msg.type || !msg.type.startsWith('mine:')) return;

    switch (msg.type) {
      case 'mine:enable':
        editMode = true;
        document.body.style.cursor = 'default';
        break;
      case 'mine:disable':
        editMode = false;
        document.querySelectorAll('.mine-edit-hover, .mine-edit-selected').forEach(x => {
          x.classList.remove('mine-edit-hover', 'mine-edit-selected');
          x.removeAttribute('contenteditable');
        });
        tooltip.style.display = 'none';
        selectedEl = null;
        break;
      case 'mine:apply-edit': {
        const el = document.querySelector(msg.selector);
        if (el) {
          if (msg.attr) el.setAttribute(msg.attr, msg.content || '');
          else el.textContent = msg.content || '';
        }
        break;
      }
      case 'mine:deselect':
        if (selectedEl) {
          selectedEl.classList.remove('mine-edit-selected');
          selectedEl.removeAttribute('contenteditable');
          selectedEl = null;
        }
        break;
    }
  });

  // ─── Tell parent we're ready ────────────────────────────────────────
  parent.postMessage({ type: 'mine:ready' }, '*');
})();
