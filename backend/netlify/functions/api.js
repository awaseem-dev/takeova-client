// Netlify Functions entry point — wraps the Express app (server.js) with
// serverless-http so Netlify's Lambda-style handler signature can invoke it.
// Requiring (not running) server.js skips app.listen(); Netlify invokes the
// wrapped handler per-request instead of keeping a process alive.
const serverless = require("serverless-http");
const app = require("../../server.js");

module.exports.handler = serverless(app);
