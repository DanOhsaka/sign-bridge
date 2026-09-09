/* ============================================================
   SignBridge — API + static host
   Boots Mongo via Database.getInstance() (singleton), then
   serves the existing HTML/CSS/JS and /api/auth/*.
   ============================================================ */

const path = require("path");
const express = require("express");
const cors = require("cors");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const Database = require("./db");
const authRoutes = require("./routes/auth");

const PORT = Number(process.env.PORT) || 3000;
const app = express();

app.use(cors());
app.use(express.json());
app.use("/api/auth", authRoutes);
app.use(express.static(path.join(__dirname, "..")));

app.get("/api/health", function (req, res) {
  var db = Database.getInstance();
  res.json({ ok: true, db: db.isConnected() ? "connected" : "down" });
});

async function start() {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is missing. Copy server/.env.example to server/.env");
  }

  var db = Database.getInstance();
  await db.connect(process.env.MONGODB_URI);
  console.log("MongoDB connected (singleton)");

  app.listen(PORT, function () {
    console.log("SignBridge on http://localhost:" + PORT);
  });
}

start().catch(function (err) {
  console.error(err.message || err);
  process.exit(1);
});

process.on("SIGINT", async function () {
  await Database.getInstance().disconnect();
  process.exit(0);
});
