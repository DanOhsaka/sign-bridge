/* ============================================================
   SignBridge — local API + static host
   Serves HTML/CSS/JS, /api/auth/*, and /api/predict.
   Mongo is required for auth. Prediction still starts if the
   database is down. On Vercel this file is not used; see /api.
   ============================================================ */

const path = require("path");
const express = require("express");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const Database = require("./db");
const app = require("./app");

const PORT = Number(process.env.PORT) || 3000;

app.use(express.static(path.join(__dirname, "..")));

async function start() {
  if (process.env.VERCEL) return;

  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is missing. Copy server/.env.example to server/.env");
  }

  try {
    await Database.getInstance().connect(process.env.MONGODB_URI);
    console.log("MongoDB connected (singleton)");
  } catch (err) {
    console.warn("MongoDB unavailable. Auth routes will fail until it is up.");
    console.warn(err.message || err);
  }

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
