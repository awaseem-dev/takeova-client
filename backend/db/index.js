// ═══════════════════════════════════════════════════════════════════
// MINE — DB selector
// Picks Postgres if DATABASE_URL is set (production),
// falls back to SQLite for local dev.
// ═══════════════════════════════════════════════════════════════════
const USE_POSTGRES = !!process.env.DATABASE_URL;

let db;

async function init() {
  if (USE_POSTGRES) {
    console.log('[db] Using Postgres (DATABASE_URL detected)');
    db = require('./pg-adapter').init();
    // Run schema — pg-adapter.exec converts types automatically
    const fs = require('fs');
    const path = require('path');
    const schemaPath = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      await db.exec(fs.readFileSync(schemaPath, 'utf8'));
    }
  } else {
    console.log('[db] Using SQLite (local/dev mode)');
    db = require('./init');
    if (typeof db.init === 'function') db.init();
  }
  return db;
}

module.exports = { init, get: () => db, USE_POSTGRES };
