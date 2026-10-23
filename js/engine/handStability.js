/* ============================================================
   SignBridge — Hand identity + landmark validity (handStability.js)
   Pass 5: prefer brief blank over ghost freeze after track loss.
   States: TRACKING | TEMPORARILY_LOST | REACQUIRING | LOST
   ============================================================ */

window.SB = window.SB || {};

SB.HAND_STATUS = {
  TRACKING: "TRACKING",
  TEMPORARILY_LOST: "TEMPORARILY_LOST",
  REACQUIRING: "REACQUIRING",
  LOST: "LOST",
};

/** Palm / finger bone pairs used for length sanity checks (MediaPipe 21). */
SB.HAND_BONE_PAIRS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17],
];

/** Max wall-clock to keep a ghost hold (prefer blank after this). */
SB.HAND_HOLD_TTL_MS = 45;
/** Misses before LOST (clear overlay + reset). ~1–2 frames at 15–30 infer FPS. */
SB.HAND_LOST_AFTER_MISSES = 2;

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
 * Shape-only validation (no continuity). Used for reacquire / first lock.
 * @returns {{ ok: boolean, reason?: string }}
 */
SB.validateHandShape = function (lms) {
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

  var badBones = 0;
  for (var b = 0; b < SB.HAND_BONE_PAIRS.length; b++) {
    var a = SB.HAND_BONE_PAIRS[b];
    var len = SB._dist(lms[a[0]], lms[a[1]]) / scale;
    if (len > 2.8 || len < 0.02) badBones++;
  }
  if (badBones >= 4) return { ok: false, reason: "bones" };
  return { ok: true };
};

/**
 * Continuity check vs last good. palmJump/scaleJump ⇒ caller should REACQUIRE,
 * not hold the old pose (that caused freeze-at-old-position ghosts).
 * @returns {{ ok: boolean, reason?: string, jump?: number, reacquire?: boolean }}
 */
SB.validateHandLandmarks = function (lms, lastGood, opts) {
  opts = opts || {};
  var shape = SB.validateHandShape(lms);
  if (!shape.ok) return shape;

  if (lastGood && lastGood.length >= 21) {
    var c0 = SB.palmCenter(lastGood);
    var c1 = SB.palmCenter(lms);
    var jump = SB._dist(c0, c1);
    var maxJump = opts.maxPalmJump != null ? opts.maxPalmJump : 0.22;
    if (jump > maxJump) {
      return { ok: false, reason: "palmJump", jump: jump, reacquire: true };
    }

    var tipIdx = [4, 8, 12, 16, 20];
    var tipFails = 0;
    var maxTip = opts.maxTipJump != null ? opts.maxTipJump : 0.55;
    var scale = SB.handScale(lms);
    for (var t = 0; t < tipIdx.length; t++) {
      var ti = tipIdx[t];
      var td = SB._dist(lms[ti], lastGood[ti]) / scale;
      if (td > maxTip) tipFails++;
    }
    if (tipFails >= 3) {
      return { ok: false, reason: "tipJump", jump: jump, reacquire: true };
    }

    var prevScale = SB.handScale(lastGood);
    var scaleRatio = scale / prevScale;
    if (scaleRatio > 2.4 || scaleRatio < 0.42) {
      return { ok: false, reason: "scaleJump", reacquire: true };
    }
  }

  return { ok: true };
};

/**
 * One tracked hand slot with explicit loss/reacquire states.
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
  this.lastTMs = 0;       /* wall ms of last ACCEPTED pose */
  this.lastSeenMs = 0;    /* wall ms of last update call with any signal */
  this.status = SB.HAND_STATUS.LOST;
  this.lossCount = 0;
  this.reacquireCount = 0;
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
  this.status = SB.HAND_STATUS.LOST;
  this.debug = { gated: false, reason: "", jump: 0 };
};

/** Hard filter reset without bumping trackId (same logical hand). */
SB.HandTrackSlot.prototype.resetFilterOnly = function () {
  this.filter.reset();
  this.prevRaw = null;
  this.lastRaw = null;
};

SB.HandTrackSlot.prototype.landmarkAgeMs = function (nowMs) {
  if (!this.lastTMs) return Infinity;
  return Math.max(0, nowMs - this.lastTMs);
};

/**
 * @param {Array|{x,y,z}[]|null} landmarks
 * @param {number} wallMs
 * @returns {{ accepted: boolean, held: boolean, ui: Array|null, status: string, reacquired: boolean }}
 */
SB.HandTrackSlot.prototype.update = function (landmarks, wallMs) {
  this.debug = { gated: false, reason: "", jump: 0 };
  this.lastSeenMs = wallMs;

  if (!landmarks) {
    return this._onMiss(wallMs, "absent");
  }

  var wasLost =
    this.status === SB.HAND_STATUS.LOST ||
    this.status === SB.HAND_STATUS.TEMPORARILY_LOST ||
    this.status === SB.HAND_STATUS.REACQUIRING ||
    !this.lastGood;

  /* After loss / first lock: accept any shape-valid pose at the NEW location.
     Never interpolate across empty space — reset filters first. */
  if (wasLost) {
    var shapeOnly = SB.validateHandShape(landmarks);
    if (!shapeOnly.ok) {
      this.debug = { gated: true, reason: shapeOnly.reason || "bad", jump: 0 };
      return this._onMiss(wallMs, shapeOnly.reason || "bad");
    }
    return this._accept(landmarks, wallMs, true);
  }

  var check = SB.validateHandLandmarks(landmarks, this.lastGood, {
    maxPalmJump: 0.2,
    maxTipJump: 0.5,
  });

  if (!check.ok) {
    this.debug = {
      gated: true,
      reason: check.reason || "bad",
      jump: check.jump || 0,
    };

    /* Large discontinuity = hand moved / reappeared elsewhere → REACQUIRE.
       Holding the old pose here was the freeze/ghost bug. */
    if (check.reacquire) {
      var shapeOk = SB.validateHandShape(landmarks);
      if (shapeOk.ok) {
        return this._accept(landmarks, wallMs, true);
      }
    }

    /* Shape garbage (bones/nan): clear quickly — do not freeze last good. */
    return this._onMiss(wallMs, check.reason || "bad");
  }

  return this._accept(landmarks, wallMs, false);
};

SB.HandTrackSlot.prototype._onMiss = function (wallMs, reason) {
  this.misses++;
  var age = this.landmarkAgeMs(wallMs);

  /* At most one brief hold frame, and only within HOLD_TTL_MS of last accept. */
  if (
    this.misses === 1 &&
    this.lastGood &&
    age <= SB.HAND_HOLD_TTL_MS &&
    this.status === SB.HAND_STATUS.TRACKING
  ) {
    this.status = SB.HAND_STATUS.TEMPORARILY_LOST;
    this.holdFrames++;
    /* Return null UI — prefer blank flash over ghost. Keep lastGood for reacquire match. */
    return {
      accepted: false,
      held: false,
      ui: null,
      status: this.status,
      reacquired: false,
    };
  }

  if (this.misses >= SB.HAND_LOST_AFTER_MISSES || age > SB.HAND_HOLD_TTL_MS) {
    if (this.status !== SB.HAND_STATUS.LOST) {
      this.lossCount++;
    }
    this.reset();
    this.status = SB.HAND_STATUS.LOST;
    return {
      accepted: false,
      held: false,
      ui: null,
      status: this.status,
      reacquired: false,
    };
  }

  this.status = SB.HAND_STATUS.TEMPORARILY_LOST;
  return {
    accepted: false,
    held: false,
    ui: null,
    status: this.status,
    reacquired: false,
  };
};

SB.HandTrackSlot.prototype._accept = function (landmarks, wallMs, reacquire) {
  if (reacquire) {
    this.resetFilterOnly();
    this.reacquireCount++;
    this.status = SB.HAND_STATUS.REACQUIRING;
  } else {
    this.status = SB.HAND_STATUS.TRACKING;
  }

  this.misses = 0;
  this.holdFrames = 0;

  if (!reacquire && this.lastRaw) {
    this.prevRaw = this._copyTo(this.lastRaw, this._prevBuf);
  } else {
    /* No velocity bridge across empty space / reacquire */
    this.prevRaw = null;
  }

  this.lastRaw = this._copyTo(landmarks, this._rawBuf);
  this.lastGood = this._copyTo(landmarks, this._goodBuf);
  this.palm = SB.palmCenter(this.lastGood);
  this.lastTMs = wallMs;

  var ui = this.filter.apply(wallMs / 1000, this.lastRaw, this.uiBuf);
  /* Next frame of a reacquire is normal TRACKING */
  if (reacquire) this.status = SB.HAND_STATUS.TRACKING;

  return {
    accepted: true,
    held: false,
    ui: ui,
    status: this.status,
    reacquired: !!reacquire,
  };
};

/**
 * Match unordered detections to L/R slots by palm continuity + handedness.
 * Dead (LOST) slots don't attract detections via stale palms.
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

  function slotAlive(slot) {
    return slot.status === SB.HAND_STATUS.TRACKING ||
      slot.status === SB.HAND_STATUS.TEMPORARILY_LOST ||
      slot.status === SB.HAND_STATUS.REACQUIRING;
  }

  function cost(det, slot) {
    var c = 0;
    var want = slot.label === "L" ? "left" : "right";
    var alive = slotAlive(slot) && slot.palm && det.palm;
    if (alive) {
      c += SB._dist(slot.palm, det.palm) * 8;
      if (det.label) {
        if (det.label.indexOf(want) >= 0) c -= 0.12 * det.score;
        else c += 0.08;
      }
    } else {
      /* LOST slot: ignore stale palm — use label only */
      c += 0.45;
      if (det.label) {
        if (det.label.indexOf(want) >= 0) c -= 0.4 * det.score;
        else c += 0.5;
      }
    }
    c -= 0.04 * det.score;
    return c;
  }

  if (dets.length === 1) {
    var d0 = dets[0];
    var leftAlive = slotAlive(leftSlot);
    var rightAlive = slotAlive(rightSlot);
    if (!leftAlive && !rightAlive) {
      if (d0.label.indexOf("left") >= 0) {
        return { left: d0.landmarks, right: null, swapsBlocked: 0 };
      }
      return { left: null, right: d0.landmarks, swapsBlocked: 0 };
    }
    var cl = cost(d0, leftSlot);
    var cr = cost(d0, rightSlot);
    if (cl <= cr) return { left: d0.landmarks, right: null, swapsBlocked: 0 };
    return { left: null, right: d0.landmarks, swapsBlocked: 0 };
  }

  var best = null;
  for (var i = 0; i < dets.length; i++) {
    for (var j = 0; j < dets.length; j++) {
      if (i === j) continue;
      var score = cost(dets[i], leftSlot) + cost(dets[j], rightSlot);
      if (
        slotAlive(leftSlot) && slotAlive(rightSlot) &&
        leftSlot.palm && rightSlot.palm &&
        dets[i].palm && dets[j].palm
      ) {
        var cross =
          SB._dist(dets[i].palm, rightSlot.palm) +
          SB._dist(dets[j].palm, leftSlot.palm);
        var keep =
          SB._dist(dets[i].palm, leftSlot.palm) +
          SB._dist(dets[j].palm, rightSlot.palm);
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
