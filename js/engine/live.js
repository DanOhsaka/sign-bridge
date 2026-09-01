/* ============================================================
   SignBridge — Live engine (live.js)
   ------------------------------------------------------------
   Real hand tracking in the browser via MediaPipe Hands (CDN,
   no build step). This runs TODAY, with no trained model:

     • live webcam feed with the 21-point hand skeleton drawn
       over it — the same skeleton your future model consumes
     • hand-presence events (pulses the status line)
     • a classifier plug-in point: `setClassifier(fn)` receives
       the normalized landmark vector; whatever token object it
       returns flows into the transcript exactly like demo
       tokens — the UI can't tell the difference.

   Feature vector contract (document this to the ML team):
     [x0, y0, z0, x1, y1, z1, …] — 63 floats.
     x/y normalized to the hand bounding box, z normalized
     relative to the wrist (z0 = 0). This is the standard
     MediaPipe→classifier input used by the papers in
     docs/MODELS.md.

   NOTE: camera access requires a secure context — serve over
   http://localhost or https (file:// blocks getUserMedia in
   Chrome). See README.
   ============================================================ */

window.SB = window.SB || {};

SB.LiveEngine = function () {
  var self = this;
  var state = "off";            // off | starting | on | error
  var classifier = null;        // fn(features:Float32Array) -> token|null
  var hands = null;
  var camera = null;
  var stream = null;
  var running = false;

  var CDN = "https://cdn.jsdelivr.net/npm/";
  var LIBS = [
    CDN + "@mediapipe/hands/hands.js",
    CDN + "@mediapipe/camera_utils/camera_utils.js",
    CDN + "@mediapipe/drawing_utils/drawing_utils.js",
  ];

  /* ---- tiny promise-based script loader ---- */
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      var s = document.createElement("script");
      s.src = src; s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error("Couldn't load " + src)); };
      document.head.appendChild(s);
    });
  }

  function loadLibs() {
    return LIBS.reduce(function (p, src) {
      return p.then(function () { return loadScript(src); });
    }, Promise.resolve());
  }

  /* ---- public API ---- */

  self.setClassifier = function (fn) { classifier = fn || null; };
  self.hasClassifier = function () { return !!classifier; };
  self.getState = function () { return state; };

  self.start = function (opts) {
    opts = opts || {};
    if (state === "starting") return Promise.resolve();
    state = "starting";

    var videoEl = opts.videoEl;
    var canvasEl = opts.canvasEl;
    var mirror = opts.mirror !== false;
    var drawLandmarks = opts.drawLandmarks !== false;

    if (!videoEl || !canvasEl) {
      state = "error";
      return Promise.reject(new Error("video/canvas elements missing"));
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      state = "error";
      return Promise.reject(new Error("Camera not available in this browser (needs https or localhost)"));
    }

    return loadLibs().then(function () {
      return navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 960 }, audio: false });
    }).then(function (camStream) {
      stream = camStream;
      videoEl.srcObject = stream;
      return new Promise(function (res) { videoEl.onloadedmetadata = res; });
    }).then(function () {
      hands = new Hands({ locateFile: function (f) { return CDN + "@mediapipe/hands/" + f; } });
      hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        selfieMode: mirror,
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.55,
      });

      canvasEl.width = videoEl.videoWidth || 640;
      canvasEl.height = videoEl.videoHeight || 480;

      hands.onResults(function (results) {
        draw(results);
        SB.Engine._hands(results.multiHandLandmarks ? results.multiHandLandmarks.length : 0);
        if (results.multiHandLandmarks && results.multiHandLandmarks.length && classifier) {
          var lm = results.multiHandLandmarks[0];
          var feats = landmarkVector(lm);
          var token = null;
          try { token = classifier(feats); } catch (e) { console.error("classifier error", e); }
          if (token) {
            token.source = "live";
            SB.Engine._result(token);
          }
        }
      });

      camera = new Camera(videoEl, {
        onFrame: function () { if (hands) hands.send({ image: videoEl }); },
      });
      camera.start();
      running = true;
      state = "on";
      return self;
    }).catch(function (err) {
      state = "error";
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); }
      throw err;
    });
  };

  self.stop = function () {
    running = false;
    if (camera) { try { camera.stop(); } catch (e) {} camera = null; }
    if (hands) { try { hands.close(); } catch (e) {} hands = null; }
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    state = "off";
  };

  /* ---- drawing: 21 landmarks + connections ---- */
  function draw(results) {
    var ctx = canvasEl.getContext("2d");
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    if (!results.multiHandLandmarks || !results.multiHandLandmarks.length) return;

    var lm = results.multiHandLandmarks[0];
    // scale video coords to canvas
    var vw = videoEl.videoWidth, vh = videoEl.videoHeight;
    var sx = canvasEl.width / vw, sy = canvasEl.height / vh;
    var pts = lm.map(function (p) { return { x: p.x * sx, y: p.y * sy }; });

    // connections first (below the joints)
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    if (window.HAND_CONNECTIONS) {
      HAND_CONNECTIONS.forEach(function (c) {
        var a = pts[c[0]], b = pts[c[1]];
        ctx.strokeStyle = "rgba(52, 224, 192, .55)";
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      });
    }
    // joints on top
    pts.forEach(function (p, i) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, i === 0 ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? "#ffb454" : "#8b8cff";
      ctx.fill();
      ctx.strokeStyle = "rgba(6,10,20,.8)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  }

  /* ---- features: 21 × 3, normalized (see contract above) ---- */
  function landmarkVector(lm) {
    var wrist = lm[0];
    var xs = lm.map(function (p) { return p.x; });
    var ys = lm.map(function (p) { return p.y; });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    var span = Math.max(maxX - minX, maxY - minY, 1e-6);

    var feats = new Float32Array(63);
    for (var i = 0; i < 21; i++) {
      feats[i * 3]     = (lm[i].x - minX) / span;
      feats[i * 3 + 1] = (lm[i].y - minY) / span;
      feats[i * 3 + 2] = (lm[i].z - wrist.z) / span;
    }
    return feats;
  }
};
