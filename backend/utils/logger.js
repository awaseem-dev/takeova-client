/**
 * logger.js — Structured logging for MINE.
 *
 * Replaces ad-hoc console.* with a JSON-structured logger that integrates
 * with log aggregators (Datadog, Loggly, Better Stack, etc.) on deploy.
 *
 * USAGE
 *   const log = require("./utils/logger");
 *   log.info({ userId, action: "signup" }, "user signed up");
 *   log.warn({ route: "/api/x" }, "slow response");
 *   log.error({ err }, "something failed");
 *
 * REQUEST LOGGING (in server.js, near the top)
 *   const { httpLogger } = require("./utils/logger");
 *   app.use(httpLogger);                       // auto-logs every request
 *
 * The existing console.* statements throughout the codebase keep working —
 * pino just adds structure on top, no rip-and-replace needed today.
 *
 * IN PRODUCTION: set LOG_LEVEL=info or warn. In dev, pino-pretty makes
 * output human-readable if installed (npm i -D pino-pretty), otherwise
 * raw JSON lines are emitted (which is correct for log aggregators).
 */

const pino     = require("pino");
const pinoHttp = require("pino-http");

const isProd = process.env.NODE_ENV === "production";
const level  = process.env.LOG_LEVEL || (isProd ? "info" : "debug");

// Base logger — JSON in production, pretty in dev if pino-pretty is installed
const logger = pino({
  level,
  base: { svc: "mine-backend" },
  formatters: {
    level(label) { return { level: label }; }, // emit "level": "info" not 30
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Redact common secret fields from logs
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-api-key']",
      "req.body.password",
      "req.body.token",
      "req.body.api_key",
      "*.password",
      "*.password_hash",
      "*.token",
      "*.api_key",
      "*.stripe_secret",
    ],
    censor: "[REDACTED]",
  },
});

// HTTP request middleware — logs every request with timing + status
const httpLogger = pinoHttp({
  logger,
  // Skip noisy paths that don't need per-request logs
  autoLogging: {
    ignore: (req) => {
      const url = req.url || "";
      return (
        url.startsWith("/api/notifications") ||      // polled every 20s
        url.startsWith("/api/health")        ||
        url.startsWith("/api/auth/me")       ||      // polled on every page load
        url.startsWith("/favicon")           ||
        url === "/"
      );
    },
  },
  customLogLevel(req, res, err) {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400)        return "warn";
    return "info";
  },
  // Compact serialisers — log just what's useful
  serializers: {
    req(req) {
      return {
        method:  req.method,
        url:     req.url,
        // userId is set by auth middleware
        userId:  req.userId || undefined,
      };
    },
    res(res) {
      return { statusCode: res.statusCode };
    },
  },
});

module.exports         = logger;        // default export — log.info/warn/error
module.exports.logger  = logger;
module.exports.httpLogger = httpLogger; // express middleware
