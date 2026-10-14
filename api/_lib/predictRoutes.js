/* MIRROR of server/routes/predict.js — keep in sync.
   The browser posts 30 shoulder-centered frames here.
   This route forwards that body to the Python model
   and returns its JSON. It does not use MongoDB. */

const express = require("express");

const router = express.Router();
const DEFAULT_LSTM_URL = "http://127.0.0.1:9001/predict";

function lstmUrl() {
  return process.env.LSTM_API_URL || DEFAULT_LSTM_URL;
}

router.post("/", async function (req, res) {
  var frames = req.body && req.body.frames;

  if (!Array.isArray(frames) || frames.length !== 30) {
    return res.status(400).json({
      message: "Expected exactly 30 frames."
    });
  }

  try {
    var response = await fetch(lstmUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frames: frames })
    });

    var text = await response.text();
    var payload = {};

    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (parseErr) {
        payload = { message: text };
      }
    }

    if (!response.ok) {
      var status = response.status >= 400 && response.status < 600
        ? response.status
        : 502;
      return res.status(status).json(
        payload && typeof payload === "object"
          ? payload
          : { message: "The sign model rejected this sequence." }
      );
    }

    return res.json(payload);
  } catch (err) {
    console.error("LSTM proxy error:", err);
    return res.status(502).json({
      message: "Could not reach the sign model. Start the Python API on port 9001."
    });
  }
});

module.exports = router;
