// js/training/training.js
(function () {

  const FRAME_COUNT = 30;

  // MediaPipe's 21 hand landmark names.
  const HAND_NAMES = [
    "wrist",
    "thumbCMC",
    "thumbMCP",
    "thumbIP",
    "thumbTip",
    "indexMCP",
    "indexPIP",
    "indexDIP",
    "indexTip",
    "middleMCP",
    "middlePIP",
    "middleDIP",
    "middleTip",
    "ringMCP",
    "ringPIP",
    "ringDIP",
    "ringTip",
    "pinkyMCP",
    "pinkyPIP",
    "pinkyDIP",
    "pinkyTip"
  ];


  // MediaPipe pose landmark indices.
  const POSE_INDEX = {
    leftShoulder: 11,
    rightShoulder: 12,
    leftElbow: 13,
    rightElbow: 14,
    leftWrist: 15,
    rightWrist: 16
  };


  // Recorder state.
  const recorder = {
    recording: false,
    label: null,
    frames: []
  };


  // --------------------------------------------------
  // Calculate distance between two XYZ points.
  // --------------------------------------------------

  function distance3D(a, b) {

    const dx = a.x - b.x;
    const dy = a.y - b.y;

    const dz =
      (a.z || 0) -
      (b.z || 0);

    return Math.sqrt(
      dx * dx +
      dy * dy +
      dz * dz
    );
  }


  // --------------------------------------------------
  // Normalize one XYZ coordinate.
  //
  // Shoulder center becomes the origin.
  // Shoulder width becomes the scale.
  // --------------------------------------------------

  function normalizePoint(point, center, scale) {

    if (!point) {
      return null;
    }

    return {
      x: (point.x - center.x) / scale,
      y: (point.y - center.y) / scale,
      z: ((point.z || 0) - center.z) / scale
    };
  }


  // --------------------------------------------------
  // Normalize one hand.
  //
  // Missing hands are NOT represented by a long
  // array of zeroes in the JSON.
  //
  // Instead:
  //
  // detected: false
  // landmarks: null
  // --------------------------------------------------

  function normalizeHand(hand, center, scale) {

    if (!hand) {

      return {
        detected: false,
        landmarks: null
      };

    }


    const landmarks = {};


    for (let i = 0; i < HAND_NAMES.length; i++) {

      const point = hand[i];

      if (point) {

        landmarks[HAND_NAMES[i]] =
          normalizePoint(
            point,
            center,
            scale
          );

      }
      else {

        landmarks[HAND_NAMES[i]] = null;

      }
    }


    return {
      detected: true,
      landmarks: landmarks
    };
  }


  // --------------------------------------------------
  // Normalize the six pose landmarks we want.
  // --------------------------------------------------

  function normalizePose(pose, center, scale) {

    const normalizedPose = {};


    for (const name in POSE_INDEX) {

      const index = POSE_INDEX[name];


      if (pose && pose[index]) {

        normalizedPose[name] =
          normalizePoint(
            pose[index],
            center,
            scale
          );

      }
      else {

        normalizedPose[name] = null;

      }
    }


    return normalizedPose;
  }


  // --------------------------------------------------
  // Convert one MediaPipe result into a readable
  // training frame.
  // --------------------------------------------------

  function createReadableFrame(
    results,
    leftHand,
    rightHand,
    frameNumber
  ) {

    let pose = null;


    if (
      results.poseLandmarks &&
      results.poseLandmarks.length > 0
    ) {

      pose = results.poseLandmarks[0];

    }


    // We require the shoulders because they establish
    // the origin and scale used for normalization.
    if (
      !pose ||
      !pose[POSE_INDEX.leftShoulder] ||
      !pose[POSE_INDEX.rightShoulder]
    ) {

      return null;

    }


    const leftShoulder =
      pose[POSE_INDEX.leftShoulder];

    const rightShoulder =
      pose[POSE_INDEX.rightShoulder];


    // Midpoint between shoulders.
    const center = {

      x:
        (leftShoulder.x +
         rightShoulder.x) / 2,

      y:
        (leftShoulder.y +
         rightShoulder.y) / 2,

      z:
        ((leftShoulder.z || 0) +
         (rightShoulder.z || 0)) / 2
    };


    // Shoulder width is used to normalize scale.
    const scale =
      distance3D(
        leftShoulder,
        rightShoulder
      );


    // Prevent divide-by-zero or unusable normalization.
    if (scale < 0.0001) {

      return null;

    }


    // Human-readable frame.
    return {

      frame: frameNumber,

      leftHand:
        normalizeHand(
          leftHand,
          center,
          scale
        ),

      rightHand:
        normalizeHand(
          rightHand,
          center,
          scale
        ),

      pose:
        normalizePose(
          pose,
          center,
          scale
        )

    };
  }


  // --------------------------------------------------
  // Start a new recording.
  // --------------------------------------------------

  function startTrainingRecording(label) {

    if (
      !label ||
      label.trim() === ""
    ) {

      console.error(
        "A sign label is required."
      );

      return;
    }


    if (recorder.recording) {

      console.warn(
        "A recording is already in progress."
      );

      return;
    }


    recorder.label =
      label.trim().toUpperCase();

    recorder.frames = [];

    recorder.recording = true;


    console.log(
      "Recording sign:",
      recorder.label
    );
  }


  // --------------------------------------------------
  // Process one frame from handleResults().
  // --------------------------------------------------

  function processTrainingFrame(
    results,
    leftHand,
    rightHand
  ) {

    if (!recorder.recording) {
      return;
    }


    const frame =
      createReadableFrame(
        results,
        leftHand,
        rightHand,
        recorder.frames.length
      );


    // Missing hands are VALID.
    //
    // A frame is skipped only if the shoulders needed
    // for normalization were unavailable.
    if (!frame) {

      console.log(
        "Frame skipped: shoulders not detected."
      );

      return;
    }


    recorder.frames.push(frame);


    console.log(
      "Training frame:",
      recorder.frames.length +
      "/" +
      FRAME_COUNT,

      "| Left hand:",
      frame.leftHand.detected
        ? "detected"
        : "not detected",

      "| Right hand:",
      frame.rightHand.detected
        ? "detected"
        : "not detected"
    );


    if (
      recorder.frames.length >= FRAME_COUNT
    ) {

      finishRecording();

    }
  }


  // --------------------------------------------------
  // Finish recording and create the sample.
  // --------------------------------------------------

  function finishRecording() {

    recorder.recording = false;


    let leftHandFrames = 0;
    let rightHandFrames = 0;


    // Count how often each hand was detected.
    for (
      let i = 0;
      i < recorder.frames.length;
      i++
    ) {

      if (
        recorder.frames[i]
          .leftHand.detected
      ) {

        leftHandFrames++;

      }


      if (
        recorder.frames[i]
          .rightHand.detected
      ) {

        rightHandFrames++;

      }
    }


    // IMPORTANT:
    //
    // Keep the existing top-level naming convention.
    //
    // sample.label
    // sample.frames
    // sample.sequenceLength
    //
    // Existing files such as storage.js can therefore
    // continue referencing these properties.
    const sample = {

      label:
        recorder.label,

      formatVersion: 2,

      landmarkFormat:
        "hands-arms-v2",

      normalized: true,

      sequenceLength:
        recorder.frames.length,

      createdAt:
        new Date().toISOString(),

      normalization:
        "shoulder-centered-v1",

      detectionSummary: {

        leftHandFrames:
          leftHandFrames,

        rightHandFrames:
          rightHandFrames,

        totalFrames:
          recorder.frames.length

      },

      frames:
        recorder.frames

    };


    console.log(
      "Training sample complete:",
      sample
    );


    console.log(
      "Left hand detected:",
      leftHandFrames +
      "/" +
      recorder.frames.length
    );


    console.log(
      "Right hand detected:",
      rightHandFrames +
      "/" +
      recorder.frames.length
    );


    // Keep using the original storage function.
    saveTrainingSample(sample);


    recorder.frames = [];
  }


  // --------------------------------------------------
  // Cancel current recording.
  // --------------------------------------------------

  function cancelTrainingRecording() {

    recorder.recording = false;

    recorder.frames = [];


    console.log(
      "Training recording cancelled."
    );
  }


  // --------------------------------------------------
  // Return current recorder status.
  // --------------------------------------------------

  function getStatus() {

    return {

      recording:
        recorder.recording,

      label:
        recorder.label,

      frames:
        recorder.frames.length,

      targetFrames:
        FRAME_COUNT

    };
  }


  // --------------------------------------------------
  // Public interface.
  //
  // Keep the same TrainingRecorder names so live.js
  // does not need to change.
  // --------------------------------------------------

 
    window.TrainingRecorder = {
        start: startTrainingRecording,
        processFrame: processTrainingFrame,
        cancel: cancelTrainingRecording,
        status: getStatus,
    
        // Allow live LSTM inference to reuse
        // the existing normalization function.
        createReadableFrame: createReadableFrame
    };


})();