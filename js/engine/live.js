/* ============================================================
   SignBridge — Live MediaPipe Engine (live.js)
   ------------------------------------------------------------
   Real-time pipeline (freshness > processing every frame):

     Camera (display) ──────────────► <video>
           │
           ▼ (downscale branch)
     Inference canvas ≤640px
           │
           ▼ requestVideoFrameCallback + busy gate
     HolisticLandmarker in Web Worker (same model as dev/stan)
           │
           ├── left/right hand landmarks ──► classifier / recognition
           ├── pose landmarks ──► LSTM frame normalizer
           │
           └── UI buffer ──► One Euro + short prediction
                              └── requestAnimationFrame overlay

   Never queue inference. If the model is busy, drop the frame.
   ============================================================ */



window.SB = window.SB || {};



SB.LiveEngine = function () {

  var self = this;

  var state = "off";
  var classifier = null;

  var landmarker = null;   /* main-thread fallback only (HolisticLandmarker) */
  var worker = null;
  var workerReady = false;
  var useWorker = false;
  var detectId = 0;
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
  /* Dev overlay (Cam/Infer/Age…) — off by default; enable with ?debugTrack=1 */
  var showHud = false;
  try {
    showHud = !!(typeof location !== "undefined" &&
      /(?:^|[?&])debugTrack=1(?:&|$)/.test(location.search || ""));
  } catch (e) {}

  /* Latest measured hands (recognition) + UI hands (filtered/predicted) */
  var rawHands = { left: null, right: null, tMs: 0, mediaMs: 0 };
  var uiHands = { left: null, right: null };
  var prevRaw = { left: null, right: null, tMs: 0 };

  var leftFilter = new SB.HandLandmarkFilter({ minCutoff: 1.4, beta: 0.6 });
  var rightFilter = new SB.HandLandmarkFilter({ minCutoff: 1.4, beta: 0.6 });
  var leftUiBuf = [];
  var rightUiBuf = [];
  var leftPredBuf = [];
  var rightPredBuf = [];
  var drawPtsBuf = [];

  /* Latency compensation for overlay only (seconds of extrapolation). */
  var predictSec = 0.035;
  var maxPredictNorm = 0.08;

  /* dev/stan ran Holistic on the full camera frame. The LSTM was trained on
     those landmarks, so inference is not downscaled below the 1280px camera. */
  var INFER_MAX_W = 1280;

  /* Perf / HUD */
  var stats = {
    camFps: 0,
    inferFps: 0,
    renderFps: 0,
    inferMs: 0,
    frameAgeMs: 0,
    dropped: 0,
    hands: 0,
    backend: "—",
  };
  var camFrameCount = 0;
  var inferFrameCount = 0;
  var renderFrameCount = 0;
  var lastStatsTick = 0;
  var lastInferEndMs = 0;
  var lastMediaTimestampMs = 0;

  var HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20],
    [0, 17],
  ];

  // ----------------------------------------------------------
  // Load HolisticLandmarker — prefer Web Worker, fall back to main
  // ----------------------------------------------------------

  function loadLandmarker() {
    console.log("Loading MediaPipe HolisticLandmarker…");
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
        /* Classic worker: MediaPipe WASM uses importScripts (blocked in module workers). */
        worker = new Worker(((window.SB && SB.root) || "") + "js/engine/handWorker.js");
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
      }, 60000);

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
          if (msg.info && msg.info.fallback) {
            console.warn("Holistic GPU delegate failed, using CPU:", msg.info.fallback);
          }
          console.log("MediaPipe HolisticLandmarker ready (" + stats.backend + ").");
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
      lastInferEndMs = performance.now();
      inferFrameCount++;
      try {
        ingestResults(
          {
            leftHandLandmarks: msg.leftHandLandmarks,
            rightHandLandmarks: msg.rightHandLandmarks,
            poseLandmarks: msg.poseLandmarks,
          },
          lastInferEndMs,
          msg.mediaMs
        );
      } catch (err) {
        console.error("ingestResults error:", err);
      } finally {
        /* Always clear, even if ingest throws: a stranded busy gate drops
           every later frame and inference never runs again. */
        inferenceBusy = false;
      }
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
      var HolisticLandmarker = visionModule.HolisticLandmarker;

      var vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm"
      );

      var opts = {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/" +
            "holistic_landmarker/holistic_landmarker/float16/1/" +
            "holistic_landmarker.task",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
      };

      try {
        landmarker = await HolisticLandmarker.createFromOptions(vision, opts);
        stats.backend = "main/GPU";
      } catch (gpuErr) {
        console.warn("GPU delegate failed, falling back to CPU:", gpuErr);
        opts.baseOptions.delegate = "CPU";
        landmarker = await HolisticLandmarker.createFromOptions(vision, opts);
        stats.backend = "main/CPU";
      }

      console.log("MediaPipe HolisticLandmarker ready (" + stats.backend + ").");
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
    /* Keep even dims — friendlier for some backends */
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

  self.setClassifier = function (fn) {
    classifier = fn || null;
  };

  self.hasClassifier = function () {
    return !!classifier;
  };

  self.getState = function () {
    return state;
  };

  self.setDrawLandmarks = function (on) {
    drawLandmarksEnabled = !!on;
    if (!drawLandmarksEnabled) clearCanvas();
  };

  self.setMirror = function (on) {
    mirror = !!on;
  };

  self.getDrawLandmarks = function () {
    return drawLandmarksEnabled;
  };

  self.setShowHud = function (on) {
    showHud = !!on;
    var el = document.getElementById("trackHud");
    if (el && !showHud) el.hidden = true;
  };

  self.getPerfStats = function () {
    return Object.assign({}, stats);
  };

  // ----------------------------------------------------------
  // Start / stop
  // ----------------------------------------------------------

  self.start = function (opts) {

    opts = opts || {};

    if (state === "starting" || state === "on") {
      return Promise.resolve(self);
    }

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
        return navigator.mediaDevices.getUserMedia(
          window.SB && SB.Device && SB.Device.isMobile
            ? SB.Device.cameraConstraints()
            : {
                video: {
                  width: { ideal: 1280 },
                  height: { ideal: 720 },
                  frameRate: { ideal: 30, max: 60 },
                },
                audio: false,
              }
        );
      })
      .then(function (camStream) {
        stream = camStream;
        var track = stream.getVideoTracks()[0];
        console.log("Camera settings:", track.getSettings());
        videoEl.srcObject = stream;
        return new Promise(function (resolve) {
          if (videoEl.readyState >= 1 && videoEl.videoWidth > 0) resolve();
          else videoEl.onloadedmetadata = resolve;
        });
      })
      .then(function () {
        return videoEl.play();
      })
      .then(function () {
        syncCanvasSize();
        resetTrackingState();
        running = true;
        state = "on";
        lastStatsTick = performance.now();
        startInferenceLoop();
        startRenderLoop();
        console.log("Live engine started (HolisticLandmarker, latest-frame pipeline).");
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
    state = "off";
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
    rawHands.left = rawHands.right = null;
    rawHands.tMs = 0;
    uiHands.left = uiHands.right = null;
    prevRaw.left = prevRaw.right = null;
    prevRaw.tMs = 0;
    leftFilter.reset();
    rightFilter.reset();
    stats.dropped = 0;
  }

  // ----------------------------------------------------------
  // Inference loop — RVFC, never queue stale work
  // ----------------------------------------------------------

  function startInferenceLoop() {
    if (useRvfc) {
      rvfcHandle = videoEl.requestVideoFrameCallback(onVideoFrame);
    } else {
      /* Fallback: rAF with busy gate (still drops while inferring). */
      renderKickInfer();
    }
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
      /* Model still working — discard this camera frame. Freshness > completeness. */
      stats.dropped++;
    } else {
      var mediaMs = metadata && metadata.mediaTime != null
        ? metadata.mediaTime * 1000
        : now;
      /* Fire-and-forget: re-register RVFC immediately so later frames can be dropped
         while this one is still in flight (async bitmap + sync detect). */
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

    var bitmapPromise;
    if (typeof createImageBitmap === "function") {
      bitmapPromise = createImageBitmap(videoEl, {
        resizeWidth: targetW,
        resizeHeight: targetH,
        resizeQuality: "low",
      });
    } else {
      inferCtx.drawImage(videoEl, 0, 0, targetW, targetH);
      bitmapPromise = Promise.resolve(canvas);
    }

    bitmapPromise
      .then(function (input) {
        if (!running) {
          if (input && input.close) input.close();
          inferenceBusy = false;
          return;
        }

        if (useWorker && workerReady && worker && input && input.close) {
          /* Transfer bitmap to worker — UI thread stays free for rAF overlay. */
          detectId += 1;
          worker.postMessage(
            {
              type: "detect",
              id: detectId,
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
        lastInferEndMs = performance.now();
        inferFrameCount++;
        ingestResults(results, lastInferEndMs, ts);
        inferenceBusy = false;
      })
      .catch(function (err) {
        console.error("MediaPipe detection error:", err);
        inferenceBusy = false;
      });
  }

  // ----------------------------------------------------------
  // Results → left/right + pose + recognition (raw only)
  // ----------------------------------------------------------

  function ingestResults(results, wallMs, mediaMs) {
    /* Holistic already labels hands anatomically, exactly as dev/stan
       consumed them. No handedness guessing or swap repair here: the
       LSTM training frames came straight from these two arrays. */
    var left = firstGroup(results.leftHandLandmarks);
    var right = firstGroup(results.rightHandLandmarks);

    prevRaw.left = rawHands.left;
    prevRaw.right = rawHands.right;
    prevRaw.tMs = rawHands.tMs;

    rawHands.left = left;
    rawHands.right = right;
    rawHands.tMs = wallMs;
    rawHands.mediaMs = mediaMs;

    var handCount = (left ? 1 : 0) + (right ? 1 : 0);
    stats.hands = handCount;
    if (SB.Engine && SB.Engine._hands) SB.Engine._hands(handCount);

    /* Recognition uses measured landmarks only — never predicted UI coords */
    if (classifier) {
      var classifierHand = right || left;
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

    /* Update UI buffers immediately after measure (render loop will paint) */
    updateUiFromRaw(wallMs);
    // Forward every detected frame to training and LSTM consumers,
    // independently of the optional single-hand classifier.
    if (window.TrainingRecorder &&
        typeof window.TrainingRecorder.processFrame === "function") {
      try {
        window.TrainingRecorder.processFrame(results, left, right);
      } catch (err) {
        console.error("Training recorder error:", err);
      }
    }

    if (window.SignBridgeLiveTest &&
        typeof window.SignBridgeLiveTest.processFrame === "function") {
      try {
        window.SignBridgeLiveTest.processFrame(results, left, right);
      } catch (err) {
        console.error("LSTM live test error:", err);
      }
    }
  }

  /* Holistic returns each hand as an array of detections; take the first. */
  function firstGroup(list) {
    if (!list || !list.length || !list[0] || !list[0].length) return null;
    return cloneLandmarks(list[0]);
  }

  function cloneLandmarks(src) {
    var out = new Array(src.length);
    for (var i = 0; i < src.length; i++) {
      out[i] = { x: src[i].x, y: src[i].y, z: src[i].z || 0 };
    }
    return out;
  }

  function updateUiFromRaw(wallMs) {
    var tSec = wallMs / 1000;
    if (rawHands.left) {
      uiHands.left = leftFilter.apply(tSec, rawHands.left, leftUiBuf);
    } else {
      leftFilter.reset();
      uiHands.left = null;
    }
    if (rawHands.right) {
      uiHands.right = rightFilter.apply(tSec, rawHands.right, rightUiBuf);
    } else {
      rightFilter.reset();
      uiHands.right = null;
    }
  }

  // ----------------------------------------------------------
  // Render loop — independent of inference FPS
  // ----------------------------------------------------------

  function startRenderLoop() {
    stopRenderLoop();
    function tick(now) {
      if (!running) return;
      renderFrameCount++;
      paintOverlay(now);
      updateHud(now);
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

  function predictHand(filtered, raw, prev, dtSec, outBuf) {
    if (!filtered) return null;
    if (!raw || !prev || dtSec <= 1e-4) return filtered;
    var out = outBuf || [];
    var lead = predictSec;
    for (var i = 0; i < filtered.length; i++) {
      if (!out[i]) out[i] = { x: 0, y: 0, z: 0 };
      var vx = (raw[i].x - prev[i].x) / dtSec;
      var vy = (raw[i].y - prev[i].y) / dtSec;
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

    var age = rawHands.tMs ? Math.max(0, now - rawHands.tMs) : 0;
    stats.frameAgeMs = age;

    var dtSec = prevRaw.tMs ? (rawHands.tMs - prevRaw.tMs) / 1000 : 0;

    var leftDraw = predictHand(
      uiHands.left, rawHands.left, prevRaw.left, dtSec, leftPredBuf
    );
    var rightDraw = predictHand(
      uiHands.right, rawHands.right, prevRaw.right, dtSec, rightPredBuf
    );

    if (leftDraw) drawHand(ctx, leftDraw, "L");
    if (rightDraw) drawHand(ctx, rightDraw, "R");
  }

  function drawHand(ctx, landmarks, label) {
    var w = canvasEl.width;
    var h = canvasEl.height;
    var n = landmarks.length;

    while (drawPtsBuf.length < n) drawPtsBuf.push({ x: 0, y: 0 });
    for (var i = 0; i < n; i++) {
      var x = landmarks[i].x * w;
      var y = landmarks[i].y * h;
      if (mirror) x = w - x;
      drawPtsBuf[i].x = x;
      drawPtsBuf[i].y = y;
    }

    ctx.lineWidth = 1.75;
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(52, 224, 192, .42)";

    for (var c = 0; c < HAND_CONNECTIONS.length; c++) {
      var a = HAND_CONNECTIONS[c][0];
      var b = HAND_CONNECTIONS[c][1];
      var p0 = drawPtsBuf[a];
      var p1 = drawPtsBuf[b];
      if (!p0 || !p1) continue;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }

    for (var j = 0; j < n; j++) {
      var pt = drawPtsBuf[j];
      var r = j === 0 ? 4.5 : 2.75;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.fillStyle = j === 0 ? "rgba(255,180,84,.95)" : "rgba(139,140,255,.85)";
      ctx.fill();
    }

    if (label && landmarks[0]) {
      var wx = drawPtsBuf[0].x;
      var wy = drawPtsBuf[0].y;
      ctx.font = "600 11px Inter, system-ui, sans-serif";
      ctx.fillStyle = "rgba(232,238,252,.9)";
      ctx.strokeStyle = "rgba(6,10,20,.65)";
      ctx.lineWidth = 3;
      var tx = wx + (mirror ? -14 : 8);
      var ty = wy - 10;
      ctx.strokeText(label, tx, ty);
      ctx.fillText(label, tx, ty);
    }

    /* Red ring while saving training frames — visible feedback only */

    if (SB.DataCapture && typeof SB.DataCapture.isRecording === "function" && SB.DataCapture.isRecording()) {

      ctx.strokeStyle = "rgba(255, 90, 90, .85)";

      ctx.lineWidth = 4;

      ctx.strokeRect(8, 8, canvasEl.width - 16, canvasEl.height - 16);

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
    var ctx = canvasEl.getContext("2d");
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  }

  // ----------------------------------------------------------
  // HUD
  // ----------------------------------------------------------

  function updateHud(now) {
    var statsTick = false;
    if (now - lastStatsTick >= 500) {
      var dt = (now - lastStatsTick) / 1000;
      stats.camFps = camFrameCount / dt;
      stats.inferFps = inferFrameCount / dt;
      stats.renderFps = renderFrameCount / dt;
      camFrameCount = 0;
      inferFrameCount = 0;
      renderFrameCount = 0;
      lastStatsTick = now;
      statsTick = true;
    }

    var el = document.getElementById("trackHud");
    if (!el) return;
    if (!showHud) {
      if (!el.hidden) {
        el.hidden = true;
        el.textContent = "";
        el.setAttribute("aria-hidden", "true");
      }
      return;
    }
    /* Only rewrite DOM on the stats tick — Age was flickering every frame */
    if (!statsTick && el.dataset.armed === "1") return;
    el.dataset.armed = "1";
    el.hidden = false;
    el.setAttribute("aria-hidden", "false");
    el.textContent =
      "Cam " + stats.camFps.toFixed(0) +
      " · Infer " + stats.inferFps.toFixed(0) +
      " (" + stats.inferMs.toFixed(0) + "ms)" +
      " · Draw " + stats.renderFps.toFixed(0) +
      " · Age " + stats.frameAgeMs.toFixed(0) + "ms" +
      " · Drop " + stats.dropped +
      " · Hands " + stats.hands +
      " · " + stats.backend;
  }

  // ----------------------------------------------------------
  // Features for classifier (unchanged contract)
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
