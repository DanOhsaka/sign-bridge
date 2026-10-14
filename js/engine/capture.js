/* ============================================================
   SignBridge — Landmark sequence capture (capture.js)
   ------------------------------------------------------------
   Collects per-frame feature vectors from the live MediaPipe
   pipeline for offline LSTM / TCN training (see docs/MODELS.md).

   One training *sample* = one performed sign (or letter), stored
   as a variable-length sequence of 63-float vectors:

     sample.frames[0]  → frame at t=0  (21 landmarks × x,y,z)
     sample.frames[1]  → frame at t=1
     …
     sample.length     → number of frames (timesteps for the LSTM)

   Do NOT append every frame into one endless array across many
   signs — call startRecording(label) before each take and
   stopRecording() when the sign finishes so each sample stays
   isolated and labeled.

   Export format (JSON):
     {
       "version": 1,
       "featureDim": 63,
       "featureSpec": "MediaPipe Hands, bbox-normalized x/y, wrist-relative z",
       "samples": [
         { "label": "A", "length": 42, "frames": [[...63], ...], "recordedAt": "..." }
       ]
     }

   Wired from js/engine/live.js on every frame where a hand is
   detected while recording is active (no classifier required).
   ============================================================ */

window.SB = window.SB || {};

SB.DataCapture = (function () {
  /** Matches Float32Array length from live.js landmarkVector(). */
  var FEATURE_DIM = 63;

  /** Finished labeled sequences — this is what you download for Python/TF. */
  var dataset = [];

  /** True while the user is performing one sign; frames go to _sequence. */
  var recording = false;

  /** Class label for the current take (e.g. letter "A" or phrase id "hello"). */
  var currentLabel = "";

  /**
   * In-progress frames for the *current* recording only.
   * Reset on startRecording; copied into dataset on stopRecording.
   */
  var _sequence = [];

  /** Optional hook for UI (frame count updates). fn({ frameCount, recording, label }) */
  var onProgress = null;

  /**
   * Convert one frame's features to a plain array so JSON.stringify works.
   * LSTM input row: length FEATURE_DIM (63).
   */
  function featsToRow(feats) {
    if (feats instanceof Float32Array || Array.isArray(feats)) {
      return Array.prototype.slice.call(feats, 0, FEATURE_DIM);
    }
    return [];
  }

  return {
    FEATURE_DIM: FEATURE_DIM,

    /** Whether a recording session is in progress. */
    isRecording: function () {
      return recording;
    },

    /** Number of completed samples in memory (not including in-progress). */
    getSampleCount: function () {
      return dataset.length;
    },

    /** Frames captured so far in the current take (live counter for UI). */
    getCurrentFrameCount: function () {
      return _sequence.length;
    },

    getCurrentLabel: function () {
      return currentLabel;
    },

    /** Read-only snapshot of finished samples (for debugging in console). */
    getDataset: function () {
      return dataset.slice();
    },

    /**
     * Register a callback fired after each captured frame while recording.
     * Used by the Translate view to refresh frame counters without polling.
     */
    setProgressListener: function (fn) {
      onProgress = typeof fn === "function" ? fn : null;
    },

    /**
     * Begin a new labeled take. Clears the in-progress sequence.
     * @param {string} label — class name for this sign (trimmed, required)
     */
    startRecording: function (label) {
      label = String(label || "").trim();
      if (!label) {
        throw new Error("DataCapture: label is required (e.g. A, HELLO).");
      }
      currentLabel = label;
      _sequence = [];
      recording = true;
      if (onProgress) {
        onProgress({ frameCount: 0, recording: true, label: currentLabel });
      }
    },

    /**
     * Called once per video frame while a hand is visible (from live.js).
     * Pushes one timestep onto the current sequence — your processFrame hook.
     *
     * @param {Float32Array|number[]} feats — 63 normalized floats from landmarkVector()
     */
    processFrame: function (feats) {
      if (!recording) return;
      var row = featsToRow(feats);
      if (row.length !== FEATURE_DIM) return;
      _sequence.push(row);
      if (onProgress) {
        onProgress({
          frameCount: _sequence.length,
          recording: true,
          label: currentLabel
        });
      }
    },

    /**
     * End the current take and append a labeled sample to the dataset.
     * @param {object} [opts]
     * @param {number} [opts.minFrames=8] — reject empty/accidental taps
     * @returns {{ ok: boolean, message?: string, sample?: object }}
     */
    stopRecording: function (opts) {
      opts = opts || {};
      var minFrames = typeof opts.minFrames === "number" ? opts.minFrames : 8;

      if (!recording) {
        return { ok: false, message: "Not recording." };
      }

      recording = false;
      var frames = _sequence.slice();
      _sequence = [];

      if (frames.length < minFrames) {
        if (onProgress) {
          onProgress({ frameCount: 0, recording: false, label: currentLabel });
        }
        return {
          ok: false,
          message: "Too few frames (" + frames.length + "). Hold the sign longer (need ≥ " + minFrames + ")."
        };
      }

      var sample = {
        label: currentLabel,
        length: frames.length,
        frames: frames,
        recordedAt: new Date().toISOString()
      };
      dataset.push(sample);

      if (onProgress) {
        onProgress({ frameCount: 0, recording: false, label: currentLabel });
      }

      return { ok: true, sample: sample };
    },

    /** Discard in-progress frames without saving. */
    cancelRecording: function () {
      recording = false;
      _sequence = [];
      if (onProgress) {
        onProgress({ frameCount: 0, recording: false, label: currentLabel });
      }
    },

    /** Remove all finished samples from memory (does not affect downloads already saved). */
    clearDataset: function () {
      dataset = [];
      if (onProgress) {
        onProgress({ frameCount: _sequence.length, recording: recording, label: currentLabel });
      }
    },

    /**
     * Trigger a browser download of the dataset as JSON for LSTM training scripts.
     * Each sample.frames is shape (T, 63) with variable T per sample.
     */
    downloadJSON: function (filename) {
      if (!dataset.length) {
        return { ok: false, message: "No samples to export." };
      }

      var payload = {
        version: 1,
        featureDim: FEATURE_DIM,
        featureSpec: "MediaPipe Hands: x/y normalized to hand bbox, z relative to wrist (see js/engine/live.js)",
        sampleCount: dataset.length,
        samples: dataset
      };

      var name = filename || ("signbridge-landmarks-" + dataset.length + "-samples.json");
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      return { ok: true, sampleCount: dataset.length };
    }
  };
})();
