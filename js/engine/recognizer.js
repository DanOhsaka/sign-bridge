/* ============================================================
   SignBridge — Recognizer facade (recognizer.js)
   ------------------------------------------------------------
   THE seam between UI and model.

   The whole UI talks to SB.Engine and nothing else. Today it
   routes to the simulated engine (SB.SimEngine) so the product
   is fully demonstrable before a trained model exists. When
   your MediaPipe + classifier pipeline is ready, you either:
     1. point `SB.LiveEngine.setClassifier(fn)` at your model,
     2. or swap the routing below — the UI won't know the
        difference. This is deliberate architecture: the
        capstone demo and the capstone model are decoupled.

   Token shape passed to every UI consumer:
     { text, conf (0..1), alt: [strings], glyph?: emoji, source: 'demo'|'live' }
   ============================================================ */

window.SB = window.SB || {};

SB.Engine = (function () {
  var mode = "demo";            // 'demo' | 'live'
  var listeners = { hands: [], status: [], result: [] };
  var sim = null;               // SB.SimEngine (lazy)
  var live = null;              // SB.LiveEngine (lazy)

  function simEngine() {
    if (!sim) sim = new SB.SimEngine();
    return sim;
  }
  function liveEngine() {
    if (!live) live = new SB.LiveEngine();
    return live;
  }

  function emit(evt) {
    var args = Array.prototype.slice.call(arguments, 1);
    (listeners[evt] || []).forEach(function (fn) { try { fn.apply(null, args); } catch (e) { console.error(e); } });
  }

  return {
    /* ---- mode switching ---- */
    getMode: function () { return mode; },

    setMode: function (m, opts) {
      m = m === "live" ? "live" : "demo";
      if (m === mode) return Promise.resolve(mode);
      if (m === "demo" && live) live.stop();
      mode = m;
      if (m === "live") {
        return liveEngine().start(opts).then(function () {
          emit("status", { mode: "live", level: "ok" });
          return mode;
        }).catch(function (err) {
          mode = "demo"; // roll back on failure (no camera etc.)
          emit("status", { mode: "demo", level: "error", message: err && err.message });
          throw err;
        });
      }
      emit("status", { mode: "demo", level: "ok" });
      return Promise.resolve(mode);
    },

    /* ---- events ---- */
    on: function (evt, fn) {
      if (!listeners[evt]) listeners[evt] = [];
      listeners[evt].push(fn);
    },

    /* ---- live-mode internals (called by SB.LiveEngine) ---- */
    _hands: function (count) { emit("hands", count); },
    _result: function (token) { emit("result", token); },

    /* ---- access to the live engine (single instance) ---- */
    getLiveEngine: function () { return liveEngine(); },

    /* ---- demo-mode signing (simulated) ---- */
    signPhrase: function (phraseId, onToken) {
      return simEngine().signPhrase(phraseId, function (tok) {
        onToken(Object.assign({ source: "demo" }, tok));
      });
    },

    signTokens: function (tokens, onToken) {
      return simEngine().signTokens(tokens, function (tok) {
        onToken(Object.assign({ source: "demo" }, tok));
      });
    },

    signLetter: function (letter, onToken) {
      return simEngine().signLetter(letter, function (tok) {
        onToken(Object.assign({ source: "demo" }, tok));
      });
    },

    signDemo: function (onToken) {
      return simEngine().signTokens(SB.DEMO_SENTENCE, function (tok) {
        onToken(Object.assign({ source: "demo" }, tok));
      });
    },
  };
})();
