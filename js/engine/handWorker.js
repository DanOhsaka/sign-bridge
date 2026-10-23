/* ============================================================
   SignBridge — Hand / Holistic landmarker Web Worker (classic)
   Must be a classic worker: MediaPipe's WASM loader calls
   importScripts(), which module workers disallow.

   Default model: HandLandmarker (fast skeleton). Holistic is
   optional when pose is required (training / LSTM).
   ============================================================ */

var landmarker = null;
var modelKind = "hands"; /* "hands" | "holistic" */
var FilesetResolver = null;
var HandLandmarker = null;
var HolisticLandmarker = null;
var visionFileset = null;

var HAND_MODEL =
  "https://storage.googleapis.com/mediapipe-models/" +
  "hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

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

async function ensureVision() {
  if (visionFileset && HandLandmarker && HolisticLandmarker) return;
  var visionModule = await import(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/+esm"
  );
  FilesetResolver = visionModule.FilesetResolver;
  HandLandmarker = visionModule.HandLandmarker;
  HolisticLandmarker = visionModule.HolisticLandmarker;
  visionFileset = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm"
  );
}

function closeLandmarker() {
  if (landmarker && typeof landmarker.close === "function") {
    try { landmarker.close(); } catch (e) {}
  }
  landmarker = null;
}

function buildHandOpts(delegate) {
  return {
    baseOptions: {
      modelAssetPath: HAND_MODEL,
      delegate: delegate,
    },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.45,
    minHandPresenceConfidence: 0.45,
    minTrackingConfidence: 0.45,
  };
}

function buildHolisticOpts(delegate) {
  return {
    baseOptions: {
      modelAssetPath: HOLISTIC_MODEL,
      delegate: delegate,
    },
    runningMode: "VIDEO",
    outputFaceBlendshapes: false,
    outputPoseSegmentationMasks: false,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
  };
}

async function createModel(kind, preferGpu) {
  await ensureVision();
  closeLandmarker();
  modelKind = kind === "holistic" ? "holistic" : "hands";

  var tryGpu = preferGpu !== false;
  var delegates = tryGpu ? ["GPU", "CPU"] : ["CPU"];
  var lastErr = null;

  for (var i = 0; i < delegates.length; i++) {
    var del = delegates[i];
    try {
      if (modelKind === "holistic") {
        landmarker = await HolisticLandmarker.createFromOptions(
          visionFileset,
          buildHolisticOpts(del)
        );
      } else {
        landmarker = await HandLandmarker.createFromOptions(
          visionFileset,
          buildHandOpts(del)
        );
      }
      return {
        delegate: del,
        model: modelKind,
        fallback: del === "CPU" && tryGpu ? "GPU create failed" : null,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("Landmarker create failed");
}

/**
 * HandLandmarker returns landmarks[] + handedness[] (categoryName Left/Right).
 * Map into Holistic-shaped left/right groups for the rest of the pipeline.
 * Mirror-aware: MediaPipe labels are from the subject's view; with a selfie
 * camera the engine may swap — live.js mirror is display-only, so we keep
 * anatomical labels from the model.
 */
function handsToGroups(results) {
  var left = [];
  var right = [];
  var detections = [];
  var lms = results.landmarks || [];
  var handed = results.handedness || results.handednesses || [];
  for (var i = 0; i < lms.length; i++) {
    var pts = serializePoints(lms[i]);
    if (!pts) continue;
    var label = "";
    var score = 0.5;
    var h = handed[i];
    if (h && h.length && h[0]) {
      label = String(h[0].categoryName || h[0].displayName || "").toLowerCase();
      if (typeof h[0].score === "number") score = h[0].score;
    }
    detections.push({ landmarks: pts, label: label, score: score });
    /* Keep legacy groups for older consumers — live.js prefers detections. */
    if (label.indexOf("left") >= 0) left.push(pts);
    else if (label.indexOf("right") >= 0) right.push(pts);
    else if (!right.length) right.push(pts);
    else left.push(pts);
  }
  return {
    leftHandLandmarks: left,
    rightHandLandmarks: right,
    poseLandmarks: [],
    detections: detections,
  };
}

self.onmessage = function (ev) {
  var msg = ev.data || {};

  if (msg.type === "init" || msg.type === "reinit") {
    var kind = msg.model === "holistic" ? "holistic" : "hands";
    createModel(kind, msg.preferGpu !== false)
      .then(function (info) {
        self.postMessage({
          type: "ready",
          info: info,
          reinit: msg.type === "reinit",
        });
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

      var payload;
      if (modelKind === "holistic") {
        var lh = serializeGroups(results.leftHandLandmarks);
        var rh = serializeGroups(results.rightHandLandmarks);
        payload = {
          leftHandLandmarks: lh,
          rightHandLandmarks: rh,
          poseLandmarks: serializeGroups(results.poseLandmarks),
          detections: [],
        };
        for (var li = 0; li < lh.length; li++) {
          payload.detections.push({ landmarks: lh[li], label: "left", score: 0.85 });
        }
        for (var ri = 0; ri < rh.length; ri++) {
          payload.detections.push({ landmarks: rh[ri], label: "right", score: 0.85 });
        }
      } else {
        payload = handsToGroups(results);
      }

      self.postMessage({
        type: "result",
        id: msg.id,
        model: modelKind,
        inferMs: performance.now() - t0,
        wallSentMs: msg.wallSentMs,
        mediaMs: msg.timestamp,
        leftHandLandmarks: payload.leftHandLandmarks,
        rightHandLandmarks: payload.rightHandLandmarks,
        poseLandmarks: payload.poseLandmarks,
        detections: payload.detections || [],
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
