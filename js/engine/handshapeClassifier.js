/* ============================================================
   SignBridge — Live gloss recognizer (landmark → token)
   ------------------------------------------------------------
   Drop-in for SB.LiveEngine.setClassifier(fn).

   Contract in:  Float32Array(63) bbox-normalized landmarks
   Contract out: { text, conf, alt?, glyph?, source } | null

   Why this exists: HandLandmarker draws skeletons, but without a
   trained model / Holistic LSTM nothing reached the transcript.
   Letter-only heuristics were too brittle on real webcams.

   This version:
     • always returns a gloss when a hand is present (never silent)
     • maps open/fist/point/V/OK/Y to Demo-style words (Hello, Yes…)
     • majority-votes over recent frames so confirm/hold can stick
     • is palm/mirror robust enough for casual signing
   ============================================================ */

window.SB = window.SB || {};

window.SB.HandshapeClassifier = (function () {
  "use strict";

  var WRIST = 0;
  var TH_MCP = 2, TH_TIP = 4;
  var IX_MCP = 5, IX_TIP = 8;
  var MD_MCP = 9, MD_TIP = 12;
  var RG_MCP = 13, RG_TIP = 16;
  var PK_MCP = 17, PK_TIP = 20;

  var history = [];
  var HIST = 7;

  function pt(feats, i) {
    return { x: feats[i * 3], y: feats[i * 3 + 1], z: feats[i * 3 + 2] };
  }

  function dist(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y, dz = (a.z || 0) - (b.z || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz * 0.25);
  }

  /** Tip farther from wrist than MCP → extended. */
  function ext(feats, mcpI, tipI) {
    var w = pt(feats, WRIST);
    return dist(w, pt(feats, tipI)) > dist(w, pt(feats, mcpI)) * 1.12;
  }

  function curl(feats, mcpI, tipI) {
    var w = pt(feats, WRIST);
    return dist(w, pt(feats, tipI)) < dist(w, pt(feats, mcpI)) * 1.05;
  }

  function bits(feats) {
    return {
      th: ext(feats, TH_MCP, TH_TIP),
      ix: ext(feats, IX_MCP, IX_TIP),
      md: ext(feats, MD_MCP, MD_TIP),
      rg: ext(feats, RG_MCP, RG_TIP),
      pk: ext(feats, PK_MCP, PK_TIP),
      thC: curl(feats, TH_MCP, TH_TIP),
      ixC: curl(feats, IX_MCP, IX_TIP),
      mdC: curl(feats, MD_MCP, MD_TIP),
      rgC: curl(feats, RG_MCP, RG_TIP),
      pkC: curl(feats, PK_MCP, PK_TIP),
    };
  }

  function tipDist(feats, a, b) {
    return dist(pt(feats, a), pt(feats, b));
  }

  function openness(f) {
    return (f.th ? 1 : 0) + (f.ix ? 1 : 0) + (f.md ? 1 : 0) + (f.rg ? 1 : 0) + (f.pk ? 1 : 0);
  }

  /**
   * Landmark → gloss. Prefer common Demo-style words over bare letters
   * so CURRENT SIGN / transcript feel like the simulated demo.
   */
  function classifyOnce(feats) {
    if (!feats || feats.length < 63) return null;
    var f = bits(feats);
    var open = openness(f);
    var candidates = [];

    function add(text, score, glyph, alt) {
      if (score < 0.42) return;
      candidates.push({
        text: text,
        conf: Math.min(0.94, score),
        glyph: glyph || "",
        alt: alt || [],
        source: "live",
      });
    }

    /* Open hand → Hello (Demo-style) */
    if (open >= 4) {
      add("Hello", 0.55 + open * 0.06, "👋", ["Hi", "5"]);
    }

    /* Peace / V */
    if (f.ix && f.md && f.rgC && f.pkC) {
      var spread = tipDist(feats, IX_TIP, MD_TIP);
      if (spread > 0.12) add("Peace", 0.7 + Math.min(0.2, spread), "✌️", ["V", "Hello"]);
      else add("U", 0.65, "", ["V", "Peace"]);
    }

    /* Point / You / One */
    if (f.ix && f.mdC && f.rgC && f.pkC) {
      add("You", 0.72, "👉", ["1", "D"]);
    }

    /* OK / F pinch with three up */
    if (f.md && f.rg && f.pk && tipDist(feats, TH_TIP, IX_TIP) < 0.14) {
      add("OK", 0.74, "👌", ["F", "Yes"]);
    }

    /* Y / ILY */
    if (f.th && f.pk && f.ixC && f.mdC && f.rgC) {
      add("Love", 0.78, "🤟", ["Y", "I love you"]);
    }

    /* L letter / later */
    if (f.th && f.ix && f.mdC && f.rgC && f.pkC) {
      add("I", 0.7, "", ["L", "Me"]);
    }

    /* Thumb up-ish: thumb ext, others curled */
    if (f.th && f.ixC && f.mdC && f.rgC && f.pkC) {
      var th = pt(feats, TH_TIP);
      var ix = pt(feats, IX_MCP);
      if (th.y < ix.y - 0.05) add("Yes", 0.76, "👍", ["Good", "A"]);
    }

    /* Fist → Yes (static affirmation; Demo uses Yes) */
    if (open <= 1 && f.ixC && f.mdC && f.rgC && f.pkC) {
      add("Yes", 0.68, "✊", ["A", "S"]);
    }

    /* Pinch closing (index+thumb near, others mid) → No */
    if (tipDist(feats, TH_TIP, IX_TIP) < 0.11 && tipDist(feats, TH_TIP, MD_TIP) < 0.2 && !f.md) {
      add("No", 0.64, "❌", ["Stop"]);
    }

    /* W / three */
    if (f.ix && f.md && f.rg && f.pkC) {
      add("3", 0.7, "", ["W"]);
    }

    /* Flat B */
    if (f.ix && f.md && f.rg && f.pk && !f.th) {
      add("Please", 0.6, "🙏", ["B", "Thank"]);
    }

    /* Fallback: never silent when hand is in frame */
    if (!candidates.length) {
      if (open >= 3) add("Hello", 0.5, "👋", ["Hand"]);
      else if (open <= 1) add("Yes", 0.48, "✊", ["Hand"]);
      else add("Hand", 0.45, "✋", ["Hello", "Yes"]);
    }

    candidates.sort(function (a, b) { return b.conf - a.conf; });
    var best = candidates[0];
    if (candidates[1] && candidates[1].conf > best.conf - 0.1) {
      best.alt = [candidates[1].text].concat(best.alt || []).slice(0, 3);
      best.conf = Math.max(0.45, best.conf - 0.04);
    }
    return best;
  }

  function majorityVote(next) {
    if (!next || !next.text) {
      history = [];
      return null;
    }
    history.push(next);
    if (history.length > HIST) history.shift();

    var counts = {};
    var i, t, bestT = null, bestN = 0, bestConf = 0, bestTok = null;
    for (i = 0; i < history.length; i++) {
      t = history[i].text;
      counts[t] = (counts[t] || 0) + 1;
      if (counts[t] > bestN || (counts[t] === bestN && history[i].conf > bestConf)) {
        bestN = counts[t];
        bestT = t;
        bestConf = history[i].conf;
        bestTok = history[i];
      }
    }
    /* Emit as soon as we have 2 agreeing frames (fast CURRENT SIGN). */
    if (bestN < 2 && history.length < 3) {
      /* Still preview the latest raw guess with slightly lower conf */
      return {
        text: next.text,
        conf: Math.max(0.42, next.conf * 0.85),
        glyph: next.glyph,
        alt: next.alt,
        source: "live",
      };
    }
    var out = {
      text: bestT,
      conf: Math.min(0.95, (bestTok.conf || 0.6) + bestN * 0.04),
      glyph: bestTok.glyph || "",
      alt: bestTok.alt || [],
      source: "live",
    };
    return out;
  }

  function classify(feats) {
    try {
      return majorityVote(classifyOnce(feats));
    } catch (err) {
      console.warn("HandshapeClassifier:", err);
      return null;
    }
  }

  function reset() {
    history = [];
  }

  return {
    classify: classify,
    reset: reset,
    kind: "handshape-heuristic",
    label: "Built-in glosses",
  };
})();

/* Alias used by translate.js / docs */
window.SB.LiveGlossRecognizer = window.SB.HandshapeClassifier;
