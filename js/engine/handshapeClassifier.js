/* ============================================================
   SignBridge — Live gloss helper (DISABLED by default)
   ------------------------------------------------------------
   The experimental landmark→Hello/Yes/Peace heuristic produced
   wrong signs in real Live sessions. It is no longer auto-
   attached. Live returns to pre-PR-18 behavior: landmarks +
   Demo/simulated accuracy for transcript words, or a real
   setClassifier / Holistic LSTM when provided.

   Kept as a no-op stub so older cache-bust URLs don't 404 mid-
   session. Call SB.LiveEngine.setClassifier(yourModel) for real
   recognition.
   ============================================================ */

window.SB = window.SB || {};

window.SB.HandshapeClassifier = (function () {
  "use strict";

  function classify(/* feats */) {
    /* Intentionally inert — do not invent glosses from landmarks. */
    return null;
  }

  function reset() {}

  return {
    classify: classify,
    reset: reset,
    kind: "disabled",
    label: "Disabled (use Demo or trained classifier)",
  };
})();

window.SB.LiveGlossRecognizer = window.SB.HandshapeClassifier;
