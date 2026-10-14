/* ============================================================
   SignBridge — shared Express app

   This is the API used in production, exported from the functions in api/.
   It is also mounted by server/index.js for local development, so the two
   run identical code (see docs/DEPLOY.md).

   Deliberately absent: app.listen, process.exit, express.static and dotenv.
   Vercel owns the server lifecycle and serves the static site from its CDN;
   a port listener or a process.exit() in here would kill the invocation.
   ============================================================ */

const express = require("express");
const cors = require("cors");

const Database = require("./db");
const authRoutes = require("./authRoutes");

const app = express();

app.use(cors());
app.use(express.json());

/* Liveness + connectivity probe. Registered BEFORE the connect middleware so
   it still answers when Mongo is unreachable — that is the point of it, and
   it is the endpoint to check first when signup misbehaves. */
app.get("/api/health", async function (req, res) {
  var state = "down";
  try {
    await Database.getInstance().connect(process.env.MONGODB_URI);
    state = "connected";
  } catch (err) {
    console.error("[health]", err.message || err);
  }
  res.json({ ok: true, db: state });
});

/* Connect before any model runs. Required because db.js sets
   bufferCommands: false — without this, User.findOne() would throw instead of
   waiting for the connection.

   Scoped to /api on purpose. server/index.js mounts express.static on this
   same app, and an unscoped middleware would make every static asset request
   wait on a Mongo connection. */
app.use("/api", async function (req, res, next) {
  try {
    await Database.getInstance().connect(process.env.MONGODB_URI);
    next();
  } catch (err) {
    console.error("[db]", err.message || err);
    res.status(503).json({ message: "Database unavailable." });
  }
});

app.use("/api/auth", authRoutes);

/* No catch-all 404 here: server/index.js appends express.static after this
   app, and a terminating 404 would shadow every static file. */

/* Four arguments — that is what marks this as an Express error handler. */
app.use(function (err, req, res, next) {
  console.error(err);
  res.status(500).json({ message: "Server error." });
});

module.exports = app;
