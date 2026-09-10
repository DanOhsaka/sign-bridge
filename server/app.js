/* ============================================================
   SignBridge — Express app (no listen)
   Shared by local `node server/index.js` and Vercel /api/*.
   Static HTML is served locally in index.js; Vercel serves it
   as static files so page loads never cold-start Node.
   ============================================================ */

const express = require("express");
const cors = require("cors");

const Database = require("./db");
const authRoutes = require("./routes/auth");

const app = express();

app.use(cors());
app.use(function (req, res, next) {
  if (Buffer.isBuffer(req.body)) {
    var raw = req.body.toString("utf8");
    try { req.body = raw ? JSON.parse(raw) : {}; } catch (e) { req.body = {}; }
  } else if (typeof req.body === "string") {
    try { req.body = req.body ? JSON.parse(req.body) : {}; } catch (e) { req.body = {}; }
  }
  next();
});
app.use(express.json());

app.use("/api", async function (req, res, next) {
  try {
    await Database.getInstance().connect(process.env.MONGODB_URI);
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database unavailable." });
  }
});

app.use("/api/auth", authRoutes);

app.get("/api/health", function (req, res) {
  var db = Database.getInstance();
  res.json({ ok: true, db: db.isConnected() ? "connected" : "down" });
});

module.exports = app;
