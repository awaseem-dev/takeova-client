// ═══════════════════════════════════════════════════════════════════
// MINE — Postgres adapter (for production scale)
// Usage:
//   const db = require('./pg-adapter').init();
//   db.prepare('SELECT * FROM users WHERE id = ?').get(id);   // → Promise or sync wrapper
//   db.prepare('INSERT INTO users ...').run(a, b, c);
//
// Wraps node-postgres to provide a better-sqlite3-compatible API surface
// so existing route code doesn't need to change.
// ═══════════════════════════════════════════════════════════════════
const { Pool } = require('pg');

let pool;

function convertQuery(sql) {
  // Convert `?` placeholders to `$1`, `$2`, ...
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function convertSchema(sql) {
  // SQLite → Postgres type mapping
  return sql
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY')
    .replace(/TEXT DEFAULT \(datetime\('now'\)\)/gi, 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP')
    .replace(/DATETIME DEFAULT CURRENT_TIMESTAMP/gi, 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP')
    .replace(/INTEGER DEFAULT 0/gi, 'INTEGER DEFAULT 0')
    .replace(/REAL/gi, 'DOUBLE PRECISION')
    .replace(/ON CONFLICT\((\w+(?:, \w+)*)\) DO UPDATE SET/gi, 'ON CONFLICT ($1) DO UPDATE SET')
    // Postgres uses BOOLEAN where SQLite uses INTEGER for booleans
    .replace(/INTEGER DEFAULT 1(?=[^\w])/g, 'INTEGER DEFAULT 1');
}

function init() {
  if (pool) return wrapper();
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000
  });
  return wrapper();
}

function wrapper() {
  return {
    prepare(sql) {
      const pgSql = convertQuery(sql);
      return {
        async get(...params) {
          const r = await pool.query(pgSql, params);
          return r.rows[0];
        },
        async all(...params) {
          const r = await pool.query(pgSql, params);
          return r.rows;
        },
        async run(...params) {
          const r = await pool.query(pgSql, params);
          return { changes: r.rowCount, lastInsertRowid: r.rows[0]?.id };
        }
      };
    },
    async exec(sql) {
      // Schema creation — apply conversions
      const pgSql = convertSchema(sql);
      await pool.query(pgSql);
    },
    async pragma() { /* no-op — PG doesn't use pragma */ },
    pool
  };
}

async function close() {
  if (pool) await pool.end();
  pool = null;
}

module.exports = { init, close, convertQuery, convertSchema };
