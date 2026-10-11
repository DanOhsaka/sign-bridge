// training/normalize.js

(function () {

  function distance3D(a, b) {
    var dx = a.x - b.x;
    var dy = a.y - b.y;
    var dz = a.z - b.z;

    return Math.sqrt(
      dx * dx +
      dy * dy +
      dz * dz
    );
  }

  function normalizeTrainingVector(vector) {

    if (!vector || vector.length !== 144) {
      return null;
    }

    var output = vector.slice();

    // Layout:
    // left hand  = values 0-62
    // right hand = values 63-125
    // pose       = values 126-143
    //
    // First two pose points are:
    // left shoulder  = 126,127,128
    // right shoulder = 129,130,131

    var leftShoulder = {
      x: vector[126],
      y: vector[127],
      z: vector[128]
    };

    var rightShoulder = {
      x: vector[129],
      y: vector[130],
      z: vector[131]
    };

    // If shoulder tracking failed, don't use this frame.
    if (
      (leftShoulder.x === 0 &&
       leftShoulder.y === 0) ||
      (rightShoulder.x === 0 &&
       rightShoulder.y === 0)
    ) {
      return null;
    }

    // Body origin = midpoint between shoulders.
    var centerX =
      (leftShoulder.x + rightShoulder.x) / 2;

    var centerY =
      (leftShoulder.y + rightShoulder.y) / 2;

    var centerZ =
      (leftShoulder.z + rightShoulder.z) / 2;

    // Scale according to shoulder width.
    var scale = distance3D(
      leftShoulder,
      rightShoulder
    );

    if (scale < 0.0001) {
      return null;
    }

    // Normalize every x/y/z group.
    for (var i = 0; i < output.length; i += 3) {

      // Preserve missing landmarks.
      if (
        output[i] === 0 &&
        output[i + 1] === 0 &&
        output[i + 2] === 0
      ) {
        continue;
      }

      output[i] =
        (output[i] - centerX) / scale;

      output[i + 1] =
        (output[i + 1] - centerY) / scale;

      output[i + 2] =
        (output[i + 2] - centerZ) / scale;
    }

    return output;
  }

  window.normalizeTrainingVector =
    normalizeTrainingVector;

})();