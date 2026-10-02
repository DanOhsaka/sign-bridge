/* ============================================================
   SignBridge — Hand landmarker Web Worker (classic)
   Must be a classic worker: MediaPipe's WASM loader calls
   importScripts(), which module workers disallow.
   Dynamic import() loads the ESM vision bundle.
   ============================================================ */

/* global importScripts */

var landmarker = null;

function serializeLandmarks(list) {
  if (!list || !list.length) return [];
  var out = new Array(list.length);
  for (var i = 0; i < list.length; i++) {
    var hand = list[i];
    var pts = new Array(hand.length);
    for (var j = 0; j < hand.length; j++) {
      pts[j] = { x: hand[j].x, y: hand[j].y, z: hand[j].z || 0 };
    }
    out[i] = pts;
  }
  return out;
}

function serializeHandedness(list) {
  if (!list || !list.length) return [];
  var out = new Array(list.length);
  for (var i = 0; i < list.length; i++) {
    var entry = list[i];
    var cat = Array.isArray(entry) ? entry[0] : entry;
    out[i] = cat
      ? [{
          categoryName: cat.categoryName || cat.displayName || "",
          score: typeof cat.score === "number" ? cat.score : 0.8,
        }]
      : [{ categoryName: "", score: 0 }];
  }
  return out;
}

async function init(preferGpu) {
  var visionModule = await import(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/+esm"
  );
  var FilesetResolver = visionModule.FilesetResolver;
  var HandLandmarker = visionModule.HandLandmarker;

  var vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm"
  );

  var opts = {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/" +
        "hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: preferGpu ? "GPU" : "CPU",
    },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  };

  try {
    landmarker = await HandLandmarker.createFromOptions(vision, opts);
  } catch (err) {
    if (preferGpu) {
      opts.baseOptions.delegate = "CPU";
      landmarker = await HandLandmarker.createFromOptions(vision, opts);
      return { delegate: "CPU", fallback: String(err && err.message || err) };
    }
    throw err;
  }
  return { delegate: opts.baseOptions.delegate };
}

self.onmessage = function (ev) {
  var msg = ev.data || {};

  if (msg.type === "init") {
    init(msg.preferGpu !== false)
      .then(function (info) {
        self.postMessage({ type: "ready", info: info });
      })
      .catch(function (err) {
        self.postMessage({
          type: "error",
          error: String(err && err.message || err),
        });
      });
    return;
  }

  if (msg.type === "detect") {
    if (!landmarker) {
      if (msg.bitmap && msg.bitmap.close) msg.bitmap.close();
      self.postMessage({ type: "error", id: msg.id, error: "Landmarker not ready" });
      return;
    }
    try {
      var t0 = performance.now();
      var results = landmarker.detectForVideo(msg.bitmap, msg.timestamp);
      if (msg.bitmap && msg.bitmap.close) msg.bitmap.close();
      self.postMessage({
        type: "result",
        id: msg.id,
        inferMs: performance.now() - t0,
        wallSentMs: msg.wallSentMs,
        mediaMs: msg.timestamp,
        landmarks: serializeLandmarks(results.landmarks),
        handednesses: serializeHandedness(results.handednesses || results.handedness),
      });
    } catch (err) {
      if (msg.bitmap && msg.bitmap.close) {
        try { msg.bitmap.close(); } catch (e) {}
      }
      self.postMessage({
        type: "error",
        id: msg.id,
        error: String(err && err.message || err),
      });
    }
  }
};
