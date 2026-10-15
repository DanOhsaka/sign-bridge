/* ============================================================
   SignBridge — Holistic landmarker Web Worker (classic)
   Must be a classic worker: MediaPipe's WASM loader calls
   importScripts(), which module workers disallow.
   Dynamic import() loads the ESM vision bundle.

   HolisticLandmarker is the model the LSTM was trained against
   (see dev/stan). One pass returns anatomical left/right hands
   plus the pose points createReadableFrame normalizes around.
   ============================================================ */

/* global importScripts */

var holistic = null;

var HOLISTIC_MODEL =
  "https://storage.googleapis.com/mediapipe-models/" +
  "holistic_landmarker/holistic_landmarker/float16/1/" +
  "holistic_landmarker.task";

function serializePoints(list) {
  if (!list || !list.length) return null;
  var pts = new Array(list.length);
  for (var j = 0; j < list.length; j++) {
    pts[j] = { x: list[j].x, y: list[j].y, z: list[j].z || 0 };
  }
  return pts;
}

function serializeGroups(list) {
  if (!list || !list.length) return [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var pts = serializePoints(list[i]);
    if (pts) out.push(pts);
  }
  return out;
}

async function init(preferGpu) {
  var visionModule = await import(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/+esm"
  );
  var FilesetResolver = visionModule.FilesetResolver;
  var HolisticLandmarker = visionModule.HolisticLandmarker;

  var vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm"
  );

  var opts = {
    baseOptions: {
      modelAssetPath: HOLISTIC_MODEL,
      delegate: preferGpu ? "GPU" : "CPU",
    },
    runningMode: "VIDEO",
  };

  try {
    holistic = await HolisticLandmarker.createFromOptions(vision, opts);
  } catch (err) {
    if (preferGpu) {
      opts.baseOptions.delegate = "CPU";
      holistic = await HolisticLandmarker.createFromOptions(vision, opts);
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
    if (!holistic) {
      if (msg.bitmap && msg.bitmap.close) msg.bitmap.close();
      self.postMessage({ type: "error", id: msg.id, error: "Landmarker not ready" });
      return;
    }
    try {
      var t0 = performance.now();
      var results = holistic.detectForVideo(msg.bitmap, msg.timestamp);
      if (msg.bitmap && msg.bitmap.close) msg.bitmap.close();
      self.postMessage({
        type: "result",
        id: msg.id,
        inferMs: performance.now() - t0,
        wallSentMs: msg.wallSentMs,
        mediaMs: msg.timestamp,
        leftHandLandmarks: serializeGroups(results.leftHandLandmarks),
        rightHandLandmarks: serializeGroups(results.rightHandLandmarks),
        poseLandmarks: serializeGroups(results.poseLandmarks),
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
