/**
 * lib/html-patcher.js — surgical HTML manipulation for the SEO agent's content edits.
 * No DOM library required.
 *
 *   const { patchHTML, generateDiff } = require("./html-patcher");
 *   const result = patchHTML(siteHtml, change);
 *   // → { html, applied, before, after, error }
 */

const SKIP_TAGS = ["script", "style", "noscript", "textarea"];

function patchHTML(html, change) {
  if (!html || typeof html !== "string") return { html, applied: false, error: "no html input" };
  if (!change || !change.type) return { html, applied: false, error: "no change spec" };

  try {
    switch (change.type) {
      case "h1": return _replaceFirstTag(html, "h1", change);
      case "h2": return _replaceTagByContent(html, "h2", change);
      case "h3": return _replaceTagByContent(html, "h3", change);
      case "content_replace":
      case "paragraph_rewrite": return _replaceTextSpan(html, change);
      case "content_topic": return _insertNewSection(html, change);
      case "internal_link": return _patchInternalLink(html, change);
      case "meta_keywords": return _patchMetaTag(html, "keywords", change);
      default: return { html, applied: false, error: "unsupported type: " + change.type };
    }
  } catch (e) {
    return { html, applied: false, error: "patch error: " + e.message };
  }
}

function _replaceFirstTag(html, tag, change) {
  const newText = String(change.newText || change.suggested || "").trim();
  if (!newText) return { html, applied: false, error: "no newText" };
  const re = new RegExp("(<" + tag + "[^>]*>)([\\s\\S]*?)(<\\/" + tag + ">)", "i");
  const m = html.match(re);
  if (!m) return { html, applied: false, error: "no <" + tag + "> found" };
  const newHtml = html.replace(re, m[1] + _escapeForHtml(newText) + m[3]);
  return { html: newHtml, applied: true, before: _stripTags(m[2]).slice(0, 500), after: newText.slice(0, 500), matchedTag: tag };
}

function _replaceTagByContent(html, tag, change) {
  const target = String(change.targetText || change.current || "").trim();
  const newText = String(change.newText || change.suggested || "").trim();
  if (!target || !newText) return { html, applied: false, error: "missing target/new text" };
  const re = new RegExp("<" + tag + "[^>]*>[\\s\\S]*?<\\/" + tag + ">", "gi");
  let m;
  while ((m = re.exec(html)) !== null) {
    const stripped = _stripTags(m[0]).trim();
    if (_fuzzyMatch(stripped, target)) {
      const oc = m[0].match(new RegExp("(<" + tag + "[^>]*>)([\\s\\S]*?)(<\\/" + tag + ">)", "i"));
      if (!oc) continue;
      const newBlock = oc[1] + _escapeForHtml(newText) + oc[3];
      const newHtml = html.slice(0, m.index) + newBlock + html.slice(m.index + m[0].length);
      return { html: newHtml, applied: true, before: stripped.slice(0, 500), after: newText.slice(0, 500), matchedTag: tag };
    }
  }
  return { html, applied: false, error: "no matching <" + tag + "> for \"" + target.slice(0, 60) + "\"" };
}

function _replaceTextSpan(html, change) {
  const target = String(change.targetText || change.current || "").trim();
  const newText = String(change.newText || change.suggested || "").trim();
  if (!target || target.length < 10) return { html, applied: false, error: "target too short or empty" };
  if (!newText) return { html, applied: false, error: "no newText" };

  const safe = _markSafeZones(html);
  const lowerHtml = safe.searchable.toLowerCase();
  const lowerTarget = target.toLowerCase();
  let idx = lowerHtml.indexOf(lowerTarget);
  if (idx === -1) {
    const partial = lowerTarget.slice(0, 60);
    idx = lowerHtml.indexOf(partial);
    if (idx === -1) return { html, applied: false, error: "target text not found in body" };
  }
  const realLen = target.length;
  const before = html.slice(idx, idx + realLen);
  const newHtml = html.slice(0, idx) + _escapeForHtml(newText) + html.slice(idx + realLen);
  return { html: newHtml, applied: true, before: before.slice(0, 500), after: newText.slice(0, 500) };
}

function _insertNewSection(html, change) {
  const heading = String(change.heading || change.suggested || "New section").trim();
  const body = String(change.body || change.newText || "").trim();
  if (!body) return { html, applied: false, error: "no body provided" };
  const section = "\n<section class=\"seo-agent-added\" data-seo-agent=\"1\">\n  <h2>" + _escapeForHtml(heading) + "</h2>\n  <p>" + _escapeForHtml(body) + "</p>\n</section>\n";
  const anchors = ["</main>", "</body>", "</html>"];
  for (const a of anchors) {
    const idx = html.toLowerCase().lastIndexOf(a);
    if (idx !== -1) {
      const newHtml = html.slice(0, idx) + section + html.slice(idx);
      return { html: newHtml, applied: true, before: "(none — new section)", after: heading + ": " + body.slice(0, 200), anchor: a };
    }
  }
  return { html: html + section, applied: true, before: "(none — new section)", after: heading + ": " + body.slice(0, 200), anchor: "(end-of-document)" };
}

function _patchInternalLink(html, change) {
  const targetHref = String(change.targetHref || change.current || "").trim();
  const newHref = String(change.newHref || "").trim();
  const newText = String(change.newText || change.suggested || "").trim();
  if (!targetHref) return { html, applied: false, error: "no targetHref" };
  const re = new RegExp("<a([^>]*?)href=[\"']" + _regexEscape(targetHref) + "[\"']([^>]*?)>([\\s\\S]*?)<\\/a>", "i");
  const m = html.match(re);
  if (!m) return { html, applied: false, error: "no matching link found" };
  let finalHref = newHref || targetHref;
  // _escapeAttr stops attribute breakout but not the scheme itself — block javascript:/data:/vbscript: (audit §64).
  if (/^\s*(javascript|data|vbscript):/i.test(finalHref)) finalHref = "#";
  const finalText = newText || m[3];
  // Escape link text like every other branch in this file — this was the one raw sink (audit §64).
  const replacement = "<a" + m[1] + "href=\"" + _escapeAttr(finalHref) + "\"" + m[2] + ">" + _escapeForHtml(finalText) + "</a>";
  const newHtml = html.replace(re, replacement);
  return { html: newHtml, applied: true, before: targetHref + " → " + _stripTags(m[3]).slice(0, 100), after: finalHref + " → " + _stripTags(finalText).slice(0, 100) };
}

function _patchMetaTag(html, name, change) {
  const newContent = String(change.newText || change.suggested || "").trim();
  if (!newContent) return { html, applied: false, error: "no content" };
  const re = new RegExp("(<meta[^>]+name=[\"']" + _regexEscape(name) + "[\"'][^>]*content=[\"'])([^\"']*)([\"'][^>]*>)", "i");
  const m = html.match(re);
  if (m) {
    const newHtml = html.replace(re, m[1] + _escapeAttr(newContent) + m[3]);
    return { html: newHtml, applied: true, before: m[2].slice(0, 500), after: newContent.slice(0, 500) };
  }
  const headClose = html.toLowerCase().indexOf("</head>");
  if (headClose !== -1) {
    const tag = "<meta name=\"" + _escapeAttr(name) + "\" content=\"" + _escapeAttr(newContent) + "\">";
    const newHtml = html.slice(0, headClose) + "  " + tag + "\n" + html.slice(headClose);
    return { html: newHtml, applied: true, before: "(no existing tag)", after: newContent.slice(0, 500) };
  }
  return { html, applied: false, error: "no <head> found" };
}

function generateDiff(beforeHtml, afterHtml) {
  if (beforeHtml === afterHtml) return { changed: false, lines: [] };
  const before = String(beforeHtml || "").split("\n");
  const after = String(afterHtml || "").split("\n");
  const max = Math.max(before.length, after.length);
  const lines = [];
  for (let i = 0; i < max; i++) {
    if (before[i] === after[i]) continue;
    lines.push({ line: i + 1, before: before[i] || "", after: after[i] || "" });
  }
  return { changed: lines.length > 0, lines: lines.slice(0, 50), totalChangedLines: lines.length };
}

function _stripTags(s) { return String(s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(); }
function _escapeForHtml(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function _escapeAttr(s) { return String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
function _regexEscape(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function _fuzzyMatch(a, b) {
  const A = a.toLowerCase().replace(/\s+/g, " ").trim();
  const B = b.toLowerCase().replace(/\s+/g, " ").trim();
  if (A === B) return true;
  if (A.indexOf(B) !== -1 || B.indexOf(A) !== -1) return true;
  if (Math.abs(A.length - B.length) > Math.max(5, A.length * 0.1)) return false;
  let diffs = 0;
  const len = Math.min(A.length, B.length);
  for (let i = 0; i < len; i++) if (A[i] !== B[i]) diffs++;
  return diffs / len < 0.15;
}
function _markSafeZones(html) {
  const ranges = [];
  for (const tag of SKIP_TAGS) {
    const re = new RegExp("<" + tag + "\\b[^>]*>[\\s\\S]*?<\\/" + tag + ">", "gi");
    let m;
    while ((m = re.exec(html)) !== null) ranges.push([m.index, m.index + m[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let searchable = html;
  for (const [s, e] of ranges) {
    searchable = searchable.slice(0, s) + " ".repeat(e - s) + searchable.slice(e);
  }
  return { searchable };
}

// Legacy-shape adapter for older callers expecting patchHtml({type, current, suggested, anchorUrl}) → {ok, html, reason}
function patchHtml(html, change) {
  if (!change) return { ok: false, html, reason: "no change" };
  const adapted = Object.assign({}, change, {
    newText: change.newText || change.suggested,
    targetText: change.targetText || change.current,
    newHref:   change.newHref   || change.anchorUrl
  });
  const r = patchHTML(html, adapted);
  return { ok: !!r.applied, html: r.html, reason: r.error, before: r.before, after: r.after };
}

module.exports = { patchHTML, patchHtml, generateDiff };
