/* ============================================================
   SignBridge — Vercel serverless wrapper
   Connects Mongo (reuses the process singleton), then hands the
   request to the shared Express app. canonicalPath is used when
   the runtime strips the URL down to "/".
   ============================================================ */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const app = require("./app");
const Database = require("./db");

function createHandler(canonicalPath) {
  return async function (req, res) {
    var url = String(req.url || "");
    if (!url.startsWith("/api")) {
      var query = url.indexOf("?") >= 0 ? url.slice(url.indexOf("?")) : "";
      req.url = canonicalPath + query;
    }

    try {
      if (!process.env.JWT_SECRET) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ message: "JWT_SECRET is missing." }));
      }
      await Database.getInstance().connect(process.env.MONGODB_URI);
    } catch (err) {
      console.error(err);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({
        message: err && err.message === "MONGODB_URI is missing."
          ? "MONGODB_URI is missing."
          : "Database unavailable."
      }));
    }

    return app(req, res);
  };
}

module.exports = createHandler;
