/* ============================================================
   SignBridge — Live MediaPipe Engine (live.js)
   ------------------------------------------------------------
   Real-time pipeline (freshness > processing every frame):

     Camera (display) ──────────────► <video>
           │
           ▼ downscale ≤640px ImageBitmap
     HandLandmarker Web Worker (GPU) via RVFC + busy gate
           │
           ├── raw landmarks ──► classifier (never predicted)
           │
           └── hand lifecycle ──► One Euro (per-joint) + light predict
                                  └── rAF overlay (opacity / expiry)

   Ghost hands: render loop expires a slot ~70ms after lastSeen,
   independent of the next inference result.
   Stale / out-of-order worker results are discarded for pose updates
   but still refresh presence so disappearance is not delayed.
   ============================================================ */

window.SB = window.SB || {};

SB.LiveEngine = function () {
  var self = this;

  var state = "off";
  var classifier = null;

  var landmarker = null;
  var worker = null;
  var workerReady = false;
  var useWorker = false;
  var detectId = 0;
  var latestAcceptedId = 0;
  var latestAcceptedMediaMs = -1;
  var stream = null;

  var videoEl = null;
  var canvasEl = null;
  var inferCanvas = null;
  var inferCtx = null;

  var running = false;
  var inferenceBusy = false;
  var rvfcHandle = null;
  var renderRaf = null;
  var useRvfc = typeof HTMLVideoElement !== "undefined" &&
    typeof HTMLVideoElement.prototype.requestVideoFrameCallback === "function";

  var mirror = true;
  var drawLandmarksEnabled = true;
  var showHud = true;
  var showHandLabels = true;

  /* Lifecycle timeouts (ms) — short enough to kill ghosts, long enough to avoid flicker */
  var UNCERTAIN_MS = 45;
  var LOST_MS = 75;
  var FADE_MS = 70;
  var MAX_RESULT_AGE_MS = 70;

  var predictSec = 0.028;
  var maxPredictNorm = 0.07;
  var INFER_MAX_W = 640;

  var leftFilter = new SB.HandLandmarkFilter({ perJoint: true });
  var rightFilter = new SB.HandLandmarkFilter({ perJoint: true });
  var leftUiBuf = [];
  var rightUiBuf = [];
  var leftPredBuf = [];
  var rightPredBuf = [];
  var drawPtsBuf = [];

  function makeSlot() {
    return {
      state: "lost",       /* tracking | uncertain | lost */
      raw: null,
      prevRaw: null,
      ui: null,
      conf: 0,
      lastSeenMs: 0,
      captureMs: 0,
      mediaMs: 0,
      rawAtMs: 0,
      rawDtMs: 33,
      opacity: 0,
      label: "",
    };
  }

  var slots = { left: makeSlot(), right: makeSlot() };
  var prevPairTMs = 0;

  var stats = {
    camFps: 0,
    inferFps: 0,
    renderFps: 0,
    inferMs: 0,
    frameAgeMs: 0,
    dropped: 0,
    stale: 0,
    hands: 0,
    quality: "idle",
    trackState: "lost",
    backend: "—",
  };
  var camFrameCount = 0;
  var inferFrameCount = 0;
  var renderFrameCount = 0;
  var lastStatsTick = 0;
  var lastMediaTimestampMs = 0;
  var lastTrackEmit = "";
  var lastHandsEmit = -1;

  var HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20],
    [0, 17],
  ];

  // ----------------------------------------------------------
  // Load HandLandmarker — prefer Web Worker, fall back to main
  // ----------------------------------------------------------

  function loadLandmarker() {
    console.log("Loading MediaPipe HandLandmarker…");
    return initWorker()
      .catch(function (err) {
        console.warn(
          "Hand worker unavailable, using main thread:",
          err && err.message ? err.message : err
        );
        useWorker = false;
        workerReady = false;
        if (worker) {
          try { worker.terminate(); } catch (e) {}
          worker = null;
        }
        return initMainThreadLandmarker();
      });
  }

  function initWorker() {
    if (typeof Worker === "undefined") {
      return Promise.reject(new Error("Worker unsupported"));
    }
    return new Promise(function (resolve, reject) {
      try {
        worker = new Worker("js/engine/handWorker.js");
      } catch (err) {
        reject(err);
        return;
      }

      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { worker.terminate(); } catch (e) {}
        worker = null;
        reject(new Error("Worker init timeout"));
      }, 45000);

      worker.onmessage = function (ev) {
        var msg = ev.data || {};
        if (msg.type === "ready") {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          useWorker = true;
          workerReady = true;
          stats.backend = "worker/" + ((msg.info && msg.info.delegate) || "GPU");
          worker.onmessage = onWorkerMessage;
          console.log("MediaPipe HandLandmarker ready (" + stats.backend + ").");
          resolve();
          return;
        }
        if (msg.type === "error" && !workerReady) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(msg.error || "Worker init failed"));
        }
      };

      worker.onerror = function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err && err.message ? err : new Error("Worker error"));
      };

      worker.postMessage({ type: "init", preferGpu: true });
    });
  }

  function onWorkerMessage(ev) {
    var msg = ev.data || {};
    if (msg.type === "result") {
      stats.inferMs = msg.inferMs || 0;
      inferFrameCount++;
      acceptResult(msg, msg.landmarks, msg.handednesses);
      inferenceBusy = false;
      return;
    }
    if (msg.type === "error") {
      console.error("Hand worker detect error:", msg.error);
      inferenceBusy = false;
    }
  }

  function initMainThreadLandmarker() {
    return import(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/+esm"
    ).then(async function (visionModule) {
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
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      };

      try {
        landmarker = await HandLandmarker.createFromOptions(vision, opts);
        stats.backend = "main/GPU";
      } catch (gpuErr) {
        console.warn("GPU delegate failed, falling back to CPU:", gpuErr);
        opts.baseOptions.delegate = "CPU";
        landmarker = await HandLandmarker.createFromOptions(vision, opts);
        stats.backend = "main/CPU";
      }

      console.log("MediaPipe HandLandmarker ready (" + stats.backend + ").");
    });
  }

  function ensureInferCanvas(srcW, srcH) {
    if (!inferCanvas) {
      inferCanvas = document.createElement("canvas");
      inferCtx = inferCanvas.getContext("2d", { willReadFrequently: false, alpha: false });
    }
    var scale = Math.min(1, INFER_MAX_W / Math.max(srcW, 1));
    var w = Math.max(2, Math.round(srcW * scale));
    var h = Math.max(2, Math.round(srcH * scale));
    if (w % 2) w -= 1;
    if (h % 2) h -= 1;
    if (inferCanvas.width !== w || inferCanvas.height !== h) {
      inferCanvas.width = w;
      inferCanvas.height = h;
    }
    return inferCanvas;
  }

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

  self.setClassifier = function (fn) { classifier = fn || null; };
  self.hasClassifier = function () { return !!classifier; };
  self.getState = function () { return state; };

  self.setDrawLandmarks = function (on) {
    drawLandmarksEnabled = !!on;
    if (!drawLandmarksEnabled) clearCanvas();
  };

  self.setMirror = function (on) { mirror = !!on; };
  self.getDrawLandmarks = function () { return drawLandmarksEnabled; };
  self.setShowHud = function (on) {
    showHud = !!on;
    var el = document.getElementById("trackHud");
    if (el && !showHud) el.hidden = true;
  };
  self.getPerfStats = function () { return Object.assign({}, stats); };
  self.getTrackSnapshot = function () {
    return {
      hands: stats.hands,
      quality: stats.quality,
      trackState: stats.trackState,
      frameAgeMs: stats.frameAgeMs,
      left: slots.left.state,
      right: slots.right.state,
    };
  };

  // ----------------------------------------------------------
  // Start / stop
  // ----------------------------------------------------------

  self.start = function (opts) {
    opts = opts || {};
    if (state === "starting" || state === "on") return Promise.resolve(self);

    state = "starting";
    videoEl = opts.videoEl;
    canvasEl = opts.canvasEl;
    mirror = opts.mirror !== false;
    drawLandmarksEnabled = opts.drawLandmarks !== false;
    if (opts.showHud != null) showHud = !!opts.showHud;

    if (!videoEl || !canvasEl) {
      state = "error";
      return Promise.reject(new Error("Video/canvas elements missing"));
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      state = "error";
      return Promise.reject(new Error("Camera not available. Use HTTPS or localhost."));
    }

    var loadPromise = (workerReady || landmarker) ? Promise.resolve() : loadLandmarker();

    return loadPromise
      .then(function () {
        return navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30, max: 60 },
          },
          audio: false,
        });
      })
      .then(function (camStream) {
        stream = camStream;
        console.log("Camera settings:", stream.getVideoTracks()[0].getSettings());
        videoEl.srcObject = stream;
        return new Promise(function (resolve) {
          if (videoEl.readyState >= 1 && videoEl.videoWidth > 0) resolve();
          else videoEl.onloadedmetadata = resolve;
        });
      })
      .then(function () { return videoEl.play(); })
      .then(function () {
        syncCanvasSize();
        resetTrackingState();
        running = true;
        state = "on";
        lastStatsTick = performance.now();
        startInferenceLoop();
        startRenderLoop();
        console.log("Live engine started (lifecycle + stale discard).");
        return self;
      })
      .catch(function (err) {
        console.error("LiveEngine start error:", err);
        state = "error";
        running = false;
        teardownStream();
        throw err;
      });
  };

  self.stop = function () {
    running = false;
    inferenceBusy = false;
    stopInferenceLoop();
    stopRenderLoop();
    teardownStream();
    clearCanvas();
    resetTrackingState();
    var hud = document.getElementById("trackHud");
    if (hud) hud.hidden = true;
    var q = document.getElementById("trackQuality");
    if (q) { q.hidden = true; q.textContent = ""; }
    state = "off";
    emitTrackStatus(true);
    console.log("Camera stopped.");
  };

  function teardownStream() {
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
    if (videoEl) videoEl.srcObject = null;
  }

  function resetTrackingState() {
    slots.left = makeSlot();
    slots.right = makeSlot();
    leftFilter.reset();
    rightFilter.reset();
    prevPairTMs = 0;
    latestAcceptedId = 0;
    latestAcceptedMediaMs = -1;
    stats.dropped = 0;
    stats.stale = 0;
    stats.hands = 0;
    stats.quality = "idle";
    stats.trackState = "lost";
    lastTrackEmit = "";
    lastHandsEmit = -1;
  }

  // ----------------------------------------------------------
  // Inference loop
  // ----------------------------------------------------------

  function startInferenceLoop() {
    if (useRvfc) rvfcHandle = videoEl.requestVideoFrameCallback(onVideoFrame);
    else renderKickInfer();
  }

  function stopInferenceLoop() {
    if (rvfcHandle != null && videoEl && videoEl.cancelVideoFrameCallback) {
      try { videoEl.cancelVideoFrameCallback(rvfcHandle); } catch (e) {}
    }
    rvfcHandle = null;
  }

  function renderKickInfer() {
    if (!running) return;
    if (!inferenceBusy) runInference(performance.now(), null);
    requestAnimationFrame(renderKickInfer);
  }

  function onVideoFrame(now, metadata) {
    if (!running) return;
    camFrameCount++;

    if (inferenceBusy) {
      stats.dropped++;
    } else {
      var mediaMs = metadata && metadata.mediaTime != null
        ? metadata.mediaTime * 1000
        : now;
      runInference(now, mediaMs);
    }

    if (running && useRvfc) {
      rvfcHandle = videoEl.requestVideoFrameCallback(onVideoFrame);
    }
  }

  function runInference(now, mediaMs) {
    if (
      (!workerReady && !landmarker) ||
      !videoEl ||
      videoEl.readyState < 2 ||
      !videoEl.videoWidth
    ) {
      return;
    }

    inferenceBusy = true;
    var t0 = performance.now();
    var srcW = videoEl.videoWidth;
    var srcH = videoEl.videoHeight;
    var canvas = ensureInferCanvas(srcW, srcH);
    var targetW = canvas.width;
    var targetH = canvas.height;

    var ts = mediaMs != null ? mediaMs : performance.now();
    if (ts <= lastMediaTimestampMs) ts = lastMediaTimestampMs + 1;
    lastMediaTimestampMs = ts;

    var bitmapPromise = typeof createImageBitmap === "function"
      ? createImageBitmap(videoEl, {
          resizeWidth: targetW,
          resizeHeight: targetH,
          resizeQuality: "low",
        })
      : (inferCtx.drawImage(videoEl, 0, 0, targetW, targetH), Promise.resolve(canvas));

    bitmapPromise
      .then(function (input) {
        if (!running) {
          if (input && input.close) input.close();
          inferenceBusy = false;
          return;
        }

        detectId += 1;
        var id = detectId;

        if (useWorker && workerReady && worker && input && input.close) {
          worker.postMessage(
            {
              type: "detect",
              id: id,
              bitmap: input,
              timestamp: ts,
              wallSentMs: t0,
            },
            [input]
          );
          return;
        }

        if (!landmarker) {
          if (input && input.close) input.close();
          inferenceBusy = false;
          return;
        }

        var results = landmarker.detectForVideo(input, ts);
        if (input && input.close) input.close();
        stats.inferMs = performance.now() - t0;
        inferFrameCount++;
        acceptResult(
          { id: id, timestamp: ts, wallSentMs: t0, mediaMs: ts, inferMs: stats.inferMs },
          results.landmarks,
          results.handednesses || results.handedness
        );
        inferenceBusy = false;
      })
      .catch(function (err) {
        console.error("MediaPipe detection error:", err);
        inferenceBusy = false;
      });
  }

  // ----------------------------------------------------------
  // Accept / reject results + hand slots
  // ----------------------------------------------------------

  function acceptResult(meta, landmarks, handednesses) {
    var now = performance.now();
    var id = meta.id || 0;
    var mediaMs = meta.mediaMs != null ? meta.mediaMs : meta.timestamp;
    var captureMs = meta.wallSentMs != null ? meta.wallSentMs : now;
    var age = now - captureMs;

    /* Out-of-order: never apply an older pose after a newer one */
    var outOfOrder = id < latestAcceptedId ||
      (mediaMs != null && latestAcceptedMediaMs >= 0 && mediaMs < latestAcceptedMediaMs);

    if (outOfOrder) {
      stats.stale++;
      return;
    }

    if (age > MAX_RESULT_AGE_MS) stats.stale++;

    latestAcceptedId = Math.max(latestAcceptedId, id);
    if (mediaMs != null) latestAcceptedMediaMs = mediaMs;

    var parsed = parseHands(landmarks || [], handednesses || []);
    var left = parsed.left;
    var right = parsed.right;
    var leftConf = parsed.leftConf;
    var rightConf = parsed.rightConf;

    /* Presence: only refresh lastSeen when this hand is in the result.
       Misses leave lastSeen aging → render loop kills ghosts in ~75ms
       even if the next inference takes much longer. */
    touchSlot("left", left, leftConf, now, captureMs, mediaMs);
    touchSlot("right", right, rightConf, now, captureMs, mediaMs);

    var detected = (left ? 1 : 0) + (right ? 1 : 0);
    stats.hands = detected;
    if (detected !== lastHandsEmit && SB.Engine && SB.Engine._hands) {
      lastHandsEmit = detected;
      SB.Engine._hands(detected);
    }

    if (classifier) {
      var classifierHand = (right && right.lms) || (left && left.lms);
      if (classifierHand) {
        var features = landmarkVector(classifierHand);
        var token = null;
        try { token = classifier(features); } catch (err) {
          console.error("Classifier error:", err);
        }
        if (token) {
          token.source = "live";
          if (SB.Engine && SB.Engine._result) SB.Engine._result(token);
        }
      }
    }

    stats.frameAgeMs = age;
  }

  function touchSlot(side, hand, conf, now, captureMs, mediaMs) {
    var slot = slots[side];
    var filter = side === "left" ? leftFilter : rightFilter;
    var buf = side === "left" ? leftUiBuf : rightUiBuf;

    if (hand && hand.lms) {
      slot.lastSeenMs = now;
      slot.conf = conf;
      slot.label = hand.label || (side === "left" ? "L" : "R");
      slot.state = conf >= 0.5 ? "tracking" : "uncertain";
      slot.captureMs = captureMs;
      slot.mediaMs = mediaMs;
      if (slot.rawAtMs) slot.rawDtMs = Math.max(8, now - slot.rawAtMs);
      slot.prevRaw = slot.raw;
      slot.raw = hand.lms;
      slot.rawAtMs = now;
      slot.ui = filter.apply(now / 1000, hand.lms, buf);
      prevPairTMs = now;
      return;
    }

    /* Missed this hand in the result — do NOT refresh lastSeen.
       Render loop will move tracking → uncertain → lost. */
  }

  function parseHands(lms, handed) {
    var left = null;
    var right = null;
    var leftConf = 0;
    var rightConf = 0;

    for (var i = 0; i < lms.length; i++) {
      var info = handednessInfo(handed[i]);
      var pts = cloneLandmarks(lms[i]);
      var pack = { lms: pts, label: info.label === "Left" ? "L" : info.label === "Right" ? "R" : "" };

      if (info.label === "Left") {
        if (!left) { left = pack; leftConf = info.score; }
        else if (!right) { right = pack; rightConf = info.score; }
      } else if (info.label === "Right") {
        if (!right) { right = pack; rightConf = info.score; }
        else if (!left) { left = pack; leftConf = info.score; }
      } else {
        var slotName = associateHand(pts);
        if (slotName === "left" && !left) { left = pack; leftConf = info.score || 0.5; }
        else if (slotName === "right" && !right) { right = pack; rightConf = info.score || 0.5; }
        else if (!left) { left = pack; leftConf = info.score || 0.5; }
        else if (!right) { right = pack; rightConf = info.score || 0.5; }
      }
    }

    var pair = resolveIdentity(
      left && left.lms,
      right && right.lms
    );
    if (pair.swapped) {
      var tmp = left; left = right; right = tmp;
      var tc = leftConf; leftConf = rightConf; rightConf = tc;
    }

    return { left: left, right: right, leftConf: leftConf, rightConf: rightConf };
  }

  function handednessInfo(entry) {
    if (!entry) return { label: "", score: 0 };
    var cat = Array.isArray(entry) ? entry[0] : entry;
    if (!cat) return { label: "", score: 0 };
    return {
      label: cat.categoryName || cat.displayName || "",
      score: typeof cat.score === "number" ? cat.score : 0.8,
    };
  }

  function cloneLandmarks(src) {
    var out = new Array(src.length);
    for (var i = 0; i < src.length; i++) {
      out[i] = { x: src[i].x, y: src[i].y, z: src[i].z || 0 };
    }
    return out;
  }

  function wristDist(a, b) {
    if (!a || !b || !a[0] || !b[0]) return Infinity;
    var dx = a[0].x - b[0].x;
    var dy = a[0].y - b[0].y;
    return dx * dx + dy * dy;
  }

  function associateHand(pts) {
    var dL = wristDist(pts, slots.left.raw);
    var dR = wristDist(pts, slots.right.raw);
    if (dL === Infinity && dR === Infinity) return "left";
    return dL <= dR ? "left" : "right";
  }

  function resolveIdentity(left, right) {
    if (!left || !right || !slots.left.raw || !slots.right.raw) {
      return { left: left, right: right, swapped: false };
    }
    var keep = wristDist(left, slots.left.raw) + wristDist(right, slots.right.raw);
    var swap = wristDist(left, slots.right.raw) + wristDist(right, slots.left.raw);
    if (swap + 1e-6 < keep) return { left: right, right: left, swapped: true };
    return { left: left, right: right, swapped: false };
  }

  // ----------------------------------------------------------
  // Lifecycle expiry (ghost killer) — runs every render frame
  // ----------------------------------------------------------

  function expireSlots(now) {
    expireOne("left", now);
    expireOne("right", now);
  }

  function expireOne(side, now) {
    var slot = slots[side];
    if (!slot.lastSeenMs) {
      clearSlot(side);
      return;
    }
    var age = now - slot.lastSeenMs;
    if (age > LOST_MS) {
      clearSlot(side);
      return;
    }
    if (age > UNCERTAIN_MS) {
      slot.state = "uncertain";
      /* Fade out over FADE_MS after uncertain begins */
      var fadeT = (age - UNCERTAIN_MS) / Math.max(1, FADE_MS);
      slot.opacity = Math.max(0, 1 - fadeT) * confOpacity(slot.conf) * 0.75;
    } else {
      slot.state = slot.conf >= 0.5 ? "tracking" : "uncertain";
      slot.opacity = confOpacity(slot.conf);
    }
  }

  function clearSlot(side) {
    var slot = slots[side];
    if (slot.state === "lost" && !slot.raw) return;
    slot.state = "lost";
    slot.raw = null;
    slot.prevRaw = null;
    slot.ui = null;
    slot.conf = 0;
    slot.opacity = 0;
    slot.lastSeenMs = 0;
    if (side === "left") leftFilter.reset();
    else rightFilter.reset();
  }

  function confOpacity(conf) {
    if (conf >= 0.8) return 0.85;
    if (conf >= 0.5) return 0.55 + (conf - 0.5) * 1.0;
    return 0.4;
  }

  // ----------------------------------------------------------
  // Render loop
  // ----------------------------------------------------------

  function startRenderLoop() {
    stopRenderLoop();
    function tick(now) {
      if (!running) return;
      renderFrameCount++;
      expireSlots(now);
      paintOverlay(now);
      updateHud(now);
      updateQualityBadge();
      emitTrackStatus(false);
      renderRaf = requestAnimationFrame(tick);
    }
    renderRaf = requestAnimationFrame(tick);
  }

  function stopRenderLoop() {
    if (renderRaf != null) {
      cancelAnimationFrame(renderRaf);
      renderRaf = null;
    }
  }

  function predictHand(slot, outBuf) {
    var filtered = slot.ui;
    if (!filtered || slot.state === "lost") return null;
    var raw = slot.raw;
    var prev = slot.prevRaw;
    if (!raw || !prev) return filtered;

    var dtSec = Math.max(0.008, (slot.rawDtMs || 33) / 1000);
    var out = outBuf || [];
    for (var i = 0; i < filtered.length; i++) {
      if (!out[i]) out[i] = { x: 0, y: 0, z: 0 };
      if (!prev[i] || !raw[i]) {
        out[i].x = filtered[i].x;
        out[i].y = filtered[i].y;
        out[i].z = filtered[i].z;
        continue;
      }
      var vx = (raw[i].x - prev[i].x) / dtSec;
      var vy = (raw[i].y - prev[i].y) / dtSec;
      /* Tips get slightly more lead; wrist less */
      var lead = (i === 4 || i === 8 || i === 12 || i === 16 || i === 20)
        ? predictSec * 1.15
        : (i === 0 ? predictSec * 0.7 : predictSec);
      var dx = vx * lead;
      var dy = vy * lead;
      var mag = Math.sqrt(dx * dx + dy * dy);
      if (mag > maxPredictNorm) {
        var s = maxPredictNorm / mag;
        dx *= s;
        dy *= s;
      }
      out[i].x = filtered[i].x + dx;
      out[i].y = filtered[i].y + dy;
      out[i].z = filtered[i].z;
    }
    out.length = filtered.length;
    return out;
  }

  function paintOverlay(now) {
    if (!canvasEl || !videoEl) return;
    if (!drawLandmarksEnabled) {
      clearCanvas();
      return;
    }

    syncCanvasSize();
    var ctx = canvasEl.getContext("2d");
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

    /* Frame age of the freshest displayed hand capture */
    var cap = 0;
    if (slots.left.state !== "lost" && slots.left.captureMs) cap = Math.max(cap, slots.left.captureMs);
    if (slots.right.state !== "lost" && slots.right.captureMs) cap = Math.max(cap, slots.right.captureMs);
    stats.frameAgeMs = cap ? Math.max(0, now - cap) : stats.frameAgeMs;

    if (slots.left.state !== "lost" && slots.left.opacity > 0.02) {
      var l = predictHand(slots.left, leftPredBuf);
      if (l) drawHand(ctx, l, showHandLabels ? "L" : "", slots.left.opacity);
    }
    if (slots.right.state !== "lost" && slots.right.opacity > 0.02) {
      var r = predictHand(slots.right, rightPredBuf);
      if (r) drawHand(ctx, r, showHandLabels ? "R" : "", slots.right.opacity);
    }
  }

  function drawHand(ctx, landmarks, label, opacity) {
    var w = canvasEl.width;
    var h = canvasEl.height;
    var n = landmarks.length;
    var a = opacity == null ? 0.85 : opacity;

    while (drawPtsBuf.length < n) drawPtsBuf.push({ x: 0, y: 0 });
    for (var i = 0; i < n; i++) {
      var x = landmarks[i].x * w;
      var y = landmarks[i].y * h;
      /* Mirror is a display transform only — model handedness stays semantic */
      if (mirror) x = w - x;
      drawPtsBuf[i].x = x;
      drawPtsBuf[i].y = y;
    }

    ctx.lineWidth = 1.5;
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(52, 224, 192, " + (0.38 * a) + ")";

    for (var c = 0; c < HAND_CONNECTIONS.length; c++) {
      var i0 = HAND_CONNECTIONS[c][0];
      var i1 = HAND_CONNECTIONS[c][1];
      var p0 = drawPtsBuf[i0];
      var p1 = drawPtsBuf[i1];
      if (!p0 || !p1) continue;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }

    for (var j = 0; j < n; j++) {
      var pt = drawPtsBuf[j];
      var rad = j === 0 ? 4 : 2.5;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, rad, 0, Math.PI * 2);
      ctx.fillStyle = j === 0
        ? "rgba(255,180,84," + (0.9 * a) + ")"
        : "rgba(139,140,255," + (0.75 * a) + ")";
      ctx.fill();
    }

    if (label && landmarks[0]) {
      ctx.font = "600 10px Inter, system-ui, sans-serif";
      ctx.globalAlpha = a;
      ctx.fillStyle = "rgba(232,238,252,.88)";
      ctx.strokeStyle = "rgba(6,10,20,.55)";
      ctx.lineWidth = 2.5;
      var tx = drawPtsBuf[0].x + (mirror ? -12 : 7);
      var ty = drawPtsBuf[0].y - 9;
      ctx.strokeText(label, tx, ty);
      ctx.fillText(label, tx, ty);
      ctx.globalAlpha = 1;
    }
  }

  function syncCanvasSize() {
    if (!canvasEl || !videoEl) return;
    var w = videoEl.clientWidth || videoEl.videoWidth || 640;
    var h = videoEl.clientHeight || videoEl.videoHeight || 480;
    if (canvasEl.width !== w || canvasEl.height !== h) {
      canvasEl.width = w;
      canvasEl.height = h;
    }
  }

  function clearCanvas() {
    if (!canvasEl) return;
    canvasEl.getContext("2d").clearRect(0, 0, canvasEl.width, canvasEl.height);
  }

  // ----------------------------------------------------------
  // HUD + quality badge + status events
  // ----------------------------------------------------------

  function computeQuality() {
    var n = (slots.left.state !== "lost" ? 1 : 0) + (slots.right.state !== "lost" ? 1 : 0);
    var anyUncertain = slots.left.state === "uncertain" || slots.right.state === "uncertain";
    var age = stats.frameAgeMs;
    if (n === 0) return { quality: "searching", trackState: "lost", hands: 0 };
    if (anyUncertain || age > 80) return { quality: "fair", trackState: "uncertain", hands: n };
    if (age > 60) return { quality: "good", trackState: "tracking", hands: n };
    return { quality: "excellent", trackState: "tracking", hands: n };
  }

  function updateHud(now) {
    if (now - lastStatsTick >= 500) {
      var dt = (now - lastStatsTick) / 1000;
      stats.camFps = camFrameCount / dt;
      stats.inferFps = inferFrameCount / dt;
      stats.renderFps = renderFrameCount / dt;
      camFrameCount = 0;
      inferFrameCount = 0;
      renderFrameCount = 0;
      lastStatsTick = now;
    }

    var q = computeQuality();
    stats.quality = q.quality;
    stats.trackState = q.trackState;
    stats.hands = q.hands;

    if (!showHud) return;
    var el = document.getElementById("trackHud");
    if (!el) return;
    el.hidden = false;
    el.textContent =
      "Cam " + stats.camFps.toFixed(0) +
      " · Infer " + stats.inferFps.toFixed(0) +
      " (" + stats.inferMs.toFixed(0) + "ms)" +
      " · Draw " + stats.renderFps.toFixed(0) +
      " · Age " + stats.frameAgeMs.toFixed(0) + "ms" +
      " · Drop " + stats.dropped +
      " · Stale " + stats.stale +
      " · Hands " + stats.hands +
      " · " + stats.backend;
  }

  function updateQualityBadge() {
    var el = document.getElementById("trackQuality");
    if (!el || state !== "on") return;
    el.hidden = false;
    var q = stats.quality;
    var label =
      q === "excellent" ? "Tracking: Excellent" :
      q === "good" ? "Tracking: Good" :
      q === "fair" ? "Tracking: Fair" :
      stats.hands > 0 ? "Tracking…" :
      "Looking for hands";
    el.textContent = label;
    el.dataset.quality = q;
  }

  function emitTrackStatus(force) {
    if (!SB.Engine || !SB.Engine._track) return;
    var hint = "";
    if (stats.trackState === "lost") hint = "Keep your hands inside the frame";
    else if (stats.frameAgeMs > 100) hint = "Move slightly slower";
    else if (stats.trackState === "uncertain") hint = "Reacquiring hand…";

    var payload = {
      hands: stats.hands,
      quality: stats.quality,
      trackState: stats.trackState,
      frameAgeMs: stats.frameAgeMs,
      hint: hint,
      hasClassifier: !!classifier,
    };
    var key = payload.hands + "|" + payload.quality + "|" + payload.trackState + "|" + payload.hint;
    if (!force && key === lastTrackEmit) return;
    lastTrackEmit = key;
    SB.Engine._track(payload);
  }

  // ----------------------------------------------------------
  // Features for classifier
  // ----------------------------------------------------------

  function landmarkVector(landmarks) {
    var wrist = landmarks[0];
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    var i;
    for (i = 0; i < landmarks.length; i++) {
      if (landmarks[i].x < minX) minX = landmarks[i].x;
      if (landmarks[i].x > maxX) maxX = landmarks[i].x;
      if (landmarks[i].y < minY) minY = landmarks[i].y;
      if (landmarks[i].y > maxY) maxY = landmarks[i].y;
    }
    var span = Math.max(maxX - minX, maxY - minY, 1e-6);
    var features = new Float32Array(63);
    for (i = 0; i < 21; i++) {
      features[i * 3] = (landmarks[i].x - minX) / span;
      features[i * 3 + 1] = (landmarks[i].y - minY) / span;
      features[i * 3 + 2] = (landmarks[i].z - wrist.z) / span;
    }
    return features;
  }
};
