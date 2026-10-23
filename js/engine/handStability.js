/* ============================================================
   SignBridge — Hand identity + landmark validity (handStability.js)
   Keeps skeleton shape stable without heavy moving averages.
   Dev-only jump counters feed the perf HUD.
   ============================================================ */

window.SB = window.SB || {};

/** Palm / finger bone pairs used for length sanity checks (MediaPipe 21). */
SB.HAND_BONE_PAIRS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17],
];

SB._dist2 = function (a, b) {
  var dx = a.x - b.x;
  var dy = a.y - b.y;
  return dx * dx + dy * dy;
};

SB._dist = function (a, b) {
  return Math.sqrt(SB._dist2(a, b));
};

SB.palmCenter = function (lms) {
  if (!lms || !lms.length) return null;
  /* Wrist + index/middle/pinky MCP — stable under finger wiggle */
  var idxs = [0, 5, 9, 13, 17];
  var x = 0, y = 0, n = 0;
  for (var i = 0; i < idxs.length; i++) {
    var p = lms[idxs[i]];
    if (!p) continue;
    x += p.x;
    y += p.y;
    n++;
  }
  if (!n) return { x: lms[0].x, y: lms[0].y };
  return { x: x / n, y: y / n };
};

SB.handScale = function (lms) {
  if (!lms || !lms[0] || !lms[9]) return 0;
  return Math.max(1e-4, SB._dist(lms[0], lms[9]));
};

/**
 * Validate a 21-point hand against the last good pose.
 * @returns {{ ok: boolean, reason?: string, jump?: number }}
 */
SB.validateHandLandmarks = function (lms, lastGood, opts) {
  opts = opts || {};
  if (!lms || lms.length < 21) return { ok: false, reason: "short" };

  for (var i = 0; i < 21; i++) {
    var p = lms[i];
    if (!p || !isFinite(p.x) || !isFinite(p.y)) {
      return { ok: false, reason: "nan" };
    }
    if (p.x < -0.35 || p.x > 1.35 || p.y < -0.35 || p.y > 1.35) {
      return { ok: false, reason: "oob" };
    }
  }

  var scale = SB.handScale(lms);
  if (scale < 0.015 || scale > 0.95) {
    return { ok: false, reason: "scale" };
  }

  /* Bone lengths relative to palm scale — reject spaghetti frames */
  var badBones = 0;
  for (var b = 0; b < SB.HAND_BONE_PAIRS.length; b++) {
    var a = SB.HAND_BONE_PAIRS[b];
    var len = SB._dist(lms[a[0]], lms[a[1]]) / scale;
    if (len > 2.8 || len < 0.02) badBones++;
  }
  if (badBones >= 4) return { ok: false, reason: "bones" };

  if (lastGood && lastGood.length >= 21) {
    var c0 = SB.palmCenter(lastGood);
    var c1 = SB.palmCenter(lms);
    var jump = SB._dist(c0, c1);
    var maxJump = opts.maxPalmJump != null ? opts.maxPalmJump : 0.22;
    if (jump > maxJump) {
      return { ok: false, reason: "palmJump", jump: jump };
    }

    /* Per-tip jump relative to scale — catches finger teleport */
    var tipIdx = [4, 8, 12, 16, 20];
    var tipFails = 0;
    var maxTip = opts.maxTipJump != null ? opts.maxTipJump : 0.55;
    for (var t = 0; t < tipIdx.length; t++) {
      var ti = tipIdx[t];
      var td = SB._dist(lms[ti], lastGood[ti]) / scale;
      if (td > maxTip) tipFails++;
    }
    if (tipFails >= 3) return { ok: false, reason: "tipJump", jump: jump };

    var prevScale = SB.handScale(lastGood);
    var scaleRatio = scale / prevScale;
    if (scaleRatio > 2.4 || scaleRatio < 0.42) {
      return { ok: false, reason: "scaleJump" };
    }
  }

  return { ok: true };
};

/**
 * One tracked hand slot (stable id, independent filter, last-good hold).
 */
SB.HandTrackSlot = function (label, filterOpts) {
  this.label = label; /* 'L' | 'R' */
  this.filter = new SB.HandLandmarkFilter(filterOpts || {});
  this.lastGood = null;
  this.lastRaw = null;
  this.prevRaw = null;
  this._goodBuf = [];
  this._rawBuf = [];
  this._prevBuf = [];
  this.palm = null;
  this.misses = 0;
  this.holdFrames = 0;
  this.uiBuf = [];
  this.predBuf = [];
  this.trackId = 0;
  this.lastTMs = 0;
  this.debug = { gated: false, reason: "", jump: 0 };
};

SB.HandTrackSlot.prototype._copyTo = function (src, buf) {
  if (!src) return null;
  for (var i = 0; i < src.length; i++) {
    if (!buf[i]) buf[i] = { x: 0, y: 0, z: 0 };
    buf[i].x = src[i].x;
    buf[i].y = src[i].y;
    buf[i].z = src[i].z || 0;
  }
  buf.length = src.length;
  return buf;
};

SB.HandTrackSlot.prototype.reset = function () {
  this.filter.reset();
  this.lastGood = null;
  this.lastRaw = null;
  this.prevRaw = null;
  this.palm = null;
  this.misses = 0;
  this.holdFrames = 0;
  this.trackId++;
  this.lastTMs = 0;
  this.debug = { gated: false, reason: "", jump: 0 };
};

/**
 * @param {Array|{x,y,z}[]} landmarks  raw 21 points (or null)
 * @param {number} wallMs
 * @returns {{ accepted: boolean, held: boolean, ui: Array|null }}
 */
SB.HandTrackSlot.prototype.update = function (landmarks, wallMs) {
  this.debug = { gated: false, reason: "", jump: 0 };

  if (!landmarks) {
    this.misses++;
    if (this.misses === 1 && this.lastGood) {
      /* Brief hold — keep last good shape for 2–3 frames */
      this.holdFrames++;
      this.filter.noteMiss();
      return { accepted: false, held: true, ui: this.filter.apply(wallMs / 1000, this.lastGood, this.uiBuf) };
    }
    if (this.misses >= 2 && this.misses < 5 && this.lastGood) {
      this.holdFrames++;
      this.filter.softReset();
      return { accepted: false, held: true, ui: this.lastGood };
    }
    if (this.misses >= 5) {
      this.reset();
      return { accepted: false, held: false, ui: null };
    }
    this.filter.noteMiss();
    return { accepted: false, held: false, ui: null };
  }

  var check = SB.validateHandLandmarks(landmarks, this.lastGood, {
    maxPalmJump: this.misses > 0 ? 0.32 : 0.2,
    maxTipJump: 0.5,
  });

  if (!check.ok) {
    this.debug = { gated: true, reason: check.reason || "bad", jump: check.jump || 0 };
    this.misses++;
    if (this.lastGood && this.misses < 4) {
      this.holdFrames++;
      return {
        accepted: false,
        held: true,
        ui: this.filter.apply(wallMs / 1000, this.lastGood, this.uiBuf),
      };
    }
    if (this.misses >= 4) {
      /* Identity likely lost — hard reset so we don't smear filters */
      this.reset();
    }
    return { accepted: false, held: false, ui: null };
  }

  /* Good pose — copy into slot-owned buffers (never alias infer scratch). */
  this.misses = 0;
  this.holdFrames = 0;
  if (this.lastRaw) {
    this.prevRaw = this._copyTo(this.lastRaw, this._prevBuf);
  } else {
    this.prevRaw = null;
  }
  this.lastRaw = this._copyTo(landmarks, this._rawBuf);
  this.lastGood = this._copyTo(landmarks, this._goodBuf);
  this.palm = SB.palmCenter(this.lastGood);
  this.lastTMs = wallMs;
  var ui = this.filter.apply(wallMs / 1000, this.lastRaw, this.uiBuf);
  return { accepted: true, held: false, ui: ui };
};

/**
 * Match unordered detections to L/R slots by palm continuity + handedness.
 * @param {Array<{landmarks, label?: string, score?: number}>} detections
 * @param {SB.HandTrackSlot} leftSlot
 * @param {SB.HandTrackSlot} rightSlot
 * @returns {{ left: Array|null, right: Array|null, swapsBlocked: number }}
 */
SB.assignHandDetections = function (detections, leftSlot, rightSlot) {
  var dets = (detections || []).filter(function (d) {
    return d && d.landmarks && d.landmarks.length >= 21;
  });
  var swapsBlocked = 0;

  if (!dets.length) {
    return { left: null, right: null, swapsBlocked: 0 };
  }

  dets.forEach(function (d) {
    d.palm = SB.palmCenter(d.landmarks);
    d.score = typeof d.score === "number" ? d.score : 0.5;
    d.label = (d.label || "").toLowerCase();
  });

  function cost(det, slot) {
    var c = 0;
    var want = slot.label === "L" ? "left" : "right";
    if (slot.palm && det.palm) {
      /* Position continuity dominates label — MediaPipe handedness flickers. */
      c += SB._dist(slot.palm, det.palm) * 8;
      if (det.label) {
        if (det.label.indexOf(want) >= 0) c -= 0.12 * det.score;
        else c += 0.08; /* soft label hint only */
      }
    } else {
      c += 0.45;
      if (det.label) {
        if (det.label.indexOf(want) >= 0) c -= 0.4 * det.score;
        else c += 0.5;
      }
    }
    c -= 0.04 * det.score;
    if (slot.misses > 2) c += 0.12;
    return c;
  }

  var left = null;
  var right = null;

  if (dets.length === 1) {
    var d0 = dets[0];
    var cl = cost(d0, leftSlot);
    var cr = cost(d0, rightSlot);
    /* If both slots empty, trust label; else nearest slot */
    if (!leftSlot.palm && !rightSlot.palm) {
      if (d0.label.indexOf("left") >= 0) left = d0.landmarks;
      else right = d0.landmarks;
    } else if (cl <= cr) left = d0.landmarks;
    else right = d0.landmarks;
    return { left: left, right: right, swapsBlocked: 0 };
  }

  /* Two+ hands: greedy assignment without crossing if palms are separated */
  var best = null;
  for (var i = 0; i < dets.length; i++) {
    for (var j = 0; j < dets.length; j++) {
      if (i === j) continue;
      var score = cost(dets[i], leftSlot) + cost(dets[j], rightSlot);
      /* Soft anti-swap: if both slots have palms and assignment crosses, penalize */
      if (leftSlot.palm && rightSlot.palm && dets[i].palm && dets[j].palm) {
        var cross =
          SB._dist(dets[i].palm, rightSlot.palm) + SB._dist(dets[j].palm, leftSlot.palm);
        var keep =
          SB._dist(dets[i].palm, leftSlot.palm) + SB._dist(dets[j].palm, rightSlot.palm);
        if (cross + 0.04 < keep) {
          score += 0.8;
          swapsBlocked++;
        }
      }
      if (!best || score < best.score) {
        best = { score: score, left: dets[i].landmarks, right: dets[j].landmarks };
      }
    }
  }
  if (best) {
    return { left: best.left, right: best.right, swapsBlocked: swapsBlocked > 0 ? 1 : 0 };
  }
  return { left: dets[0].landmarks, right: dets[1].landmarks, swapsBlocked: 0 };
};

/** Flatten Holistic/legacy left+right groups into detection list. */
SB.detectionsFromGroups = function (leftGroups, rightGroups) {
  var out = [];
  function pushGroup(list, label) {
    if (!list || !list.length) return;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].length) {
        out.push({ landmarks: list[i], label: label, score: 0.8 });
      }
    }
  }
  pushGroup(leftGroups, "left");
  pushGroup(rightGroups, "right");
  return out;
};
