/**
 * MINE in-app user notifications
 *
 *   GET    /api/user-notifications        — list unread notifications for the current user
 *   POST   /api/user-notifications/:id/read — mark as read
 *   POST   /api/user-notifications/mark-all-read — bulk dismiss
 *
 * Producers (other modules) write rows into user_notifications via:
 *   INSERT INTO user_notifications (id, user_id, type, severity, title, body, action_url, action_label)
 */
"use strict";

const express = require("express");
const router  = express.Router();
const crypto  = require("crypto");
const { auth }    = require("../middleware/auth");
const { getDb } = require("../db/init");

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT,
      severity TEXT,
      title TEXT,
      body TEXT,
      action_url TEXT,
      action_label TEXT,
      read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_user_notifications_user_id_read ON user_notifications(user_id, read)"); } catch(_) {}
}

// ─── GET /api/user-notifications — list unread for current user ───────────
router.get("/", auth, (req, res) => {
  const db = getDb();
  ensureTable(db);
  const rows = db.prepare(`SELECT id, type, severity, title, body, action_url, action_label, created_at
                           FROM user_notifications
                           WHERE user_id = ? AND read = 0
                           ORDER BY created_at DESC
                           LIMIT 50`).all(req.userId);
  res.json({ notifications: rows });
});

// ─── POST /api/user-notifications/:id/read — dismiss one ──────────────────
router.post("/:id/read", auth, (req, res) => {
  const db = getDb();
  ensureTable(db);
  db.prepare("UPDATE user_notifications SET read = 1 WHERE id = ? AND user_id = ?")
    .run(req.params.id, req.userId);
  res.json({ ok: true });
});

// ─── POST /api/user-notifications/mark-all-read — bulk dismiss ────────────
router.post("/mark-all-read", auth, (req, res) => {
  const db = getDb();
  ensureTable(db);
  db.prepare("UPDATE user_notifications SET read = 1 WHERE user_id = ? AND read = 0").run(req.userId);
  res.json({ ok: true });
});

module.exports = router;
