// ═══════════════════════════════════════════════════════════════════════════
// Tailwind Compile Helper
// ═══════════════════════════════════════════════════════════════════════════
// Compiles the Tailwind classes used in an AI-generated site into a small
// static CSS file. Replaces the `<script src="cdn.tailwindcss.com">` tag
// with an inline <style> so the published site no longer depends on the
// Tailwind CDN at runtime. This removes:
//   - The "cdn.tailwindcss.com should not be used in production" console
//     warning (cosmetic but off-putting when inspected)
//   - The ~300KB JS runtime that has to parse utility classes on every
//     page load (replaced with ~10-20KB of pre-compiled CSS)
//   - The runtime dependency on an external CDN (sites work if CDN is down)
//
// Flow:
//   1. Extract the inline `tailwind.config = {...}` block from the HTML
//   2. Write a temp Tailwind config + CSS entry point to a scratch dir
//   3. Invoke Tailwind CLI with the HTML as its content source
//   4. Read the compiled CSS back
//   5. Remove the CDN script + config, inject the compiled CSS as <style>
//
// Caching: compiled results are cached in memory keyed by sha256(html+config)
// so republishing the same HTML is instant.
// ═══════════════════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");

const CACHE = new Map();
const CACHE_MAX = 200; // LRU-ish cap

// Locate the Tailwind CLI binary. Installed via `npm i tailwindcss`.
// Falls back to node_modules/.bin lookup on multiple paths for robustness.
function findTailwindBin() {
  const candidates = [
    path.join(__dirname, "..", "node_modules", ".bin", "tailwindcss"),
    path.join(__dirname, "..", "..", "node_modules", ".bin", "tailwindcss"),
    path.join(process.cwd(), "node_modules", ".bin", "tailwindcss"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

function hashKey(html, configStr) {
  return crypto.createHash("sha256").update(html + "|" + configStr).digest("hex").slice(0, 32);
}

// Extract the inline `tailwind.config = {...}` config block so we can feed
// the brand colors/fonts back to Tailwind CLI. Returns the config OBJECT
// syntax (with leading `tailwind.config =` stripped).
function extractConfigObject(html) {
  // Match: `tailwind.config = { ... };` — non-greedy, balance-aware-ish
  const m = html.match(/tailwind\.config\s*=\s*(\{[\s\S]*?\n\s*\})\s*(?:;|<\/script>)/);
  if (!m) return null;
  return m[1];
}

// Strip the CDN script tag and the inline config block from the HTML.
// Returns the cleaned HTML without Tailwind runtime dependencies.
function stripTailwindCdn(html) {
  let out = html;
  // Remove the <script src="...tailwindcss..."></script> tag (any variant)
  out = out.replace(/<script[^>]*src=["'][^"']*tailwindcss[^"']*["'][^>]*>\s*<\/script>/gi, "");
  // Remove the inline `tailwind.config = {...}` <script> block — we only
  // strip <script> blocks that CONTAIN the tailwind.config assignment, so
  // user's other scripts are preserved.
  out = out.replace(
    /<script\b[^>]*>\s*(?:[^<]*?tailwind\.config\s*=\s*\{[\s\S]*?\n\s*\}\s*;?[\s\S]*?)<\/script>/gi,
    ""
  );
  return out;
}

/**
 * Compile a site's Tailwind classes into static CSS and inline it into the HTML.
 * @param {string} html - Full HTML document with Tailwind CDN + config
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=10000] - Max time to wait for compile
 * @returns {Promise<{html: string, css: string, cached: boolean, compiledSize: number}>}
 */
async function compileTailwind(html, opts = {}) {
  const timeoutMs = opts.timeoutMs || 10000;

  if (!html || typeof html !== "string") {
    throw new Error("compileTailwind: html must be a non-empty string");
  }

  // Quick check — if the HTML doesn't use Tailwind at all, skip
  if (!/tailwindcss|tailwind\.config/i.test(html)) {
    return { html, css: "", cached: false, compiledSize: 0, skipped: true };
  }

  const configObj = extractConfigObject(html) || "{}";
  const cacheKey = hashKey(html, configObj);

  // Cache hit — serve instantly
  if (CACHE.has(cacheKey)) {
    const cached = CACHE.get(cacheKey);
    // LRU bump
    CACHE.delete(cacheKey);
    CACHE.set(cacheKey, cached);
    return { ...cached, cached: true };
  }

  const bin = findTailwindBin();
  if (!bin) {
    // Tailwind CLI not installed — return the HTML unchanged but mark
    // why, so the caller can log and fall back gracefully.
    console.warn("[tailwind-compile] Tailwind CLI not found — install with `npm i tailwindcss` in backend/");
    return { html, css: "", cached: false, compiledSize: 0, skipped: true, reason: "bin_not_found" };
  }

  // Create a scratch directory for this compile
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mine-tw-"));

  try {
    // 1. Write the site HTML so Tailwind CLI can scan it for classes
    const htmlPath = path.join(workDir, "site.html");
    fs.writeFileSync(htmlPath, html, "utf8");

    // 2. Write the Tailwind config. CLI mode uses CommonJS.
    //    We parse the inline config object and wrap it in a module.exports.
    const configPath = path.join(workDir, "tailwind.config.js");
    const configJs = `module.exports = Object.assign(${configObj}, {
  content: ["./site.html"],
});`;
    fs.writeFileSync(configPath, configJs, "utf8");

    // 3. Write the CSS entry point with the three Tailwind directives
    const cssInPath = path.join(workDir, "input.css");
    fs.writeFileSync(cssInPath, "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n", "utf8");

    // 4. Run the CLI
    const cssOutPath = path.join(workDir, "output.css");
    await new Promise((resolve, reject) => {
      const child = execFile(
        bin,
        ["-c", configPath, "-i", cssInPath, "-o", cssOutPath, "--minify"],
        { cwd: workDir, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const msg = stderr?.toString() || err.message;
            return reject(new Error("Tailwind compile failed: " + msg.slice(0, 500)));
          }
          resolve();
        }
      );
      child.on("error", reject);
    });

    // 5. Read the compiled CSS
    if (!fs.existsSync(cssOutPath)) {
      throw new Error("Tailwind compile produced no output file");
    }
    const css = fs.readFileSync(cssOutPath, "utf8");

    // 6. Strip the CDN script/config from HTML and embed compiled CSS
    const cleanedHtml = stripTailwindCdn(html);
    // Inject the <style> tag right before </head>
    const styleTag = `<style data-tw-compiled="1">\n${css}\n</style>`;
    let finalHtml;
    if (/<\/head>/i.test(cleanedHtml)) {
      finalHtml = cleanedHtml.replace(/<\/head>/i, styleTag + "\n</head>");
    } else {
      // No </head>? Prepend.
      finalHtml = styleTag + "\n" + cleanedHtml;
    }

    const result = { html: finalHtml, css, cached: false, compiledSize: css.length };

    // Cache (with LRU eviction)
    if (CACHE.size >= CACHE_MAX) {
      const oldest = CACHE.keys().next().value;
      if (oldest) CACHE.delete(oldest);
    }
    CACHE.set(cacheKey, result);

    return result;
  } finally {
    // Clean up scratch dir
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

/**
 * Cheaper detection: does this HTML use the Tailwind CDN?
 */
function usesTailwindCdn(html) {
  if (!html || typeof html !== "string") return false;
  return /src=["'][^"']*cdn\.tailwindcss\.com[^"']*["']/i.test(html);
}

module.exports = {
  compileTailwind,
  usesTailwindCdn,
  stripTailwindCdn,
  _findTailwindBin: findTailwindBin, // exported for diagnostics
};
