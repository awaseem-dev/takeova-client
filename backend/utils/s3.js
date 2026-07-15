// ─────────────────────────────────────────────────────────────────────────────
// S3 Storage Helper
// Falls back to local disk if AWS credentials not configured
// Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_S3_BUCKET in .env
// Optionally set AWS_CLOUDFRONT_URL for CDN delivery
// ─────────────────────────────────────────────────────────────────────────────

const path = require("path");
const fs   = require("fs");
const { v4: uuid } = require("uuid");

let _s3Client = null;
let _s3Bucket = null;

// Read a setting from platform_settings DB, falling back to env var.
// Matches the pattern used by all other integrations (Twilio, SendGrid, Stripe).
function _getCred(name) {
  if (process.env[name]) return process.env[name];
  try {
    const { getDb } = require("../db/init");
    const row = getDb().prepare("SELECT value FROM platform_settings WHERE key = ?").get(name);
    return row?.value || null;
  } catch(e) { return null; }
}

function getS3() {
  if (_s3Client) return _s3Client;
  const key    = _getCred("AWS_ACCESS_KEY_ID");
  const secret = _getCred("AWS_SECRET_ACCESS_KEY");
  const region = _getCred("AWS_REGION") || "us-east-1";
  const endpoint = _getCred("AWS_S3_ENDPOINT");  // For Cloudflare R2 compatibility
  _s3Bucket    = _getCred("AWS_S3_BUCKET");
  if (!key || !secret || !_s3Bucket) return null;
  try {
    const { S3Client } = require("@aws-sdk/client-s3");
    const config = { region, credentials: { accessKeyId: key, secretAccessKey: secret } };
    if (endpoint) {
      config.endpoint = endpoint;
      config.forcePathStyle = true;  // R2 requires path-style addressing
    }
    _s3Client = new S3Client(config);
    return _s3Client;
  } catch(e) { console.error("[S3] SDK load error:", e.message); return null; }
}

function isS3Enabled() {
  return !!(_getCred("AWS_ACCESS_KEY_ID") && _getCred("AWS_SECRET_ACCESS_KEY") && _getCred("AWS_S3_BUCKET"));
}

function getCdnBase() {
  const bucket = _getCred("AWS_S3_BUCKET");
  const region = _getCred("AWS_REGION") || "us-east-1";
  const cf = _getCred("AWS_CLOUDFRONT_URL");
  if (cf) return cf.replace(/\/$/, "");
  return `https://${bucket}.s3.${region}.amazonaws.com`;
}

async function uploadToS3(bufferOrPath, key, contentType) {
  const s3 = getS3();
  if (!s3) throw new Error("S3 not configured — set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET");
  const { PutObjectCommand } = require("@aws-sdk/client-s3");
  const body = Buffer.isBuffer(bufferOrPath) ? bufferOrPath : fs.readFileSync(bufferOrPath);
  await s3.send(new PutObjectCommand({
    Bucket: _s3Bucket,
    Key: key,
    Body: body,
    ContentType: contentType || "application/octet-stream",
    ACL: "public-read",
  }));
  return `${getCdnBase()}/${key}`;
}

async function uploadBase64ToS3(base64, key, contentType) {
  return uploadToS3(Buffer.from(base64, "base64"), key, contentType);
}

async function deleteFromS3(key) {
  const s3 = getS3();
  if (!s3) return;
  const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
  try { await s3.send(new DeleteObjectCommand({ Bucket: _s3Bucket, Key: key })); } catch(e) {}
}

async function getSignedUrl(key, expiresIn) {
  const s3 = getS3();
  if (!s3) return null;
  const { GetObjectCommand } = require("@aws-sdk/client-s3");
  const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: _s3Bucket, Key: key }), { expiresIn: expiresIn || 3600 });
}

function getMulterStorage(keyPrefix) {
  if (isS3Enabled()) {
    try {
      const multerS3 = require("multer-s3");
      return multerS3({
        s3: getS3(),
        bucket: _s3Bucket,
        acl: "public-read",
        contentType: multerS3.AUTO_CONTENT_TYPE,
        key: (req, file, cb) => {
          const ext = path.extname(file.originalname);
          cb(null, `${keyPrefix || "uploads"}/${uuid()}${ext}`);
        },
      });
    } catch(e) { console.error("[S3] multer-s3 error:", e.message); }
  }
  // Fallback: local disk
  const dir = process.env.UPLOAD_DIR || "./uploads";
  fs.mkdirSync(dir, { recursive: true });
  return require("multer").diskStorage({
    destination: dir,
    filename: (req, file, cb) => { cb(null, uuid() + path.extname(file.originalname)); },
  });
}

function getFileUrl(file, backendUrl) {
  if (file.location) return file.location; // multer-s3 sets .location to the S3 URL
  const base = backendUrl || process.env.BACKEND_URL || "http://localhost:4000";
  return `${base}/api/files/${file.filename}`;
}

module.exports = { isS3Enabled, uploadToS3, uploadBase64ToS3, deleteFromS3, getSignedUrl, getMulterStorage, getFileUrl };
