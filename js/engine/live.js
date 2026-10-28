/* ============================================================
   SignBridge — Live MediaPipe Engine (live.js)
   ------------------------------------------------------------
   Real-time pipeline (freshness > processing every frame):

     Camera (display) ──────────────► <video>
           │
           ▼ (adaptive downscale ≤560/480/360)
     Inference canvas (overlay stays full-res)
           │
           ▼ requestVideoFrameCallback + busy gate + watchdog
     HandLandmarker in Web Worker (default; Holistic if ?holistic=1
     or while training records — pose needed for LSTM)
           │
           ├── left/right hand landmarks ──► UI (always) + classify (½)
           ├── pose (Holistic only) ──► LSTM (½ rate)
           │
           └── adaptive One Euro + age-based prediction
                              └── requestAnimationFrame overlay

   Never queue inference. Draw loop never waits on infer.
   Stability: hand identity matching, jump/bone gates, stale-frame discard.
   Dev HUD: ?perf=1 · debug raw/gated: ?debugTrack=1 (or settings.perfHud).
   ============================================================ */



window.SB = window.SB || {};



SB.LiveEngine = function () {

  var self = this;

  var state = "off";
  var classifier = null;

  var landmarker = null;   /* main-thread fallback only */
  var worker = null;
  var workerReady = false;
  var useWorker = false;
  var detectId = 0;
  var lastAcceptedDetectId = 0;
  var stream = null;
  var preferGpu = true;
  var forceCpu = false;
  var forceHolistic = false;
  var modelKind = "hands"; /* "hands" | "holistic" */
  var heavyFrame = 0;      /* odd frames skip classify/LSTM */
  var showDebugTrack = false;

  var videoEl = null;
  var canvasEl = null;
  var overlayCtx = null;
  var inferCanvas = null;
  var inferCtx = null;

  var running = false;
  var inferenceBusy = false;
  var busySinceMs = 0;
  var inferWatchdog = null;
  var rvfcHandle = null;
  var renderRaf = null;
  var useRvfc = typeof HTMLVideoElement !== "undefined" &&
    typeof HTMLVideoElement.prototype.requestVideoFrameCallback === "function";

  var mirror = true;
  var drawLandmarksEnabled = true;
  /*
   * Perf HUD — OFF by default. Never auto-show just because Live started.
   * Opt-in only: ?perf=1 | ?debugTrack=1 | Settings → Perf monitor.
   */
  var showHud = false;
  try {
    var q = (typeof location !== "undefined" && location.search) || "";
    showDebugTrack = /(?:^|[?&])debugTrack=1(?:&|$)/.test(q);
    forceCpu = /(?:^|[?&])forceCpu=1(?:&|$)/.test(q);
    forceHolistic = /(?:^|[?&])holistic=1(?:&|$)/.test(q);
  } catch (e) {}
  modelKind = forceHolistic ? "holistic" : "hands";

  function queryWantsPerfHud() {
    try {
      var s = (typeof location !== "undefined" && location.search) || "";
      return /(?:^|[?&])(?:perf|debugTrack)=1(?:&|$)/.test(s);
    } catch (e) {
      return false;
    }
  }

  /** Resolve HUD visibility — Live never implies on. */
  function resolveShowHud(opts) {
    opts = opts || {};
    if (opts.showHud != null) return !!opts.showHud;
    if (queryWantsPerfHud()) return true;
    return !!(typeof SB !== "undefined" && SB.settings && SB.settings.perfHud);
  }

  function hideTrackHudEl() {
    var el = document.getElementById("trackHud");
    if (!el) return;
    el.hidden = true;
    el.textContent = "";
    el.removeAttribute("data-armed");
    el.setAttribute("aria-hidden", "true");
  }

  showHud = resolveShowHud({});

  /* Latest measured hands (recognition) + UI hands (filtered/predicted) */
  var rawHands = { left: null, right: null, tMs: 0, mediaMs: 0 };
  var uiHands = { left: null, right: null };
  var prevRaw = { left: null, right: null, tMs: 0 };
  var debugRawHands = { left: null, right: null }; /* ungated, for debug draw */
  /* Double-buffered clones so slots never alias shared buffers. */
  var leftCloneA = [];
  var leftCloneB = [];
  var rightCloneA = [];
  var rightCloneB = [];
  var leftCloneFlip = false;
  var rightCloneFlip = false;

  /* Pass 8: minimum lag — tip glue near pass-2, palm still filtered. */
  var FILTER_OPTS = {
    minCutoff: 2.6, beta: 1.55, tipMinCutoff: 3.6, tipBeta: 2.55, dCutoff: 1.15,
  };
  var leftSlot = new SB.HandTrackSlot("L", FILTER_OPTS);
  var rightSlot = new SB.HandTrackSlot("R", FILTER_OPTS);
  var drawPtsBuf = [];

  /* Latency compensation — aggressive lead, hard clamp (no spaghetti). */
  var predictSec = 0.024;
  var maxPredictNorm = 0.065;
  var paintLeadSec = 0.024;

  /*
   * Adaptive infer width. Pass 8 floor: stay small for throughput.
   * GPU start 288 → max 360 when healthy; CPU 288; low 240.
   */
  var INFER_MAX_W_GPU = 360;
  var INFER_MAX_W_GPU_START = 288;
  var INFER_MAX_W_CPU = 288;
  var INFER_MAX_W_LOW = 240;
  var INFER_MAX_W = INFER_MAX_W_GPU_START;
  var TARGET_INFER_FPS = 28;
  var TARGET_E2E_MS = 70;

  /* Busy-gate watchdog — GPU can hang on some headless/SwiftShader hosts. */
  var INFER_WATCHDOG_MS = 550;
  var GPU_PROBE_MS = 1600; /* cold first frame; stickiness forgives 1 stall after healthy */
  var gpuProbeDone = false;
  var gpuFallbackTried = false;
  var gpuHealthyFrames = 0;
  var gpuStallStrikes = 0;
  var gpuRetryPending = false;
  var gpuRetryCount = 0;

  /* Latest-frame pending: when busy, remember newest cam time; kick on release */
  var pendingKick = null;
  var pendingKickCount = 0;

  /* Perf / HUD */
  var LAT_RING = 48;
  var inferLatRing = new Float64Array(LAT_RING);
  var e2eLatRing = new Float64Array(LAT_RING);
  var confirmLatRing = new Float64Array(LAT_RING);
  var inferLatN = 0;
  var e2eLatN = 0;
  var confirmLatN = 0;
  var stats = {
    camFps: 0,
    inferFps: 0,
    renderFps: 0,
    inferMs: 0,
    inferMsAvg: 0,
    inferMsP95: 0,
    frameAgeMs: 0,
    e2eMs: 0,
    e2eMsAvg: 0,
    e2eMsP95: 0,
    confirmMsAvg: 0,
    dropped: 0,
    timeouts: 0,
    hands: 0,
    backend: "—",
    model: "hands",
    inferW: 0,
    inferH: 0,
    stale: 0,
    gated: 0,
    holds: 0,
    jumps: 0,
    swapsBlocked: 0,
    pendingKicks: 0,
    losses: 0,
    reacquires: 0,
    handL: "LOST",
    handR: "LOST",
    ageL: 0,
    ageR: 0,
    holdTtlMs: SB.HAND_HOLD_TTL_MS || 160,
    lostAfter: SB.HAND_LOST_AFTER_MISSES || 3,
    clearWhy: "",
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

  function ringPush(ring, nRef, value) {
    ring[nRef.i % LAT_RING] = value;
    nRef.i++;
  }
  var _inferIdx = { i: 0 };
  var _e2eIdx = { i: 0 };
  var _confirmIdx = { i: 0 };

  function ringStats(ring, n) {
    var count = Math.min(n, LAT_RING);
    if (!count) return { avg: 0, p95: 0, p50: 0 };
    var tmp = [];
    var sum = 0;
    var start = n > LAT_RING ? n % LAT_RING : 0;
    for (var i = 0; i < count; i++) {
      var v = ring[(start + i) % LAT_RING];
      tmp.push(v);
      sum += v;
    }
    tmp.sort(function (a, b) { return a - b; });
    var p50 = tmp[Math.min(tmp.length - 1, Math.floor(0.5 * (tmp.length - 1)))];
    var p95 = tmp[Math.min(tmp.length - 1, Math.floor(0.95 * (tmp.length - 1)))];
    return { avg: sum / count, p50: p50, p95: p95 };
  }

  function refreshHoldBudget() {
    var inf = ringStats(inferLatRing, inferLatN);
    var ms = inf.p50 || inf.avg || stats.inferMs || 110;
    if (typeof SB.updateHandHoldBudget === "function") {
      var b = SB.updateHandHoldBudget(ms);
      stats.holdTtlMs = b.ttlMs;
      stats.lostAfter = b.lostAfterMisses;
    } else {
      stats.holdTtlMs = SB.HAND_HOLD_TTL_MS || 160;
      stats.lostAfter = SB.HAND_LOST_AFTER_MISSES || 3;
    }
  }

  // ----------------------------------------------------------
  // Load HandLandmarker (default) — prefer Web Worker
  // ----------------------------------------------------------

  function desiredModel() {
    if (forceHolistic) return "holistic";
    try {
      if (SB.DataCapture && typeof SB.DataCapture.isRecording === "function" &&
          SB.DataCapture.isRecording()) {
        return "holistic";
      }
    } catch (e) {}
    return "hands";
  }

  function applyInferCap() {
    /* Prefer lean start on GPU so the probe finishes; ramp via adaptInferResolution. */
    INFER_MAX_W = preferGpu ? INFER_MAX_W_GPU_START : INFER_MAX_W_CPU;
  }

  function loadLandmarker() {
    modelKind = desiredModel();
    console.log("Loading MediaPipe " + (modelKind === "holistic" ? "Holistic" : "Hand") + "Landmarker…");
    preferGpu = !forceCpu;
    applyInferCap();
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
        worker = new Worker("js/engine/handWorker.js?v=20261026p8");
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
          if (settled && !msg.reinit) return;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
          }
          useWorker = true;
          workerReady = true;
          var del = (msg.info && msg.info.delegate) || (preferGpu ? "GPU" : "CPU");
          preferGpu = del === "GPU";
          if (msg.info && msg.info.model) modelKind = msg.info.model;
          applyInferCap();
          stats.model = modelKind;
          stats.backend = "worker/" + del + "/" + modelKind;
          worker.onmessage = onWorkerMessage;
          if (msg.info && msg.info.fallback) {
            console.warn("GPU delegate failed, using CPU:", msg.info.fallback);
          }
          console.log("MediaPipe ready (" + stats.backend + ").");
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

      worker.postMessage({
        type: "init",
        preferGpu: preferGpu,
        model: modelKind,
      });
    });
  }

  function fallbackWorkerToCpu(reason) {
    if (gpuFallbackTried || forceCpu) return;
    gpuFallbackTried = true;
    preferGpu = false;
    gpuHealthyFrames = 0;
    gpuStallStrikes = 0;
    applyInferCap();
    /* CPU path: start at low res immediately for FPS after a GPU stall. */
    INFER_MAX_W = INFER_MAX_W_LOW;
    workerReady = false;
    useWorker = false;
    console.warn(
      "GPU detect stalled (" + reason + ") — replacing worker with CPU (" + modelKind + ")."
    );
    stats.backend = "worker/CPU/" + modelKind + "(fallback…)";
    /* A hung detectForVideo blocks the classic worker event loop, so
       postMessage(reinit) never runs. Terminate and spawn a fresh worker. */
    if (worker) {
      try { worker.terminate(); } catch (e) {}
      worker = null;
    }
    initWorker()
      .then(function () {
        stats.backend = "worker/CPU/" + modelKind + "(fallback)";
        releaseBusy(true);
        console.log("CPU worker ready after GPU stall.");
        /* One soft GPU retry later if CPU stays healthy (real GPU may recover). */
        scheduleGpuRetry();
      })
      .catch(function (err) {
        console.error("CPU worker fallback failed:", err);
        return initMainThreadLandmarker().then(function () {
          useWorker = false;
          releaseBusy(true);
        });
      });
  }

  function scheduleGpuRetry() {
    /* Stickiness: one soft GPU retry after fallback (not a thrash loop). */
    if (forceCpu || gpuRetryPending || gpuRetryCount >= 1) return;
    gpuRetryPending = true;
    setTimeout(function () {
      gpuRetryPending = false;
      if (!running || forceCpu || preferGpu) return;
      if (stats.inferFps < 4) return;
      if (stats.e2eMsAvg > 0 && stats.e2eMsAvg < 55) return;
      gpuRetryCount++;
      console.log("Retrying GPU HandLandmarker after CPU fallback…");
      gpuFallbackTried = false;
      preferGpu = true;
      gpuProbeDone = false;
      gpuHealthyFrames = 0;
      gpuStallStrikes = 0;
      applyInferCap();
      workerReady = false;
      useWorker = false;
      if (worker) {
        try { worker.terminate(); } catch (e) {}
        worker = null;
      }
      initWorker()
        .then(function () {
          releaseBusy(true);
          console.log("GPU retry ready (" + stats.backend + ").");
        })
        .catch(function () {
          preferGpu = false;
          gpuFallbackTried = true;
          applyInferCap();
          INFER_MAX_W = INFER_MAX_W_LOW;
          return initWorker().then(function () {
            stats.backend = "worker/CPU/" + modelKind + "(fallback)";
            releaseBusy(true);
          });
        });
    }, 5000);
  }

  function tunePredictFromE2e(e2eMs) {
    /* Pass 8: lead tracks measured e2e hard (still capped; clamp kills spaghetti) */
    predictSec = Math.min(0.07, Math.max(0.012, e2eMs / 1000 * 0.6));
  }

  function onWorkerMessage(ev) {
    var msg = ev.data || {};
    if (msg.type === "ready" && msg.reinit) {
      workerReady = true;
      var del = (msg.info && msg.info.delegate) || "CPU";
      preferGpu = del === "GPU";
      if (msg.info && msg.info.model) modelKind = msg.info.model;
      applyInferCap();
      stats.model = modelKind;
      stats.backend = "worker/" + del + "/" + modelKind +
        (gpuFallbackTried ? "(fallback)" : "");
      releaseBusy(true);
      console.log("Worker reinit ready (" + stats.backend + ").");
      return;
    }
    if (msg.type === "result") {
      var now = performance.now();
      /* Stale / out-of-order: only the newest detect id may update tracks */
      if (msg.id != null && msg.id < lastAcceptedDetectId) {
        stats.stale++;
        releaseBusy(true);
        return;
      }
      if (msg.id != null) lastAcceptedDetectId = msg.id;
      stats.inferMs = msg.inferMs || 0;
      lastInferEndMs = now;
      inferFrameCount++;
      ringPush(inferLatRing, _inferIdx, stats.inferMs);
      inferLatN = _inferIdx.i;
      refreshHoldBudget();
      if (msg.wallSentMs != null) {
        stats.e2eMs = Math.max(0, now - msg.wallSentMs);
        ringPush(e2eLatRing, _e2eIdx, stats.e2eMs);
        e2eLatN = _e2eIdx.i;
        tunePredictFromE2e(stats.e2eMs);
      }
      if (!gpuProbeDone) gpuProbeDone = true;
      if (preferGpu && !gpuFallbackTried) {
        gpuHealthyFrames++;
        gpuStallStrikes = 0;
      }
      try {
        ingestResults(
          {
            leftHandLandmarks: msg.leftHandLandmarks,
            rightHandLandmarks: msg.rightHandLandmarks,
            poseLandmarks: msg.poseLandmarks,
            detections: msg.detections,
          },
          lastInferEndMs,
          msg.mediaMs
        );
      } catch (err) {
        console.error("ingestResults error:", err);
      } finally {
        /* Always clear + kick latest pending cam frame (latest-frame wins). */
        releaseBusy(true);
      }
      return;
    }
    if (msg.type === "error") {
      console.error("Hand worker detect error:", msg.error);
      releaseBusy(true);
    }
  }

  function initMainThreadLandmarker() {
    return import(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/+esm"
    ).then(async function (visionModule) {
      var FilesetResolver = visionModule.FilesetResolver;
      var HandLandmarker = visionModule.HandLandmarker;
      var HolisticLandmarker = visionModule.HolisticLandmarker;

      var vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm"
      );

      var useH = modelKind === "holistic";
      var opts = useH
        ? {
            baseOptions: {
              modelAssetPath:
                "https://storage.googleapis.com/mediapipe-models/" +
                "holistic_landmarker/holistic_landmarker/float16/1/" +
                "holistic_landmarker.task",
              delegate: forceCpu ? "CPU" : "GPU",
            },
            runningMode: "VIDEO",
            outputFaceBlendshapes: false,
            outputPoseSegmentationMasks: false,
          }
        : {
            baseOptions: {
              modelAssetPath:
                "https://storage.googleapis.com/mediapipe-models/" +
                "hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
              delegate: forceCpu ? "CPU" : "GPU",
            },
            runningMode: "VIDEO",
            numHands: 2,
            minHandDetectionConfidence: 0.45,
            minHandPresenceConfidence: 0.45,
            minTrackingConfidence: 0.45,
          };

      var Factory = useH ? HolisticLandmarker : HandLandmarker;
      try {
        landmarker = await Factory.createFromOptions(vision, opts);
        preferGpu = opts.baseOptions.delegate === "GPU";
        stats.backend = "main/" + opts.baseOptions.delegate + "/" + modelKind;
      } catch (gpuErr) {
        console.warn("GPU delegate failed, falling back to CPU:", gpuErr);
        opts.baseOptions.delegate = "CPU";
        landmarker = await Factory.createFromOptions(vision, opts);
        preferGpu = false;
        stats.backend = "main/CPU/" + modelKind;
      }
      applyInferCap();
      stats.model = modelKind;
      console.log("MediaPipe ready (" + stats.backend + ").");
    });
  }

  function normalizeMainResults(results) {
    if (modelKind === "holistic") {
      var detsH = SB.detectionsFromGroups(
        results.leftHandLandmarks,
        results.rightHandLandmarks
      );
      return {
        leftHandLandmarks: results.leftHandLandmarks,
        rightHandLandmarks: results.rightHandLandmarks,
        poseLandmarks: results.poseLandmarks,
        detections: detsH,
      };
    }
    /* HandLandmarker → detections + legacy groups */
    var left = [];
    var right = [];
    var detections = [];
    var lms = results.landmarks || [];
    var handed = results.handedness || results.handednesses || [];
    for (var i = 0; i < lms.length; i++) {
      var label = "";
      var score = 0.5;
      var h = handed[i];
      if (h && h.length && h[0]) {
        label = String(h[0].categoryName || h[0].displayName || "").toLowerCase();
        if (typeof h[0].score === "number") score = h[0].score;
      }
      detections.push({ landmarks: lms[i], label: label, score: score });
      if (label.indexOf("left") >= 0) left.push(lms[i]);
      else if (label.indexOf("right") >= 0) right.push(lms[i]);
      else if (!right.length) right.push(lms[i]);
      else left.push(lms[i]);
    }
    return {
      leftHandLandmarks: left,
      rightHandLandmarks: right,
      poseLandmarks: [],
      detections: detections,
    };
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
    stats.inferW = w;
    stats.inferH = h;
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
    if (!showHud) hideTrackHudEl();
  };

  self.getShowHud = function () {
    return showHud;
  };

  self.getPerfStats = function () {
    var inf = ringStats(inferLatRing, inferLatN);
    var e2e = ringStats(e2eLatRing, e2eLatN);
    var conf = ringStats(confirmLatRing, confirmLatN);
    stats.inferMsAvg = inf.avg;
    stats.inferMsP95 = inf.p95;
    stats.e2eMsAvg = e2e.avg;
    stats.e2eMsP95 = e2e.p95;
    stats.confirmMsAvg = conf.avg;
    return Object.assign({}, stats);
  };

  /** Called by translate view when a token is confirmed into the transcript. */
  self.noteConfirmMs = function (ms) {
    if (typeof ms !== "number" || !(ms >= 0)) return;
    ringPush(confirmLatRing, _confirmIdx, ms);
    confirmLatN = _confirmIdx.i;
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
    overlayCtx = null;
    mirror = opts.mirror !== false;
    drawLandmarksEnabled = opts.drawLandmarks !== false;
    /* Re-resolve every start — Live alone never turns the HUD on. */
    showHud = resolveShowHud(opts);
    if (!showHud) hideTrackHudEl();

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
            /* Pass 8: smallest practical capture for min downscale/infer cost */
            width: { ideal: 320, max: 960 },
            height: { ideal: 180, max: 540 },
            frameRate: { ideal: 30, max: 30 },
          },
          audio: false,
        });
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
        console.log(
          "Live engine started (" + modelKind + ", latest-frame, decoupled draw)."
        );
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
    pendingKick = null;
    inferenceBusy = false;
    clearInferWatchdog();
    stopInferenceLoop();
    stopRenderLoop();
    teardownStream();
    clearCanvas();
    resetTrackingState();
    hideTrackHudEl();
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
    debugRawHands.left = debugRawHands.right = null;
    leftSlot.reset();
    rightSlot.reset();
    lastAcceptedDetectId = 0;
    pendingKick = null;
    pendingKickCount = 0;
    stats.dropped = 0;
    stats.timeouts = 0;
    stats.stale = 0;
    stats.gated = 0;
    stats.holds = 0;
    stats.jumps = 0;
    stats.swapsBlocked = 0;
    stats.pendingKicks = 0;
    stats.losses = 0;
    stats.reacquires = 0;
    stats.handL = "LOST";
    stats.handR = "LOST";
    stats.ageL = 0;
    stats.ageR = 0;
    stats.clearWhy = "";
    stats.holdTtlMs = SB.HAND_HOLD_TTL_MS || 160;
    stats.lostAfter = SB.HAND_LOST_AFTER_MISSES || 3;
    inferLatN = e2eLatN = confirmLatN = 0;
    _inferIdx.i = _e2eIdx.i = _confirmIdx.i = 0;
    gpuProbeDone = false;
    gpuHealthyFrames = 0;
    gpuStallStrikes = 0;
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
    else {
      pendingKick = { now: performance.now(), mediaMs: null };
      stats.dropped++;
      maybeWatchdog(performance.now());
    }
    requestAnimationFrame(renderKickInfer);
  }

  function onVideoFrame(now, metadata) {
    if (!running) return;
    camFrameCount++;
    var mediaMs = metadata && metadata.mediaTime != null
      ? metadata.mediaTime * 1000
      : now;

    if (inferenceBusy) {
      /* Keep only the newest camera time — kick it the instant infer frees. */
      pendingKick = { now: now, mediaMs: mediaMs };
      stats.dropped++;
      maybeWatchdog(now);
    } else {
      runInference(now, mediaMs);
    }

    if (running && useRvfc) {
      rvfcHandle = videoEl.requestVideoFrameCallback(onVideoFrame);
    }
  }

  /** Clear busy gate; optionally start the latest pending frame immediately. */
  function releaseBusy(doKick) {
    clearInferWatchdog();
    inferenceBusy = false;
    if (doKick === false || !running) return;
    if (!pendingKick) return;
    var p = pendingKick;
    pendingKick = null;
    pendingKickCount++;
    stats.pendingKicks = pendingKickCount;
    /* Pass 8: kick sync — max latest-frame throughput (no microtask gap). */
    if (!running || inferenceBusy) return;
    runInference(p.now, p.mediaMs);
  }

  function clearInferWatchdog() {
    if (inferWatchdog != null) {
      clearTimeout(inferWatchdog);
      inferWatchdog = null;
    }
  }

  function watchdogLimitMs() {
    /* First GPU frame: fail fast to CPU. First CPU frame after cold start can be slow. */
    if (preferGpu && !gpuProbeDone && !gpuFallbackTried) return GPU_PROBE_MS;
    if (inferLatN === 0) return 3500;
    return INFER_WATCHDOG_MS;
  }

  function armInferWatchdog(wallSentMs) {
    clearInferWatchdog();
    /* Stickiness: after healthy GPU frames, give cold/slow frames more room
       before tearing down the worker (true hangs still fall back). */
    var limit = watchdogLimitMs();
    if (preferGpu && !gpuFallbackTried && gpuHealthyFrames >= 12) {
      limit = Math.max(limit, INFER_WATCHDOG_MS + 350);
    }
    busySinceMs = wallSentMs;
    inferWatchdog = setTimeout(function () {
      if (!inferenceBusy || !running) return;
      stats.timeouts++;
      stats.dropped++;
      inferWatchdog = null;
      if (preferGpu && !gpuFallbackTried) {
        gpuStallStrikes++;
        releaseBusy(false);
        fallbackWorkerToCpu("watchdog " + limit + "ms");
      } else {
        console.warn("Inference watchdog fired after " + limit + "ms — releasing busy gate.");
        releaseBusy(true);
      }
    }, limit);
  }

  function maybeWatchdog(now) {
    if (!inferenceBusy) return;
    var limit = watchdogLimitMs();
    if (preferGpu && !gpuFallbackTried && gpuHealthyFrames >= 12) {
      limit = Math.max(limit, INFER_WATCHDOG_MS + 350);
    }
    if (busySinceMs && now - busySinceMs > limit + 50) {
      stats.timeouts++;
      if (preferGpu && !gpuFallbackTried) {
        gpuStallStrikes++;
        releaseBusy(false);
        fallbackWorkerToCpu("busy age");
      } else {
        releaseBusy(true);
      }
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
    if (inferenceBusy) return;

    inferenceBusy = true;
    var t0 = performance.now();
    armInferWatchdog(t0);
    var srcW = videoEl.videoWidth;
    var srcH = videoEl.videoHeight;
    var canvas = ensureInferCanvas(srcW, srcH);
    var targetW = canvas.width;
    var targetH = canvas.height;

    var ts = mediaMs != null ? mediaMs : performance.now();
    if (ts <= lastMediaTimestampMs) ts = lastMediaTimestampMs + 1;
    lastMediaTimestampMs = ts;

    var sendInput = function (input) {
      if (!running) {
        if (input && input.close) input.close();
        releaseBusy(false);
        return;
      }

      if (useWorker && workerReady && worker && input && input.close) {
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

      if (useWorker && !workerReady) {
        if (input && input.close) input.close();
        stats.dropped++;
        releaseBusy(true);
        return;
      }

      if (!landmarker) {
        if (input && input.close) input.close();
        releaseBusy(true);
        return;
      }

      var raw = landmarker.detectForVideo(input || canvas, ts);
      if (input && input.close) input.close();
      var results = normalizeMainResults(raw);
      var t1 = performance.now();
      stats.inferMs = t1 - t0;
      stats.e2eMs = stats.inferMs;
      lastInferEndMs = t1;
      inferFrameCount++;
      ringPush(inferLatRing, _inferIdx, stats.inferMs);
      inferLatN = _inferIdx.i;
      refreshHoldBudget();
      ringPush(e2eLatRing, _e2eIdx, stats.e2eMs);
      e2eLatN = _e2eIdx.i;
      tunePredictFromE2e(stats.e2eMs);
      if (!gpuProbeDone) gpuProbeDone = true;
      if (preferGpu && !gpuFallbackTried) gpuHealthyFrames++;
      try {
        ingestResults(results, lastInferEndMs, ts);
      } catch (err) {
        console.error("ingestResults error:", err);
      }
      releaseBusy(true);
    };

    /*
     * Pass 8: always drawImage→bitmap (predictable, no 100ms video-bitmap race).
     * Latest-frame wins; pending kick is sync in releaseBusy.
     */
    inferCtx.drawImage(videoEl, 0, 0, targetW, targetH);
    if (typeof createImageBitmap === "function" && useWorker) {
      createImageBitmap(canvas)
        .then(sendInput)
        .catch(function () {
          if (landmarker) sendInput(null);
          else {
            stats.dropped++;
            releaseBusy(true);
          }
        });
    } else {
      sendInput(null);
    }
  }

  // ----------------------------------------------------------
  // Results → left/right + pose + recognition (raw only)
  // ----------------------------------------------------------

  function ingestResults(results, wallMs, mediaMs) {
    leftCloneFlip = !leftCloneFlip;
    rightCloneFlip = !rightCloneFlip;

    var detections = results.detections;
    if (!detections || !detections.length) {
      detections = SB.detectionsFromGroups(
        results.leftHandLandmarks,
        results.rightHandLandmarks
      );
    }

    /* Clone landmark arrays into flip buffers so slots own stable copies */
    var cloned = [];
    for (var di = 0; di < detections.length; di++) {
      var src = detections[di].landmarks;
      if (!src || !src.length) continue;
      var buf = (cloned.length & 1)
        ? (rightCloneFlip ? rightCloneA : rightCloneB)
        : (leftCloneFlip ? leftCloneA : leftCloneB);
      /* Use unique buffers per detection index */
      if (di === 0) buf = leftCloneFlip ? leftCloneA : leftCloneB;
      else buf = rightCloneFlip ? rightCloneA : rightCloneB;
      cloned.push({
        landmarks: cloneLandmarks(src, buf),
        label: detections[di].label || "",
        score: detections[di].score || 0.5,
      });
    }

    var assigned = SB.assignHandDetections(cloned, leftSlot, rightSlot);
    if (assigned.swapsBlocked) stats.swapsBlocked += assigned.swapsBlocked;

    debugRawHands.left = assigned.left;
    debugRawHands.right = assigned.right;

    var leftUp = leftSlot.update(assigned.left, wallMs);
    var rightUp = rightSlot.update(assigned.right, wallMs);

    if (leftSlot.debug.gated) stats.gated++;
    if (rightSlot.debug.gated) stats.gated++;
    if (leftUp.reacquired || rightUp.reacquired) stats.jumps++;
    if (leftUp.held) stats.holds++;
    if (rightUp.held) stats.holds++;
    if (leftUp.reacquired) stats.reacquires++;
    if (rightUp.reacquired) stats.reacquires++;
    stats.losses = leftSlot.lossCount + rightSlot.lossCount;
    stats.handL = leftSlot.status;
    stats.handR = rightSlot.status;
    stats.ageL = leftSlot.lastTMs ? leftSlot.landmarkAgeMs(wallMs) : 0;
    stats.ageR = rightSlot.lastTMs ? rightSlot.landmarkAgeMs(wallMs) : 0;
    stats.clearWhy =
      leftSlot.clearReason || rightSlot.clearReason ||
      (leftUp.clearReason || "") || (rightUp.clearReason || "") ||
      stats.clearWhy;

    prevRaw.left = leftSlot.prevRaw;
    prevRaw.right = rightSlot.prevRaw;
    prevRaw.tMs = rawHands.tMs;

    /* Accepted = live raw; brief TEMPORARILY_LOST hold keeps last raw for draw
       but never feeds prediction velocity (prev stays frozen). */
    rawHands.left = leftUp.accepted
      ? leftSlot.lastRaw
      : (leftUp.held ? leftSlot.lastRaw : null);
    rawHands.right = rightUp.accepted
      ? rightSlot.lastRaw
      : (rightUp.held ? rightSlot.lastRaw : null);
    rawHands.tMs = wallMs;
    rawHands.mediaMs = mediaMs;

    uiHands.left = leftUp.ui;
    uiHands.right = rightUp.ui;

    var handCount = (uiHands.left ? 1 : 0) + (uiHands.right ? 1 : 0);
    stats.hands = handCount;
    if (SB.Engine && SB.Engine._hands) SB.Engine._hands(handCount);

    heavyFrame++;
    var runHeavy = (heavyFrame & 1) === 0;

    /* Classify on accepted OR brief hold — landmarks are already gated.
       Mirror display: flip x so handshapes match what the signer sees. */
    if (runHeavy && classifier) {
      var classifierHand =
        ((leftUp.accepted || leftUp.held) && leftSlot.lastRaw) ||
        ((rightUp.accepted || rightUp.held) && rightSlot.lastRaw) ||
        null;
      if (classifierHand) {
        var handForCls = classifierHand;
        if (mirror) handForCls = mirrorLandmarksX(classifierHand);
        var features = landmarkVector(handForCls);
        var token = null;
        try { token = classifier(features); } catch (err) {
          console.error("Classifier error:", err);
        }
        stats.classifyCalls = (stats.classifyCalls || 0) + 1;
        if (token && token.text) {
          token.source = token.source || "live";
          stats.lastGloss = String(token.text);
          stats.lastGlossConf = typeof token.conf === "number" ? token.conf : 0;
          if (SB.Engine && SB.Engine._result) SB.Engine._result(token);
        } else {
          stats.classifyNulls = (stats.classifyNulls || 0) + 1;
        }
      }
    }

    if (!runHeavy) return;

    /* Hands mode has no pose — skip LSTM entirely (needs shoulders).
       Training only while actively recording. */
    var recording = false;
    try {
      if (SB.DataCapture && typeof SB.DataCapture.isRecording === "function") {
        recording = !!SB.DataCapture.isRecording();
      }
      if (!recording && window.TrainingRecorder &&
          typeof window.TrainingRecorder.status === "function") {
        var stRec = window.TrainingRecorder.status();
        recording = !!(stRec && stRec.recording);
      }
    } catch (e) {}
    var wantLstm = modelKind === "holistic" &&
      window.SignBridgeLiveTest &&
      typeof window.SignBridgeLiveTest.processFrame === "function" &&
      window.SignBridgeLiveTest.status &&
      window.SignBridgeLiveTest.status().active;
    if (!recording && !wantLstm) return;

    var snapLeft = leftUp.accepted ? leftSlot.lastRaw : null;
    var snapRight = rightUp.accepted ? rightSlot.lastRaw : null;
    if (!snapLeft && !snapRight && !wantLstm) return;

    var snapResults = {
      leftHandLandmarks: snapLeft ? [snapLeft] : [],
      rightHandLandmarks: snapRight ? [snapRight] : [],
      poseLandmarks: results.poseLandmarks || [],
    };
    queueMicrotask(function () {
      if (recording && window.TrainingRecorder &&
          typeof window.TrainingRecorder.processFrame === "function") {
        try {
          window.TrainingRecorder.processFrame(snapResults, snapLeft, snapRight);
        } catch (err) {
          console.error("Training recorder error:", err);
        }
      }

      if (wantLstm) {
        try {
          window.SignBridgeLiveTest.processFrame(snapResults, snapLeft, snapRight);
        } catch (err) {
          console.error("LSTM live test error:", err);
        }
      }
    });
  }

  function cloneLandmarks(src, buf) {
    var out = buf || [];
    for (var i = 0; i < src.length; i++) {
      if (!out[i]) out[i] = { x: 0, y: 0, z: 0 };
      out[i].x = src[i].x;
      out[i].y = src[i].y;
      out[i].z = src[i].z || 0;
    }
    out.length = src.length;
    return out;
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

  function predictHand(filtered, raw, prev, dtSec, leadSec, outBuf) {
    if (!filtered) return null;
    if (!raw || !prev || !prev.length || dtSec <= 1e-4 || leadSec <= 0) {
      return filtered;
    }
    /* Require same topology length — never predict across identity swaps */
    if (prev.length !== raw.length || filtered.length !== raw.length) return filtered;

    var out = outBuf || [];
    for (var i = 0; i < filtered.length; i++) {
      if (!out[i]) out[i] = { x: 0, y: 0, z: 0 };
      if (!raw[i] || !prev[i]) {
        out[i].x = filtered[i].x;
        out[i].y = filtered[i].y;
        out[i].z = filtered[i].z;
        continue;
      }
      var vx = (raw[i].x - prev[i].x) / dtSec;
      var vy = (raw[i].y - prev[i].y) / dtSec;
      /* Clamp velocity in norm-units/sec to kill tip teleport prediction */
      var spd = Math.sqrt(vx * vx + vy * vy);
      /* Pass 8: tighter tip clamp — more lead, less spaghetti */
      var maxSpd = SB._TIP_IDX && SB._TIP_IDX[i] ? 2.35 : 2.0;
      if (spd > maxSpd) {
        vx = (vx / spd) * maxSpd;
        vy = (vy / spd) * maxSpd;
      }
      var dx = vx * leadSec;
      var dy = vy * leadSec;
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
    if (!overlayCtx) overlayCtx = canvasEl.getContext("2d", { alpha: true });
    var ctx = overlayCtx;
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

    var ageL = leftSlot.lastTMs ? leftSlot.landmarkAgeMs(now) : 0;
    var ageR = rightSlot.lastTMs ? rightSlot.landmarkAgeMs(now) : 0;
    stats.ageL = ageL;
    stats.ageR = ageR;
    stats.handL = leftSlot.status;
    stats.handR = rightSlot.status;
    stats.frameAgeMs = Math.min(
      uiHands.left ? ageL : Infinity,
      uiHands.right ? ageR : Infinity
    );
    if (!isFinite(stats.frameAgeMs)) stats.frameAgeMs = 0;

    /*
     * Pass 8: max lead within adaptive TTL (age-weighted), hard velocity clamp.
     * Fade as age→TTL. Never extrapolate LOST / past-TTL (P5/P6 no-ghost).
     * Never blank while holding inside TTL.
     */
    var freshMs = stats.holdTtlMs || SB.HAND_HOLD_TTL_MS || 160;
    paintLeadSec = Math.min(
      0.07,
      Math.max(predictSec, stats.frameAgeMs / 1000 * 0.6 + predictSec * 0.7)
    );

    function drawSlot(slot, ui, raw, prev, label) {
      if (!ui) return;
      var st = slot.status;
      var tracking = st === SB.HAND_STATUS.TRACKING;
      var holding = st === SB.HAND_STATUS.TEMPORARILY_LOST;
      if (!tracking && !holding) return;
      var age = slot.landmarkAgeMs(now);
      if (!isFinite(age) || age > freshMs) return; /* adaptive freshness TTL */

      var dtSec = 1 / 30;
      if (prev && raw && slot.lastTMs && prevRaw.tMs) {
        dtSec = Math.max(1e-3, (rawHands.tMs - prevRaw.tMs) / 1000);
      }
      var lead = 0;
      if (prev && age < freshMs) {
        var fade = 1 - age / Math.max(freshMs, 1);
        /* Keep most of the lead while fresh; fade only near TTL edge */
        var edge = fade * fade; /* stay snappy early in the TTL window */
        if (tracking) {
          lead = paintLeadSec * (0.55 + 0.45 * edge);
        } else if (holding) {
          lead = paintLeadSec * 0.75 * edge;
        }
      }
      var drawn = predictHand(ui, raw, prev, dtSec, lead, slot.predBuf);
      if (drawn) drawHand(ctx, drawn, label, false);
    }

    if (showDebugTrack) {
      if (debugRawHands.left) drawHand(ctx, debugRawHands.left, "rawL", true);
      if (debugRawHands.right) drawHand(ctx, debugRawHands.right, "rawR", true);
    }

    drawSlot(leftSlot, uiHands.left, rawHands.left, prevRaw.left, "L");
    drawSlot(rightSlot, uiHands.right, rawHands.right, prevRaw.right, "R");
  }

  function drawHand(ctx, landmarks, label, isDebugRaw) {
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

    ctx.lineWidth = isDebugRaw ? 1 : 1.75;
    ctx.lineCap = "round";
    ctx.strokeStyle = isDebugRaw ? "rgba(255,80,80,.35)" : "rgba(52, 224, 192, .42)";
    ctx.beginPath();
    for (var c = 0; c < HAND_CONNECTIONS.length; c++) {
      var a = HAND_CONNECTIONS[c][0];
      var b = HAND_CONNECTIONS[c][1];
      var p0 = drawPtsBuf[a];
      var p1 = drawPtsBuf[b];
      if (!p0 || !p1) continue;
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
    }
    ctx.stroke();

    for (var j = 0; j < n; j++) {
      var pt = drawPtsBuf[j];
      var r = isDebugRaw ? 1.8 : (j === 0 ? 4.5 : 2.75);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.fillStyle = isDebugRaw
        ? "rgba(255,100,100,.55)"
        : (j === 0 ? "rgba(255,180,84,.95)" : "rgba(139,140,255,.85)");
      ctx.fill();
    }

    if (label && landmarks[0] && !isDebugRaw) {
      var wx = drawPtsBuf[0].x;
      var wy = drawPtsBuf[0].y;
      ctx.font = "600 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      ctx.fillStyle = "rgba(232,238,252,.9)";
      ctx.strokeStyle = "rgba(6,10,20,.65)";
      ctx.lineWidth = 3;
      var tx = wx + (mirror ? -14 : 8);
      var ty = wy - 10;
      ctx.strokeText(label, tx, ty);
      ctx.fillText(label, tx, ty);
    }

    /* Red ring while saving training frames — visible feedback only */
    if (!isDebugRaw && SB.DataCapture && typeof SB.DataCapture.isRecording === "function" && SB.DataCapture.isRecording()) {
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
      overlayCtx = null;
    }
  }

  function clearCanvas() {
    if (!canvasEl) return;
    if (!overlayCtx) overlayCtx = canvasEl.getContext("2d");
    overlayCtx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  }

  // ----------------------------------------------------------
  // HUD
  // ----------------------------------------------------------

  function adaptInferResolution() {
    var start = preferGpu ? INFER_MAX_W_GPU_START : INFER_MAX_W_CPU;
    var hi = preferGpu ? INFER_MAX_W_GPU : INFER_MAX_W_CPU;
    var next = start;
    var slow =
      (stats.inferFps > 0 && stats.inferFps < TARGET_INFER_FPS) ||
      (stats.e2eMsAvg > 0 && stats.e2eMsAvg > TARGET_E2E_MS);
    var verySlow =
      (stats.inferFps > 0 && stats.inferFps < TARGET_INFER_FPS * 0.7) ||
      (stats.e2eMsAvg > 0 && stats.e2eMsAvg > TARGET_E2E_MS * 1.35);
    if (verySlow) {
      next = INFER_MAX_W_LOW;
    } else if (slow) {
      /* Step down toward low without jumping past start */
      next = Math.min(INFER_MAX_W, INFER_MAX_W_LOW + 32);
      if (INFER_MAX_W <= INFER_MAX_W_LOW + 32) next = INFER_MAX_W_LOW;
    } else if (
      preferGpu &&
      gpuHealthyFrames >= 10 &&
      stats.inferFps >= TARGET_INFER_FPS + 2 &&
      stats.e2eMsAvg > 0 &&
      stats.e2eMsAvg < TARGET_E2E_MS * 0.8
    ) {
      next = hi; /* ramp GPU up when healthy */
    } else if (
      stats.inferFps >= TARGET_INFER_FPS &&
      stats.e2eMsAvg > 0 &&
      stats.e2eMsAvg < TARGET_E2E_MS
    ) {
      next = start;
    }
    if (next !== INFER_MAX_W) {
      INFER_MAX_W = next;
    }
  }

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
      var inf = ringStats(inferLatRing, inferLatN);
      var e2e = ringStats(e2eLatRing, e2eLatN);
      var conf = ringStats(confirmLatRing, confirmLatN);
      stats.inferMsAvg = inf.avg;
      stats.inferMsP95 = inf.p95;
      stats.e2eMsAvg = e2e.avg;
      stats.e2eMsP95 = e2e.p95;
      stats.confirmMsAvg = conf.avg;
      stats.model = modelKind;
      adaptInferResolution();
    }

    var el = document.getElementById("trackHud");
    if (!el) return;
    if (!showHud) {
      hideTrackHudEl();
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
      " (" + stats.inferMs.toFixed(0) + "ms avg " + stats.inferMsAvg.toFixed(0) +
      " p95 " + stats.inferMsP95.toFixed(0) + ")" +
      " · E2E " + stats.e2eMsAvg.toFixed(0) + "/" + stats.e2eMsP95.toFixed(0) + "ms" +
      " · Lead " + (paintLeadSec * 1000).toFixed(0) + "ms" +
      " · Draw " + stats.renderFps.toFixed(0) +
      " · Age " + stats.frameAgeMs.toFixed(0) + "ms" +
      " · TTL " + (stats.holdTtlMs | 0) + "ms×" + (stats.lostAfter | 0) +
      " · Drop " + stats.dropped +
      (stats.timeouts ? " · TO " + stats.timeouts : "") +
      " · L " + shortStatus(stats.handL) + "@" + Math.min(999, stats.ageL | 0) + "ms" +
      " · R " + shortStatus(stats.handR) + "@" + Math.min(999, stats.ageR | 0) + "ms" +
      " · Gate " + stats.gated +
      " · Hold " + stats.holds +
      " · Jump " + stats.jumps +
      " · Loss " + stats.losses +
      " · Reacq " + stats.reacquires +
      (stats.clearWhy ? " · Clr " + stats.clearWhy : "") +
      (stats.stale ? " · Stale " + stats.stale : "") +
      (stats.pendingKicks ? " · Pend " + stats.pendingKicks : "") +
      (stats.swapsBlocked ? " · SwapBlk " + stats.swapsBlocked : "") +
      " · Hands " + stats.hands +
      " · " + stats.inferW + "×" + stats.inferH +
      " · " + stats.backend;
  }

  function shortStatus(s) {
    if (s === "TRACKING") return "trk";
    if (s === "TEMPORARILY_LOST") return "tmp";
    if (s === "REACQUIRING") return "acq";
    return "lost";
  }

  // ----------------------------------------------------------
  // Features for classifier (unchanged contract)
  // ----------------------------------------------------------

  /** Flip landmark x in image space (mirror UX ↔ camera coords). */
  function mirrorLandmarksX(landmarks) {
    var out = new Array(landmarks.length);
    var i;
    for (i = 0; i < landmarks.length; i++) {
      var p = landmarks[i];
      out[i] = {
        x: 1 - p.x,
        y: p.y,
        z: p.z,
        visibility: p.visibility,
      };
    }
    return out;
  }

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
