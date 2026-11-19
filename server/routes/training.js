/* ============================================================
   SignBridge — local training-sample writer
   The browser posts one finished recording here. This route
   writes it to training-data/<LABEL>/<LABEL>_NNN.json.
   Local server only. It does not use MongoDB.
   ============================================================ */

const fs = require("fs");
const path = require("path");
const express = require("express");

const router = express.Router();
const fsp = fs.promises;
const TRAINING_ROOT = path.resolve(__dirname, "..", "..", "training-data");
const FRAME_COUNT = 60;

function isLocalRequest(req) {
  var ip = (req.socket && req.socket.remoteAddress) || "";
  return ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1";
}

function safeLabel(raw) {
  if (typeof raw !== "string") return null;
  var label = raw.trim().toUpperCase().replace(/\s+/g, "_");
  if (!/^[A-Z0-9_]+$/.test(label)) return null;
  return label;
}

async function nextIndex(dir, label) {
  var names = [];

  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") return 1;
    throw err;
  }

  var pattern = new RegExp("^" + label + "_(\\d+)\\.json$");
  var max = 0;

  names.forEach(function (name) {
    var match = name.match(pattern);
    if (!match) return;
    var value = parseInt(match[1], 10);
    if (value > max) max = value;
  });

  return max + 1;
}

function fileName(label, index) {
  var padded = String(index).padStart(3, "0");
  return label + "_" + padded + ".json";
}

router.post("/sample", async function (req, res) {
  if (!isLocalRequest(req)) {
    return res.status(403).json({
      message: "Training samples can only be saved from this computer."
    });
  }

  var sample = req.body || {};
  var label = safeLabel(sample.label);
  var frames = sample.frames;

  if (!label) {
    return res.status(400).json({
      message: "A sign label made of letters, numbers, or underscores is required."
    });
  }

  if (!Array.isArray(frames) || frames.length !== FRAME_COUNT) {
    return res.status(400).json({
      message: "Expected exactly " + FRAME_COUNT + " frames."
    });
  }

  var dir = path.resolve(TRAINING_ROOT, label);
  if (dir !== path.join(TRAINING_ROOT, label)) {
    return res.status(400).json({ message: "Invalid sign label." });
  }

  try {
    await fsp.mkdir(dir, { recursive: true });
    var json = JSON.stringify(sample, null, 2) + "\n";

    for (var attempt = 0; attempt < 20; attempt++) {
      var index = await nextIndex(dir, label);
      var name = fileName(label, index);
      var fullPath = path.join(dir, name);

      try {
        await fsp.writeFile(fullPath, json, { encoding: "utf8", flag: "wx" });
        var relativePath = "training-data/" + label + "/" + name;
        console.log("Saved training sample:", relativePath);
        return res.json({
          ok: true,
          label: label,
          file: name,
          path: relativePath
        });
      } catch (err) {
        if (err && err.code === "EEXIST") continue;
        throw err;
      }
    }

    return res.status(500).json({
      message: "Could not choose the next sample number."
    });
  } catch (err) {
    console.error("Training save error:", err);
    return res.status(500).json({
      message: "Could not write the training sample."
    });
  }
});

module.exports = router;
