/* ============================================================
   SignBridge — Pose + hand landmarker Web Worker (classic)
   Must be a classic worker: MediaPipe's WASM loader calls
   importScripts(), which module workers disallow.
   Dynamic import() loads the ESM vision bundle.

   Two model kinds (chosen by live.js via msg.model):

     "pose"  Pose Landmarker Lite (shoulders / elbows / wrists)
             + Hand Landmarker (both 21-point hands). This is the
             pipeline the LSTM was trained on. The posted result
             keeps the left / right / pose shape the LSTM frame
             builder expects. NOT Holistic.

     "hands" Hand Landmarker only. Fast; used where pose is not
             needed (Practice letter drills).

   "holistic" is still accepted as an alias for "pose" so an old
   cached live.js cannot select a model that no longer exists.
   ============================================================ */

var modelKind = "hands"; /* "hands" | "pose" */
var visionFileset = null;
var FilesetResolver = null;
var HandLandmarker = null;
var PoseLandmarker = null;

var poseLandmarker = null;
var handLandmarker = null;

var POSE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/" +
  "pose_landmarker/pose_landmarker_lite/float16/1/" +
  "pose_landmarker_lite.task";

var HAND_MODEL =
  "https://storage.googleapis.com/mediapipe-models/" +
  "hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

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
  if (visionFileset && HandLandmarker && PoseLandmarker) return;
  var visionModule = await import(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/+esm"
  );
  FilesetResolver = visionModule.FilesetResolver;
  HandLandmarker = visionModule.HandLandmarker;
  PoseLandmarker = visionModule.PoseLandmarker;
  visionFileset = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm"
  );
}

function closeOne(lm) {
  if (lm && typeof lm.close === "function") {
    try { lm.close(); } catch (e) {}
  }
}

function closeLandmarkers() {
  closeOne(poseLandmarker);
  closeOne(handLandmarker);
  poseLandmarker = null;
  handLandmarker = null;
}

/* Hand-only drills: detect a bit stricter, keep tracking lower so
   face-edge flicker does not flip presence every frame. */
function buildHandOptsFast(delegate) {
  return {
    baseOptions: { modelAssetPath: HAND_MODEL, delegate: delegate },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.55,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.4,
  };
}

/* LSTM pipeline: thresholds the training frames were captured with. */
function buildHandOptsLstm(delegate) {
  return {
    baseOptions: { modelAssetPath: HAND_MODEL, delegate: delegate },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.3,
    minHandPresenceConfidence: 0.3,
    minTrackingConfidence: 0.3,
  };
}

function buildPoseOpts(delegate) {
  return {
    baseOptions: { modelAssetPath: POSE_MODEL, delegate: delegate },
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.4,
    minPosePresenceConfidence: 0.4,
    minTrackingConfidence: 0.4,
  };
}

async function createModel(kind, preferGpu) {
  await ensureVision();
  closeLandmarkers();
  modelKind = (kind === "pose" || kind === "holistic") ? "pose" : "hands";

  var delegates = preferGpu !== false ? ["GPU", "CPU"] : ["CPU"];
  var lastErr = null;

  for (var i = 0; i < delegates.length; i++) {
    var del = delegates[i];
    try {
      if (modelKind === "pose") {
        poseLandmarker = await PoseLandmarker.createFromOptions(
          visionFileset, buildPoseOpts(del)
        );
        handLandmarker = await HandLandmarker.createFromOptions(
          visionFileset, buildHandOptsLstm(del)
        );
      } else {
        handLandmarker = await HandLandmarker.createFromOptions(
          visionFileset, buildHandOptsFast(del)
        );
      }
      return {
        delegate: del,
        model: modelKind,
        fallback: del === "CPU" && preferGpu !== false ? "GPU create failed" : null,
      };
    } catch (err) {
      lastErr = err;
      closeLandmarkers();
    }
  }
  throw lastErr || new Error("Landmarker create failed");
}

function handLabel(entry) {
  var top = entry && entry[0];
  if (!top) return "";
  return top.categoryName || top.displayName || "";
}

/* Pose mode: Hand Landmarker's anatomical Left/Right become the
   left / right arrays (first of each), exactly as the LSTM saw. */
function poseModePayload(pose, hands) {
  var left = null;
  var right = null;
  var lms = (hands && hands.landmarks) || [];
  var handed = (hands && (hands.handedness || hands.handednesses)) || [];
  for (var i = 0; i < lms.length; i++) {
    var name = handLabel(handed[i]);
    if (name === "Right") {
      if (!right) right = lms[i];
    } else if (name === "Left") {
      if (!left) left = lms[i];
    }
  }
  var lh = serializeGroups(left ? [left] : []);
  var rh = serializeGroups(right ? [right] : []);
  var payload = {
    leftHandLandmarks: lh,
    rightHandLandmarks: rh,
    poseLandmarks: serializeGroups(pose && pose.landmarks),
    detections: [],
  };
  for (var li = 0; li < lh.length; li++) {
    payload.detections.push({ landmarks: lh[li], label: "left", score: 0.85 });
  }
  for (var ri = 0; ri < rh.length; ri++) {
    payload.detections.push({ landmarks: rh[ri], label: "right", score: 0.85 });
  }
  return payload;
}

/**
 * HandLandmarker returns landmarks[] + handedness[] (categoryName Left/Right).
 * Map into left/right groups plus a detections[] list; live.js prefers
 * detections.
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
    createModel(msg.model, msg.preferGpu !== false)
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
    var ready = modelKind === "pose"
      ? (poseLandmarker && handLandmarker)
      : handLandmarker;
    if (!ready) {
      if (msg.bitmap && msg.bitmap.close) msg.bitmap.close();
      self.postMessage({ type: "error", id: msg.id, error: "Landmarker not ready" });
      return;
    }
    try {
      var t0 = performance.now();
      var payload;
      if (modelKind === "pose") {
        var pose = poseLandmarker.detectForVideo(msg.bitmap, msg.timestamp);
        var hands = handLandmarker.detectForVideo(msg.bitmap, msg.timestamp);
        payload = poseModePayload(pose, hands);
      } else {
        payload = handsToGroups(
          handLandmarker.detectForVideo(msg.bitmap, msg.timestamp)
        );
      }
      if (msg.bitmap && msg.bitmap.close) msg.bitmap.close();

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
