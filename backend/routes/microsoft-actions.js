/**
 * MINE — Microsoft 365 Actions
 *
 * Endpoints invoked by the dashboards and MineControl. All require auth and
 * a connected Microsoft account (otherwise return 412 with hint to connect).
 *
 * Mounted at /api/microsoft.
 *
 * Outlook
 *   POST /email/send                 → send via /me/sendMail
 *   GET  /email/list                 → recent emails (?limit, ?search, ?unread=1)
 *   GET  /calendar/events            → upcoming events (?start, ?end, ?limit)
 *   POST /calendar/create            → new event
 *
 * Files
 *   GET  /onedrive/files             → list (?path or ?search)
 *   POST /onedrive/upload            → upload bytes (used by Word/PPT generation)
 *
 * Excel
 *   POST /excel/read                 → { fileId, sheet, range } → 2D values
 *   POST /excel/write                → { fileId, sheet, range, values }
 *   POST /excel/sheets               → { fileId } → list worksheet names
 *
 * Word
 *   POST /word/create                → { filename, content } → uploaded .docx
 *
 * PowerPoint
 *   POST /powerpoint/create          → { filename, slides:[{title,bullets[]}] } → uploaded .pptx
 */
const express = require('express');
const router  = express.Router();
const ms      = require('../services/ms-graph');
const { auth } = require('../middleware/auth');

function getDb(req) {
  return req.app.locals.db || require('../db/init').getDb();
}

// Resolve a valid access token for the current user, or 412 with a hint.
async function tokenOr412(req, res) {
  try {
    const db = getDb(req);
    const token = await ms.getValidAccessToken(db, req.userId);
    return token;
  } catch (e) {
    res.status(412).json({
      error:        'Not connected to Microsoft 365',
      hint:         'Open Integrations and connect Microsoft 365.',
      detail:       e.message,
      connect_url:  '/api/microsoft/connect',
    });
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// OUTLOOK — MAIL
// ═══════════════════════════════════════════════════════════════════

// POST /email/send  { to, subject, body, cc?, bcc?, isHtml? }
router.post('/email/send', auth, async (req, res) => {
  const token = await tokenOr412(req, res); if (!token) return;
  try {
    const { to, subject, body, cc, bcc, isHtml } = req.body || {};
    if (!to || !subject) return res.status(400).json({ error: 'to and subject are required' });
    await ms.sendEmail(token, { to, subject, body, cc, bcc, isHtml });
    res.json({ success: true });
  } catch (e) {
    console.error('[ms/email/send]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /email/list?limit=20&search=...&unread=1
router.get('/email/list', auth, async (req, res) => {
  const token = await tokenOr412(req, res); if (!token) return;
  try {
    const limit  = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const search = req.query.search || undefined;
    const unread = req.query.unread === '1' || req.query.unread === 'true';
    const messages = await ms.listEmails(token, { limit, search, unread });
    res.json({ messages });
  } catch (e) {
    console.error('[ms/email/list]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// OUTLOOK — CALENDAR
// ═══════════════════════════════════════════════════════════════════

// GET /calendar/events?start=&end=&limit=
router.get('/calendar/events', auth, async (req, res) => {
  const token = await tokenOr412(req, res); if (!token) return;
  try {
    const { start, end } = req.query;
    const limit  = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const events = await ms.listCalendarEvents(token, { start, end, limit });
    res.json({ events });
  } catch (e) {
    console.error('[ms/calendar/events]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /calendar/create  { subject, start, end, attendees?, body?, location?, isOnlineMeeting? }
router.post('/calendar/create', auth, async (req, res) => {
  const token = await tokenOr412(req, res); if (!token) return;
  try {
    const event = await ms.createCalendarEvent(token, req.body || {});
    res.json({ success: true, event });
  } catch (e) {
    console.error('[ms/calendar/create]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ONEDRIVE
// ═══════════════════════════════════════════════════════════════════

// GET /onedrive/files?path=...   or   ?search=...
router.get('/onedrive/files', auth, async (req, res) => {
  const token = await tokenOr412(req, res); if (!token) return;
  try {
    const { path, search } = req.query;
    const files = await ms.listOneDriveFiles(token, { path, search });
    res.json({ files });
  } catch (e) {
    console.error('[ms/onedrive/files]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /onedrive/upload  { filename, content_b64, parentPath?, contentType? }
router.post('/onedrive/upload', auth, async (req, res) => {
  const token = await tokenOr412(req, res); if (!token) return;
  try {
    const { filename, content_b64, parentPath, contentType } = req.body || {};
    if (!filename || !content_b64) return res.status(400).json({ error: 'filename and content_b64 are required' });
    const buf = Buffer.from(content_b64, 'base64');
    const file = await ms.uploadOneDriveFile(token, { filename, content: buf, parentPath, contentType });
    res.json({ success: true, file });
  } catch (e) {
    console.error('[ms/onedrive/upload]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// EXCEL
// ═══════════════════════════════════════════════════════════════════

// POST /excel/read  { fileId, sheet, range }
router.post('/excel/read', auth, async (req, res) => {
  const token = await tokenOr412(req, res); if (!token) return;
  try {
    const { fileId, sheet, range } = req.body || {};
    if (!fileId || !sheet || !range) return res.status(400).json({ error: 'fileId, sheet, range are required' });
    const values = await ms.readExcelRange(token, fileId, sheet, range);
    res.json({ values });
  } catch (e) {
    console.error('[ms/excel/read]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /excel/write  { fileId, sheet, range, values }
router.post('/excel/write', auth, async (req, res) => {
  const token = await tokenOr412(req, res); if (!token) return;
  try {
    const { fileId, sheet, range, values } = req.body || {};
    if (!fileId || !sheet || !range || !values) return res.status(400).json({ error: 'fileId, sheet, range, values are required' });
    await ms.writeExcelRange(token, fileId, sheet, range, values);
    res.json({ success: true });
  } catch (e) {
    console.error('[ms/excel/write]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /excel/sheets  { fileId }
router.post('/excel/sheets', auth, async (req, res) => {
  const token = await tokenOr412(req, res); if (!token) return;
  try {
    const { fileId } = req.body || {};
    if (!fileId) return res.status(400).json({ error: 'fileId is required' });
    const sheets = await ms.listExcelSheets(token, fileId);
    res.json({ sheets });
  } catch (e) {
    console.error('[ms/excel/sheets]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// WORD
// ═══════════════════════════════════════════════════════════════════

// POST /word/create  { filename, content }
// `content` may be plain text or basic HTML; we generate a minimal valid .docx
// (Office Open XML) and upload to OneDrive root.
router.post('/word/create', auth, async (req, res) => {
  const token = await tokenOr412(req, res); if (!token) return;
  try {
    const { filename, content, parentPath } = req.body || {};
    if (!filename || content == null) return res.status(400).json({ error: 'filename and content are required' });
    const fname = filename.match(/\.docx$/i) ? filename : (filename + '.docx');
    const buf = await buildDocxBuffer(String(content || ''));
    const file = await ms.uploadOneDriveFile(token, {
      filename:    fname,
      content:     buf,
      parentPath,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    res.json({ success: true, file });
  } catch (e) {
    console.error('[ms/word/create]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// POWERPOINT
// ═══════════════════════════════════════════════════════════════════

// POST /powerpoint/create  { filename, slides:[{title, bullets:[...]}] }
router.post('/powerpoint/create', auth, async (req, res) => {
  const token = await tokenOr412(req, res); if (!token) return;
  try {
    const { filename, slides, parentPath } = req.body || {};
    if (!filename || !Array.isArray(slides) || !slides.length) {
      return res.status(400).json({ error: 'filename and slides[] are required' });
    }
    const fname = filename.match(/\.pptx$/i) ? filename : (filename + '.pptx');
    const buf = await buildPptxBuffer(slides);
    const file = await ms.uploadOneDriveFile(token, {
      filename:    fname,
      content:     buf,
      parentPath,
      contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
    res.json({ success: true, file });
  } catch (e) {
    console.error('[ms/powerpoint/create]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// .docx / .pptx generation helpers
// Uses zero-dep tiny-zip (Node's built-in zlib + crc32) for ZIP packaging.
// ═══════════════════════════════════════════════════════════════════
const { createZip } = require('../services/tiny-zip');

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

async function buildDocxBuffer(plainText) {
  // Each line of input becomes a paragraph.
  const paragraphs = String(plainText).split(/\r?\n/).map(line => {
    if (!line.trim()) return '<w:p/>';
    return `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`;
  }).join('');

  return createZip([
    {
      name: '[Content_Types].xml',
      data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml"  ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    },
    {
      name: '_rels/.rels',
      data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    },
    {
      name: 'word/document.xml',
      data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${paragraphs}</w:body>
</w:document>`,
    },
  ]);
}

async function buildPptxBuffer(slides) {
  // Content types — overrides per slide
  let overrides = '';
  for (let i = 1; i <= slides.length; i++) {
    overrides += `<Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
  }

  // presentation.xml — slide ID list
  let sldIdLst = '';
  for (let i = 0; i < slides.length; i++) {
    sldIdLst += `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`;
  }

  // presentation rels — one rel per slide
  let presRels = '';
  for (let i = 0; i < slides.length; i++) {
    presRels += `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`;
  }

  const entries = [
    {
      name: '[Content_Types].xml',
      data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml"  ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  ${overrides}
</Types>`,
    },
    {
      name: '_rels/.rels',
      data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`,
    },
    {
      name: 'ppt/presentation.xml',
      data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
                xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldSz cx="9144000" cy="6858000" type="screen4x3"/>
  <p:notesSz cx="6858000" cy="9144000"/>
  <p:sldIdLst>${sldIdLst}</p:sldIdLst>
</p:presentation>`,
    },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${presRels}
</Relationships>`,
    },
  ];

  // One slide XML each
  slides.forEach((slide, idx) => {
    const title = xmlEscape(slide.title || `Slide ${idx + 1}`);
    const bullets = (slide.bullets || []).map(b => `
      <a:p><a:r><a:rPr lang="en-US" sz="1800"/><a:t>${xmlEscape(b)}</a:t></a:r></a:p>`).join('');
    entries.push({
      name: `ppt/slides/slide${idx + 1}.xml`,
      data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="838200" y="365125"/><a:ext cx="7467600" cy="1143000"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="3600" b="1"/><a:t>${title}</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="838200" y="1700000"/><a:ext cx="7467600" cy="4500000"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/>${bullets || '<a:p/>'}</p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`,
    });
  });

  return createZip(entries);
}

module.exports = router;
module.exports.buildDocxBuffer = buildDocxBuffer;
module.exports.buildPptxBuffer = buildPptxBuffer;
