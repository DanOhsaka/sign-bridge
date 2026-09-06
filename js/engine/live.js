/* ============================================================
   SignBridge — Live MediaPipe Engine
   Uses MediaPipe HolisticLandmarker for:
   - Left hand
   - Right hand
   - Pose (shoulders, elbows, wrists)
   ============================================================ */

window.SB = window.SB || {};

SB.LiveEngine = function () {
  var self = this;

  var state = "off";
  var classifier = null;

  var holistic = null;
  var stream = null;

  var videoEl = null;
  var canvasEl = null;

  var running = false;
  var animationFrameId = null;
  var lastVideoTime = -1;

  var mirror = true;
  var drawLandmarksEnabled = true;

  // ----------------------------------------------------------
  // Load the new MediaPipe HolisticLandmarker
  // ----------------------------------------------------------

  function loadHolistic() {
    return import(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/+esm"
    ).then(async function (visionModule) {

      var FilesetResolver = visionModule.FilesetResolver;
      var HolisticLandmarker = visionModule.HolisticLandmarker;

      console.log("Loading MediaPipe HolisticLandmarker...");

      var vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
      );

      holistic = await HolisticLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/" +
            "holistic_landmarker/holistic_landmarker/float16/1/" +
            "holistic_landmarker.task"
        },
        runningMode: "VIDEO"
      });

      console.log("MediaPipe HolisticLandmarker loaded.");
    });
  }

  // ----------------------------------------------------------
  // Existing LiveEngine API
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

  // ----------------------------------------------------------
  // Start camera
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

    if (!videoEl || !canvasEl) {
      state = "error";
      return Promise.reject(new Error("Video/canvas elements missing"));
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      state = "error";
      return Promise.reject(
        new Error("Camera not available. Use HTTPS or localhost.")
      );
    }

    // Don't reload the model every time Live is toggled.
    var loadPromise = holistic
      ? Promise.resolve()
      : loadHolistic();

    return loadPromise
      .then(function () {
        console.log("Requesting webcam...");

        return navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 60, min: 30 }
          },
          audio: false
        });
      })

      .then(function (camStream) {
        stream = camStream;
        var videoTrack = stream.getVideoTracks()[0];
        console.log("Camera settings:", videoTrack.getSettings());
        videoEl.srcObject = stream;

        return new Promise(function (resolve) {
          if (videoEl.readyState >= 1 && videoEl.videoWidth > 0) {
            resolve();
          } else {
            videoEl.onloadedmetadata = resolve;
          }
        });
      })

      .then(function () {
        return videoEl.play();
      })

      .then(function () {
        canvasEl.width = videoEl.videoWidth || 640;
        canvasEl.height = videoEl.videoHeight || 480;

        lastVideoTime = -1;
        running = true;
        state = "on";

        console.log("Camera started.");

        animationFrameId = requestAnimationFrame(processFrame);

        return self;
      })

      .catch(function (err) {
        console.error("LiveEngine start error:", err);

        state = "error";
        running = false;

        if (stream) {
          stream.getTracks().forEach(function (track) {
            track.stop();
          });

          stream = null;
        }

        throw err;
      });
  };

  // ----------------------------------------------------------
  // Process camera frames
  // ----------------------------------------------------------

  function processFrame() {
    if (!running) {
      return;
    }

    if (
      !holistic ||
      !videoEl ||
      videoEl.readyState < 2 ||
      videoEl.videoWidth === 0
    ) {
      animationFrameId = requestAnimationFrame(processFrame);
      return;
    }

    // Don't process the exact same frame twice.
    if (videoEl.currentTime !== lastVideoTime) {
      lastVideoTime = videoEl.currentTime;

      try {
        var results = holistic.detectForVideo(
          videoEl,
          performance.now()
        );

        handleResults(results);
      } catch (err) {
        console.error("MediaPipe detection error:", err);
      }
    }

    animationFrameId = requestAnimationFrame(processFrame);
  }

  // ----------------------------------------------------------
  // Handle MediaPipe results
  // ----------------------------------------------------------

  function handleResults(results) {
    var leftHand = null;
    var rightHand = null;

    if (
      results.leftHandLandmarks &&
      results.leftHandLandmarks.length > 0
    ) {
      leftHand = results.leftHandLandmarks[0];
    }

    if (
      results.rightHandLandmarks &&
      results.rightHandLandmarks.length > 0
    ) {
      rightHand = results.rightHandLandmarks[0];
    }

    // Tell the existing SignBridge engine how many hands exist.
    var handCount = 0;

    if (leftHand) handCount++;
    if (rightHand) handCount++;

    if (SB.Engine && SB.Engine._hands) {
      SB.Engine._hands(handCount);
    }

    // Draw hand skeletons.
    if (drawLandmarksEnabled) {
      draw(leftHand, rightHand);
    } else {
      clearCanvas();
    }

    // Keep the team's existing classifier system working.
    if (classifier) {
      var classifierHand = rightHand || leftHand;

      if (classifierHand) {
        var features = landmarkVector(classifierHand);
        var token = null;

        try {
          token = classifier(features);
        } catch (err) {
          console.error("Classifier error:", err);
        }

        if (token) {
          token.source = "live";

          if (SB.Engine && SB.Engine._result) {
            SB.Engine._result(token);
          }
        }
      }
    }

    printCoordinates(results, leftHand, rightHand);
  }

  // ----------------------------------------------------------
  // Debug coordinate output
  // ----------------------------------------------------------

  var lastPrintTime = 0;

  function printCoordinates(results, leftHand, rightHand) {
    var now = performance.now();

    // Only print twice per second so DevTools doesn't get flooded.
    if (now - lastPrintTime < 500) {
      return;
    }

    lastPrintTime = now;

    if (leftHand) {
      console.log("LEFT HAND:", leftHand);
    }

    if (rightHand) {
      console.log("RIGHT HAND:", rightHand);
    }

    if (results.poseLandmarks && results.poseLandmarks.length > 0) {
      var pose = results.poseLandmarks[0];

      console.log("LEFT SHOULDER:", pose[11]);
      console.log("RIGHT SHOULDER:", pose[12]);

      console.log("LEFT ELBOW:", pose[13]);
      console.log("RIGHT ELBOW:", pose[14]);

      console.log("LEFT WRIST:", pose[15]);
      console.log("RIGHT WRIST:", pose[16]);
    }
  }

  // ----------------------------------------------------------
  // Hand skeleton connections
  // ----------------------------------------------------------

  var HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],

    [0, 5], [5, 6], [6, 7], [7, 8],

    [5, 9], [9, 10], [10, 11], [11, 12],

    [9, 13], [13, 14], [14, 15], [15, 16],

    [13, 17], [17, 18], [18, 19], [19, 20],

    [0, 17]
  ];

  // ----------------------------------------------------------
  // Clear overlay
  // ----------------------------------------------------------

  function clearCanvas() {
    if (!canvasEl) {
      return;
    }

    var ctx = canvasEl.getContext("2d");

    ctx.clearRect(
      0,
      0,
      canvasEl.width,
      canvasEl.height
    );
  }

  // ----------------------------------------------------------
  // Draw detected hands
  // ----------------------------------------------------------

  function draw(leftHand, rightHand) {
    if (!canvasEl || !videoEl) {
      return;
    }

    var ctx = canvasEl.getContext("2d");

    ctx.clearRect(
      0,
      0,
      canvasEl.width,
      canvasEl.height
    );

    if (leftHand) {
      drawHand(ctx, leftHand);
    }

    if (rightHand) {
      drawHand(ctx, rightHand);
    }
  }

  function drawHand(ctx, landmarks) {
    var points = landmarks.map(function (point) {
      var x = point.x * canvasEl.width;
      var y = point.y * canvasEl.height;

      

      return {
        x: x,
        y: y
      };
    });

    // Draw lines between joints.
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(52, 224, 192, .55)";

    HAND_CONNECTIONS.forEach(function (connection) {
      var start = points[connection[0]];
      var end = points[connection[1]];

      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    });

    // Draw individual landmark points.
    points.forEach(function (point, index) {
      ctx.beginPath();

      ctx.arc(
        point.x,
        point.y,
        index === 0 ? 7 : 5,
        0,
        Math.PI * 2
      );

      ctx.fillStyle = index === 0
        ? "#ffb454"
        : "#8b8cff";

      ctx.fill();

      ctx.strokeStyle = "rgba(6,10,20,.8)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  }

  // ----------------------------------------------------------
  // Convert one hand into the existing 63-number format
  // ----------------------------------------------------------

  function landmarkVector(landmarks) {
    var wrist = landmarks[0];

    var xs = landmarks.map(function (point) {
      return point.x;
    });

    var ys = landmarks.map(function (point) {
      return point.y;
    });

    var minX = Math.min.apply(null, xs);
    var maxX = Math.max.apply(null, xs);

    var minY = Math.min.apply(null, ys);
    var maxY = Math.max.apply(null, ys);

    var span = Math.max(
      maxX - minX,
      maxY - minY,
      1e-6
    );

    var features = new Float32Array(63);

    for (var i = 0; i < 21; i++) {
      features[i * 3] =
        (landmarks[i].x - minX) / span;

      features[i * 3 + 1] =
        (landmarks[i].y - minY) / span;

      features[i * 3 + 2] =
        (landmarks[i].z - wrist.z) / span;
    }

    return features;
  }

  // ----------------------------------------------------------
  // Stop camera
  // ----------------------------------------------------------

  self.stop = function () {
    running = false;

    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }

    if (stream) {
      stream.getTracks().forEach(function (track) {
        track.stop();
      });

      stream = null;
    }

    if (videoEl) {
      videoEl.srcObject = null;
    }

    clearCanvas();

    lastVideoTime = -1;
    state = "off";

    console.log("Camera stopped.");
  };
};