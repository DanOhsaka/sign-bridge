/* ============================================================
   SignBridge — Built-in handshape classifier (heuristic)
   ------------------------------------------------------------
   Drops into SB.LiveEngine.setClassifier when no trained model
   is attached. Uses the same Float32Array(63) landmarkVector
   contract (bbox-normalized x,y + wrist-relative z).

   Goal: Live mode must emit transcript tokens from HandLandmarker
   alone (no Holistic / LSTM API required). This is a teaching
   heuristic for static ASL letters — not a production SLR model.
   Swap in a trained model via setClassifier() anytime.
   ============================================================ */

window.SB = window.SB || {};

window.SB.HandshapeClassifier = (function () {
  "use strict";

  /* MediaPipe 21-point indices */
  var WRIST = 0;
  var TH_CMC = 1, TH_MCP = 2, TH_IP = 3, TH_TIP = 4;
  var IX_MCP = 5, IX_PIP = 6, IX_DIP = 7, IX_TIP = 8;
  var MD_MCP = 9, MD_PIP = 10, MD_DIP = 11, MD_TIP = 12;
  var RG_MCP = 13, RG_PIP = 14, RG_DIP = 15, RG_TIP = 16;
  var PK_MCP = 17, PK_PIP = 18, PK_DIP = 19, PK_TIP = 20;

  var MIN_CONF = 0.55;

  function pt(feats, i) {
    return {
      x: feats[i * 3],
      y: feats[i * 3 + 1],
      z: feats[i * 3 + 2],
    };
  }

  function dist(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y, dz = (a.z || 0) - (b.z || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz * 0.35);
  }

  /** Tip farther from wrist than MCP → extended (image y grows down). */
  function extended(feats, mcpI, tipI) {
    var w = pt(feats, WRIST);
    var mcp = pt(feats, mcpI);
    var tip = pt(feats, tipI);
    return dist(w, tip) > dist(w, mcp) * 1.18;
  }

  function curled(feats, mcpI, tipI) {
    var w = pt(feats, WRIST);
    var mcp = pt(feats, mcpI);
    var tip = pt(feats, tipI);
    return dist(w, tip) < dist(w, mcp) * 1.08;
  }

  function fingerBits(feats) {
    return {
      th: extended(feats, TH_MCP, TH_TIP),
      ix: extended(feats, IX_MCP, IX_TIP),
      md: extended(feats, MD_MCP, MD_TIP),
      rg: extended(feats, RG_MCP, RG_TIP),
      pk: extended(feats, PK_MCP, PK_TIP),
      thC: curled(feats, TH_MCP, TH_TIP),
      ixC: curled(feats, IX_MCP, IX_TIP),
      mdC: curled(feats, MD_MCP, MD_TIP),
      rgC: curled(feats, RG_MCP, RG_TIP),
      pkC: curled(feats, PK_MCP, PK_TIP),
    };
  }

  function tipSpread(feats, a, b) {
    return dist(pt(feats, a), pt(feats, b));
  }

  /**
   * Score static ASL letter handshapes. Returns best match or null.
   * @param {Float32Array} feats length 63
   * @returns {{text:string, conf:number, alt?:string[], glyph?:string}|null}
   */
  function classifyOnce(feats) {
    if (!feats || feats.length < 63) return null;
    var f = fingerBits(feats);
    var candidates = [];

    function add(letter, score, alts, glyph) {
      if (score < MIN_CONF) return;
      candidates.push({
        text: letter,
        conf: Math.min(0.96, score),
        alt: alts || [],
        glyph: glyph || "",
      });
    }

    /* V — index + middle up, spread */
    if (f.ix && f.md && f.rgC && f.pkC) {
      var spreadV = tipSpread(feats, IX_TIP, MD_TIP);
      add("V", 0.62 + Math.min(0.28, spreadV * 1.4), ["U", "2"], "✌️");
    }

    /* U — index + middle up, together */
    if (f.ix && f.md && f.rgC && f.pkC) {
      var closeU = tipSpread(feats, IX_TIP, MD_TIP);
      if (closeU < 0.18) add("U", 0.7 + (0.18 - closeU), ["V", "H"], "");
    }

    /* W — three fingers up */
    if (f.ix && f.md && f.rg && f.pkC) {
      add("W", 0.78, ["3", "B"], "");
    }

    /* B — four fingers up, thumb tucked-ish */
    if (f.ix && f.md && f.rg && f.pk && !f.th) {
      add("B", 0.8, ["4"], "");
    }

    /* Open 5 / Hello-ish open hand */
    if (f.ix && f.md && f.rg && f.pk && f.th) {
      add("5", 0.72, ["B", "Hello"], "🖐️");
    }

    /* D / 1 — index up only */
    if (f.ix && f.mdC && f.rgC && f.pkC) {
      add("D", 0.74, ["1", "X"], "");
    }

    /* I — pinky up */
    if (f.pk && f.ixC && f.mdC && f.rgC) {
      add("I", 0.76, ["J", "Y"], "");
    }

    /* Y — thumb + pinky */
    if (f.th && f.pk && f.ixC && f.mdC && f.rgC) {
      add("Y", 0.8, ["I"], "🤙");
    }

    /* L — thumb + index L */
    if (f.th && f.ix && f.mdC && f.rgC && f.pkC) {
      add("L", 0.78, ["G"], "");
    }

    /* F — thumb+index pinch, other three up */
    if (f.md && f.rg && f.pk && !f.ix) {
      var pinch = tipSpread(feats, TH_TIP, IX_TIP);
      if (pinch < 0.16) add("F", 0.7 + (0.16 - pinch), ["D", "9"], "👌");
    }

    /* A / S / fist — all fingers curled */
    if (f.ixC && f.mdC && f.rgC && f.pkC) {
      var thTip = pt(feats, TH_TIP);
      var ixMcp = pt(feats, IX_MCP);
      var thAlong = dist(thTip, ixMcp);
      if (f.th && thAlong < 0.22) add("A", 0.7, ["S", "T"], "✊");
      else if (!f.th) add("S", 0.68, ["A", "T"], "✊");
      else add("A", 0.6, ["S"], "✊");
    }

    /* O — tips clustered near thumb */
    if (!f.ix && !f.md && !f.rg && !f.pk) {
      var cluster =
        tipSpread(feats, TH_TIP, IX_TIP) +
        tipSpread(feats, TH_TIP, MD_TIP) +
        tipSpread(feats, TH_TIP, RG_TIP);
      if (cluster < 0.45) add("O", 0.66 + (0.45 - cluster) * 0.5, ["C", "E"], "");
    }

    /* C — open curve (index/middle somewhat extended, tips apart from thumb) */
    if (!f.ixC && !f.mdC && tipSpread(feats, TH_TIP, IX_TIP) > 0.2) {
      if (!f.pk || f.rg) add("C", 0.58, ["O"], "");
    }

    if (!candidates.length) return null;
    candidates.sort(function (a, b) { return b.conf - a.conf; });
    var best = candidates[0];
    if (candidates[1] && candidates[1].conf > best.conf - 0.08) {
      best.alt = [candidates[1].text].concat(best.alt || []).slice(0, 3);
      best.conf = Math.max(MIN_CONF, best.conf - 0.06);
    }
    best.source = "live";
    return best;
  }

  /** Public classifier entry — matches setClassifier(fn) contract. */
  function classify(feats) {
    try {
      return classifyOnce(feats);
    } catch (err) {
      console.warn("HandshapeClassifier:", err);
      return null;
    }
  }

  return {
    classify: classify,
    kind: "handshape-heuristic",
    label: "Built-in handshapes",
  };
})();
