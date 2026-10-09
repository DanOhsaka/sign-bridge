// training/landmarks.js

(function () {

  // Pose landmarks that we want for the LSTM.
  var POSE_POINTS = [11, 12, 13, 14, 15, 16];

  function addPoint(vector, point) {
    if (point) {
      vector.push(point.x);
      vector.push(point.y);
      vector.push(point.z || 0);
    } else {
      // Missing landmark still needs three values so
      // every frame stays the same size.
      vector.push(0, 0, 0);
    }
  }

  function addHand(vector, hand) {
    for (var i = 0; i < 21; i++) {
      if (hand && hand[i]) {
        addPoint(vector, hand[i]);
      } else {
        addPoint(vector, null);
      }
    }
  }

  function extractTrainingLandmarks(results, leftHand, rightHand) {
    var vector = [];

    // 21 left-hand landmarks.
    addHand(vector, leftHand);

    // 21 right-hand landmarks.
    addHand(vector, rightHand);

    // Holistic returns pose detections as an array.
    var pose = null;

    if (
      results.poseLandmarks &&
      results.poseLandmarks.length > 0
    ) {
      pose = results.poseLandmarks[0];
    }

    // Shoulders, elbows and wrists.
    for (var i = 0; i < POSE_POINTS.length; i++) {
      var index = POSE_POINTS[i];

      if (pose && pose[index]) {
        addPoint(vector, pose[index]);
      } else {
        addPoint(vector, null);
      }
    }

    return vector;
  }

  window.extractTrainingLandmarks =
    extractTrainingLandmarks;

})();