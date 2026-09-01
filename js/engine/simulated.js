/* ============================================================
   SignBridge — Simulated recognizer (simulated.js)
   ------------------------------------------------------------
   A stand-in for the trained model, built to feel REAL.

   Why: at capstone checkpoints (and before the model is
   trained), the team needs the full product experience — the
   streaming transcript, confidence behaviour, near-miss
   suggestions. The simulator produces the same token stream a
   MediaPipe + classifier pipeline will later emit, including:

     • per-word confidence (jittered, sometimes low)
     • alternates on low-confidence words (from SB.CONFUSIONS,
       which mirror documented ASL confusions — A/S/T, U/V, …)
     • realistic human reading pace

   Swap source: "demo" becomes "live" transparently when the
   real engine routes through (see recognizer.js).
   ============================================================ */

window.SB = window.SB || {};

SB.SimEngine = function () {
  var self = this;
  var running = false;

  /* jittered confidence: base + randomness, clamped */
  function confFor(base) {
    var j = base + (Math.random() * 0.06 - 0.03);
    return Math.max(0.45, Math.min(0.99, +j.toFixed(2)));
  }

  /* ~7% of words drop to low confidence and offer alternates */
  function tokenizeWord(word) {
    var conf = confFor(0.94);
    var alt = null;

    if (Math.random() < 0.07) {
      var key = word.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/\s+/g, "-");
      var pool = SB.CONFUSIONS[word] || SB.CONFUSIONS[key] || null;
      if (pool) {
        conf = confFor(0.62);
        alt = pool.slice(0, 2);
      }
    }
    return { text: word, conf: conf, alt: alt };
  }

  function delay(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  /* pace: 320–680ms per token — reads like live inference */
  function pace() { return 320 + Math.random() * 360; }

  self.signTokens = function (tokens, onToken) {
    running = true;
    return (async function () {
      for (var i = 0; i < tokens.length && running; i++) {
        var t = tokens[i];
        var tok = {
          text: t.text,
          conf: t.conf !== undefined ? t.conf : confFor(0.94),
          alt: t.alt || null,
          glyph: t.glyph || null,
        };
        if (t.alt && t.conf !== undefined && Math.random() < 0.25) {
          // occasionally the "model" reads high on a word the demo
          // marked as tricky — keeps the demo from being scripted.
          tok.conf = confFor(0.88);
        }
        onToken(tok);
        await delay(t.conf !== undefined && t.conf < 0.7 ? pace() + 160 : pace());
      }
    })();
  };

  self.signPhrase = function (phraseId, onToken) {
    var p = SB.PHRASE_MAP[phraseId];
    if (!p) return Promise.resolve();
    var words = p.name.split(/[?!/]/).filter(Boolean).map(function (w) {
      return tokenizeWord(w.trim());
    });
    return self.signTokens(words, onToken);
  };

  self.signLetter = function (letter, onToken) {
    var tok = { text: letter, conf: confFor(0.97), alt: null };
    if (Math.random() < 0.12) {
      // simulate the classic near-misses of real recognizers
      var confs = SB.CONFUSIONS[letter];
      if (confs && confs.length) {
        tok.conf = confFor(0.6);
        tok.alt = confs.slice(0, 2);
      }
    }
    onToken(tok);
    return Promise.resolve();
  };

  self.stop = function () { running = false; };
};
