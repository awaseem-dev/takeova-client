// ═══════════════════════════════════════════════════════════════════
// MINE File Content Validator
// Magic-byte checks + content sniffing for uploaded files.
//
// Purpose: multer's fileFilter only looks at the client-provided MIME
// type and filename extension, both of which the client can lie about.
// A renamed .exe with Content-Type: image/png passes multer's filter.
// This module actually reads the file's first bytes to verify it matches
// the declared type.
//
// Usage:
//   const { validateUploadedFile } = require('./file-validator');
//   const result = validateUploadedFile(req.file.path, 'image');
//   if (!result.valid) {
//     fs.unlinkSync(req.file.path);
//     return res.status(400).json({ error: result.reason });
//   }
//
// Categories accepted:
//   'image'     — PNG, JPEG, GIF, WebP, SVG (script-free)
//   'document'  — PDF, DOCX, XLSX
//   'text'      — CSV, TXT, JSON (UTF-8 text validation)
//   'media'     — MP4, WebM, MP3
//   'archive'   — ZIP
//   'any'       — any of the above
// ═══════════════════════════════════════════════════════════════════

const fs = require("fs");

// Magic byte signatures for common file formats
const SIGNATURES = {
  // Images
  png:  { hex: "89504e470d0a1a0a", type: "image" },
  jpeg: { hex: "ffd8ff",            type: "image" },
  gif:  { hex: "47494638",          type: "image" },    // GIF8
  webp: { riff: true,               type: "image" },    // RIFF....WEBP
  // Documents
  pdf:  { hex: "25504446",          type: "document" }, // %PDF
  zip:  { hex: "504b",              type: "archive" },  // DOCX/XLSX/ZIP all start with PK
  // Media
  mp4:  { ftyp: true,               type: "media" },    // ....ftyp
  webm: { hex: "1a45dfa3",          type: "media" },
  mp3id3: { hex: "494433",          type: "media" },    // ID3
  mp3:  { hex: "fffb",              type: "media" },    // MPEG frame
};

/**
 * Validate an uploaded file by reading its first bytes.
 * Returns { valid: bool, type: string, reason: string }
 */
function validateUploadedFile(filePath, category = "any") {
  try {
    const buf = fs.readFileSync(filePath, { encoding: null });
    return validateUploadedBuffer(buf, category);
  } catch (e) {
    return { valid: false, reason: "Could not read file: " + e.message };
  }
}

/**
 * Same validation but for in-memory buffers (e.g. multer.memoryStorage).
 * Returns { valid: bool, type: string, reason: string }
 */
function validateUploadedBuffer(buf, category = "any") {
  try {
    if (!buf || buf.length < 4) {
      return { valid: false, reason: "File too small to validate" };
    }

    const hex = buf.slice(0, 16).toString("hex").toLowerCase();
    const str1k = buf.slice(0, 1024).toString("utf8");

    // IMAGE CATEGORY
    if (category === "image" || category === "any") {
      if (hex.startsWith("89504e470d0a1a0a")) return { valid: true, type: "png" };
      if (hex.startsWith("ffd8ff")) return { valid: true, type: "jpeg" };
      if (hex.startsWith("47494638")) return { valid: true, type: "gif" };
      if (hex.startsWith("52494646") && buf.slice(8, 12).toString("ascii") === "WEBP") {
        return { valid: true, type: "webp" };
      }
      if (str1k.match(/<svg[\s>]/i)) {
        const fullStr = buf.toString("utf8");
        if (/<script[\s>]/i.test(fullStr)) {
          return { valid: false, reason: "SVG contains <script> tags (not allowed)" };
        }
        if (/\son\w+\s*=/i.test(fullStr)) {
          return { valid: false, reason: "SVG contains inline event handlers (not allowed)" };
        }
        if (/javascript:/i.test(fullStr)) {
          return { valid: false, reason: "SVG contains javascript: URLs (not allowed)" };
        }
        if (/<foreignObject[\s>]/i.test(fullStr)) {
          return { valid: false, reason: "SVG contains <foreignObject> (not allowed)" };
        }
        return { valid: true, type: "svg" };
      }
    }

    // DOCUMENT CATEGORY
    if (category === "document" || category === "any") {
      if (hex.startsWith("25504446")) return { valid: true, type: "pdf" };
      if (hex.startsWith("504b0304") || hex.startsWith("504b0506") || hex.startsWith("504b0708")) {
        return { valid: true, type: "zip" };
      }
    }

    // MEDIA CATEGORY
    if (category === "media" || category === "any") {
      if (buf.length >= 8 && buf.slice(4, 8).toString("ascii") === "ftyp") {
        return { valid: true, type: "mp4" };
      }
      if (hex.startsWith("1a45dfa3")) return { valid: true, type: "webm" };
      if (hex.startsWith("494433") || hex.startsWith("fffb") || hex.startsWith("fff3") || hex.startsWith("fff2")) {
        return { valid: true, type: "mp3" };
      }
    }

    // ARCHIVE CATEGORY
    if (category === "archive" || category === "any") {
      if (hex.startsWith("504b")) return { valid: true, type: "zip" };
    }

    // TEXT CATEGORY
    if (category === "text" || category === "any") {
      const firstKB = buf.slice(0, Math.min(buf.length, 1024));
      let hasBinary = false;
      for (let i = 0; i < firstKB.length; i++) {
        const b = firstKB[i];
        if (b === 0 || (b < 9) || (b > 13 && b < 32 && b !== 27)) {
          hasBinary = true;
          break;
        }
      }
      if (!hasBinary) {
        if (hex.startsWith("4d5a") || hex.startsWith("7f454c46") || hex.startsWith("cafebabe")) {
          return { valid: false, reason: "File appears to be an executable, not text" };
        }
        return { valid: true, type: "text" };
      }
    }

    return {
      valid: false,
      reason: `File content does not match any allowed format for category '${category}'`
    };
  } catch (e) {
    return { valid: false, reason: "Could not validate: " + e.message };
  }
}

module.exports = { validateUploadedFile, validateUploadedBuffer };
