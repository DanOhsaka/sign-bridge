/* ============================================================
   SignBridge — Pose + hand landmarker Web Worker (classic)
   Must be a classic worker: MediaPipe's WASM loader calls
   importScripts(), which module workers disallow.

   Pose Landmarker Lite supplies the shoulder, elbow, and wrist
   points. Hand Landmarker supplies both 21-point hands. The
   posted result keeps Holistic's left/right/pose shape so the
   LSTM frame builder does not change.
   ============================================================ */

var landmarker = null;
var modelKind = "hands"; /* "hands" | "holistic" */
var FilesetResolver = null;
var HandLandmarker = null;
var HolisticLandmarker = null;
var visionFileset = null;

var poseLandmarker = null;
var handLandmarker = null;

var POSE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/" +
  "pose_landmarker/pose_landmarker_lite/float16/1/" +
  "pose_landmarker_lite.task";

var HAND_MODEL =
  "https://storage.googleapis.com/mediapipe-models/" +
  "hand_landmarker/hand_landmarker/float16/1/" +
  "hand_landmarker.task";

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

function handName(entry) {
  var top = entry && entry[0];
  if (!top) return "";
  return top.categoryName || top.displayName || "";
}

function splitHands(handResults) {
  var left = null;
  var right = null;
  var landmarks = (handResults && handResults.landmarks) || [];
  var handed = (handResults && handResults.handedness) || [];
  for (var i = 0; i < landmarks.length; i++) {
    var name = handName(handed[i]);
    if (name === "Right") {
      if (!right) right = landmarks[i];
    } else if (name === "Left") {
      if (!left) left = landmarks[i];
    }
  }
  return {
    left: left ? [left] : [],
    right: right ? [right] : [],
  };
}

async function createDetectors(vision, PoseLandmarker, HandLandmarker, delegate) {
  var pose = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: POSE_MODEL,
      delegate: delegate,
    },
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.4,
    minPosePresenceConfidence: 0.4,
    minTrackingConfidence: 0.4,
  });
  var hands = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: HAND_MODEL,
      delegate: delegate,
    },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.3,
    minHandPresenceConfidence: 0.3,
    minTrackingConfidence: 0.3,
  });
  return { pose: pose, hands: hands };
}

async function init(preferGpu) {
  var visionModule = await import(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/+esm"
  );
  var FilesetResolver = visionModule.FilesetResolver;
  var PoseLandmarker = visionModule.PoseLandmarker;
  var HandLandmarker = visionModule.HandLandmarker;

  var vision = await FilesetResolver.forVisionTasks(
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
    /* Detect a bit stricter; keep tracking lower so face-edge flicker
       does not flip presence every frame (pass 6 hysteresis). */
    minHandDetectionConfidence: 0.55,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.4,
  };
}

  var delegate = preferGpu ? "GPU" : "CPU";
  try {
    var created = await createDetectors(
      vision, PoseLandmarker, HandLandmarker, delegate
    );
    poseLandmarker = created.pose;
    handLandmarker = created.hands;
    return { delegate: delegate };
  } catch (err) {
    if (!preferGpu) throw err;
    var cpu = await createDetectors(
      vision, PoseLandmarker, HandLandmarker, "CPU"
    );
    poseLandmarker = cpu.pose;
    handLandmarker = cpu.hands;
    return { delegate: "CPU", fallback: String(err && err.message || err) };
  }
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
    if (!poseLandmarker || !handLandmarker) {
      if (msg.bitmap && msg.bitmap.close) msg.bitmap.close();
      self.postMessage({ type: "error", id: msg.id, error: "Landmarker not ready" });
      return;
    }
    try {
      var t0 = performance.now();
      var pose = poseLandmarker.detectForVideo(msg.bitmap, msg.timestamp);
      var hands = handLandmarker.detectForVideo(msg.bitmap, msg.timestamp);
      var split = splitHands(hands);
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
        leftHandLandmarks: serializeGroups(split.left),
        rightHandLandmarks: serializeGroups(split.right),
        poseLandmarks: serializeGroups(pose.landmarks),
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
