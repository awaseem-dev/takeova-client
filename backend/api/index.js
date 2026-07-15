// Vercel serverless entry point — re-exports the Express app from server.js.
// Requiring (not running) server.js skips app.listen(); Vercel invokes the
// exported app per-request instead of keeping a process alive.
module.exports = require("../server.js");
