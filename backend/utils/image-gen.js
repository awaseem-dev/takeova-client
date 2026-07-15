// utils/image-gen.js — unified image generation on Google Gemini ("Nano Banana 2").
// Replaces the old api.nanobanana.com calls. Uses GEMINI_API_KEY (from the Google account).
// Returns a real image URL (uploaded to S3) so it can be posted to social platforms /
// served on sites; falls back to a data: URL only if S3 isn't configured; null if no key.
const { uploadBase64ToS3, isS3Enabled } = require("./s3");

// Gemini controls aspect ratio via the prompt, so turn a pixel size / keyword into a hint.
function sizeToAspect(size) {
  const m = /^(\d+)\s*x\s*(\d+)$/.exec(String(size || ""));
  if (!m) {
    const s = String(size || "").toLowerCase();
    if (s.includes("portrait") || s.includes("vertical") || s.includes("story")) return "9:16 vertical";
    if (s.includes("landscape") || s.includes("banner") || s.includes("wide")) return "1.91:1 landscape";
    return "1:1 square";
  }
  const w = +m[1], h = +m[2];
  if (w === h) return "1:1 square";
  if (h > w) return (h / w >= 1.5) ? "9:16 vertical" : "4:5 portrait";
  return (w / h >= 1.7) ? "1.91:1 landscape banner" : "landscape";
}

/**
 * Generate an image with Google Gemini.
 * @param {string} prompt
 * @param {object} [opts] - { size, referenceImageUrl, getSetting }
 * @returns {Promise<string|null>} image URL (S3), data: URL fallback, or null.
 */
async function generateImage(prompt, opts = {}) {
  const { size = "1024x1024", referenceImageUrl = null, getSetting } = opts;
  const geminiKey =
    (typeof getSetting === "function" && getSetting("GEMINI_API_KEY")) || process.env.GEMINI_API_KEY;
  if (!geminiKey) return null;

  const aspect = sizeToAspect(size);
  const fullPrompt = `${String(prompt || "").slice(0, 1800)}${aspect ? `\n\n(Aspect ratio: ${aspect}.)` : ""}`;
  const parts = [{ text: fullPrompt }];

  // Optional image-to-image: pass a reference image as inline base64.
  if (referenceImageUrl) {
    try {
      const ref = await fetch(referenceImageUrl);
      if (ref.ok) {
        const buf = Buffer.from(await ref.arrayBuffer());
        parts.push({
          inline_data: {
            mime_type: ref.headers.get("content-type") || "image/jpeg",
            data: buf.toString("base64"),
          },
        });
      }
    } catch (_) { /* ignore ref fetch failure, fall through to text-only */ }
  }

  try {
    // Model: gemini-3.1-flash-image-preview (Nano Banana 2). Verify the current model id on first run.
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts }] }),
      }
    );
    const data = await r.json();

    const respParts = data?.candidates?.[0]?.content?.parts || [];
    const imgPart = respParts.find((p) => p.inline_data || p.inlineData);
    if (!imgPart) {
      console.warn("[image-gen] Gemini returned no image:", data?.error?.message || "");
      return null;
    }
    const inline = imgPart.inline_data || imgPart.inlineData;
    const mime = inline.mime_type || inline.mimeType || "image/png";
    const b64 = inline.data;

    if (isS3Enabled()) {
      const ext = (mime.split("/")[1] || "png").replace("jpeg", "jpg");
      const key = `ai-images/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      return await uploadBase64ToS3(b64, key, mime);
    }
    // Fallback: data URL (renders in-app, but NOT postable to social platforms).
    return `data:${mime};base64,${b64}`;
  } catch (e) {
    console.warn("[image-gen] generation failed:", e.message);
    return null;
  }
}

module.exports = { generateImage };
