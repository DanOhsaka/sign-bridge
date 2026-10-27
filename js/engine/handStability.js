/* ============================================================
   SignBridge — Hand identity + landmark validity (handStability.js)
   Pass 5: prefer blank over multi-second ghost freeze.
   Pass 6: adaptive hold TTL vs measured infer latency so CPU
   (~100–170ms) does not expire freshness mid-flight and flicker.
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

/**
 * Adaptive freshness budget (updated from live.js infer stats).
 * Floor covers ~2 slow CPU frames; cap avoids pass-5 multi-second ghosts.
 */
SB.HAND_HOLD_TTL_MIN_MS = 90;
SB.HAND_HOLD_TTL_MAX_MS = 320;
SB.HAND_HOLD_TTL_MS = 160; /* current adaptive value */
SB.HAND_LOST_AFTER_MISSES = 3;
SB.HAND_HOLD_INFER_MS = 110; /* last measured infer used for budget */

/**
 * @param {number} inferMs  measured infer latency (prefer p50 / avg)
 * @returns {{ ttlMs: number, lostAfterMisses: number, inferMs: number }}
 */
SB.updateHandHoldBudget = function (inferMs) {
  var ms = Number(inferMs);
  if (!isFinite(ms) || ms < 1) ms = SB.HAND_HOLD_INFER_MS || 110;
  /* max(≈2–3 frames, 1.5×infer + slack) */
  var ttl = Math.round(Math.max(
    SB.HAND_HOLD_TTL_MIN_MS,
    Math.min(SB.HAND_HOLD_TTL_MAX_MS, ms * 1.5 + 45)
  ));
  /* Enough misses to ride ~1–2 in-flight detects without LOST */
  var misses = Math.max(3, Math.min(6, Math.ceil(ttl / Math.max(55, ms * 0.9))));
  SB.HAND_HOLD_TTL_MS = ttl;
  SB.HAND_LOST_AFTER_MISSES = misses;
  SB.HAND_HOLD_INFER_MS = ms;
  return { ttlMs: ttl, lostAfterMisses: misses, inferMs: ms };
};

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
 * Continuity check vs last good.
 * Pass 6: tipJump with palm continuity OK → soft (accept, no REACQUIRE).
 * Hard palmJump / scaleJump still reacquire (no ghost at old pose).
 * @returns {{ ok: boolean, reason?: string, jump?: number, reacquire?: boolean, soft?: boolean }}
 */
SB.validateHandLandmarks = function (lms, lastGood, opts) {
  opts = opts || {};
  var shape = SB.validateHandShape(lms);
  if (!shape.ok) return shape;

  if (lastGood && lastGood.length >= 21) {
    var c0 = SB.palmCenter(lastGood);
    var c1 = SB.palmCenter(lms);
    var jump = SB._dist(c0, c1);
    var maxJump = opts.maxPalmJump != null ? opts.maxPalmJump : 0.26;
    if (jump > maxJump) {
      return { ok: false, reason: "palmJump", jump: jump, reacquire: true };
    }

    var tipIdx = [4, 8, 12, 16, 20];
    var tipFails = 0;
    var maxTip = opts.maxTipJump != null ? opts.maxTipJump : 0.7;
    var scale = SB.handScale(lms);
    for (var t = 0; t < tipIdx.length; t++) {
      var ti = tipIdx[t];
      var td = SB._dist(lms[ti], lastGood[ti]) / scale;
      if (td > maxTip) tipFails++;
    }
    /* Near face: tips jitter a lot while palm stays put — don't blank/reacq. */
    if (tipFails >= 4) {
      if (jump <= maxJump * 0.7) {
        return { ok: true, reason: "tipJumpSoft", jump: jump, soft: true };
      }
      return { ok: false, reason: "tipJump", jump: jump, reacquire: true };
    }

    var prevScale = SB.handScale(lastGood);
    var scaleRatio = scale / prevScale;
    if (scaleRatio > 2.6 || scaleRatio < 0.38) {
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
  this._holdUiBuf = [];
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
  this.clearReason = "";
  this.debug = { gated: false, reason: "", jump: 0, soft: false };
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

SB.HandTrackSlot.prototype.holdTtlMs = function () {
  return SB.HAND_HOLD_TTL_MS || 160;
};

SB.HandTrackSlot.prototype.lostAfterMisses = function () {
  return SB.HAND_LOST_AFTER_MISSES || 3;
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
  this.debug = { gated: false, reason: "", jump: 0, soft: false };
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
 * @returns {{ accepted: boolean, held: boolean, ui: Array|null, status: string, reacquired: boolean, clearReason?: string }}
 */
SB.HandTrackSlot.prototype.update = function (landmarks, wallMs) {
  this.debug = { gated: false, reason: "", jump: 0, soft: false };
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
    /* TEMPORARILY_LOST with held lastGood: try continuity first (same hand). */
    if (
      this.status === SB.HAND_STATUS.TEMPORARILY_LOST &&
      this.lastGood
    ) {
      var cont = SB.validateHandLandmarks(landmarks, this.lastGood, {
        maxPalmJump: 0.28,
        maxTipJump: 0.75,
      });
      if (cont.ok) {
        if (cont.soft) {
          this.debug = { gated: false, reason: cont.reason || "tipJumpSoft", jump: cont.jump || 0, soft: true };
        }
        return this._accept(landmarks, wallMs, false);
      }
      if (cont.reacquire) {
        var shapeRe = SB.validateHandShape(landmarks);
        if (shapeRe.ok) {
          this.debug = { gated: true, reason: cont.reason || "jump", jump: cont.jump || 0, soft: false };
          return this._accept(landmarks, wallMs, true);
        }
      }
    }

    var shapeOnly = SB.validateHandShape(landmarks);
    if (!shapeOnly.ok) {
      this.debug = { gated: true, reason: shapeOnly.reason || "bad", jump: 0, soft: false };
      return this._onMiss(wallMs, shapeOnly.reason || "bad");
    }
    /* First lock from LOST: no filter reacq. Recovery after hold: reacq if we
       skipped continuity (jumped), else treated above. */
    return this._accept(
      landmarks,
      wallMs,
      this.status === SB.HAND_STATUS.TEMPORARILY_LOST ||
        this.status === SB.HAND_STATUS.REACQUIRING
    );
  }

  var check = SB.validateHandLandmarks(landmarks, this.lastGood, {
    maxPalmJump: 0.26,
    maxTipJump: 0.7,
  });

  if (check.ok) {
    if (check.soft) {
      this.debug = { gated: false, reason: check.reason || "tipJumpSoft", jump: check.jump || 0, soft: true };
    }
    return this._accept(landmarks, wallMs, false);
  }

  this.debug = {
    gated: true,
    reason: check.reason || "bad",
    jump: check.jump || 0,
    soft: false,
  };

  /* Large discontinuity = hand moved / reappeared elsewhere → REACQUIRE.
     Holding the old pose here was the freeze/ghost bug. */
  if (check.reacquire) {
    var shapeOk = SB.validateHandShape(landmarks);
    if (shapeOk.ok) {
      return this._accept(landmarks, wallMs, true);
    }
  }

  /* Shape garbage (bones/nan): miss path — may brief-hold then clear. */
  return this._onMiss(wallMs, check.reason || "bad");
};

SB.HandTrackSlot.prototype._onMiss = function (wallMs, reason) {
  this.misses++;
  var age = this.landmarkAgeMs(wallMs);
  var ttl = this.holdTtlMs();
  var maxMiss = this.lostAfterMisses();

  /*
   * Pass 6: while a detect is in-flight, age often exceeds the old 45ms TTL
   * but is still < adaptive TTL. Hold last fresh landmarks briefly (TRACKING
   * → TEMPORARILY_LOST) so the skeleton does not flicker every slow frame.
   * Clear only when age/misses prove the hand left (or long miss).
   */
  var canHold =
    this.lastGood &&
    age <= ttl &&
    this.misses < maxMiss &&
    (this.status === SB.HAND_STATUS.TRACKING ||
      this.status === SB.HAND_STATUS.TEMPORARILY_LOST ||
      this.status === SB.HAND_STATUS.REACQUIRING);

  if (canHold) {
    this.status = SB.HAND_STATUS.TEMPORARILY_LOST;
    this.holdFrames++;
    this.clearReason = "";
    var holdUi =
      (this.uiBuf && this.uiBuf.length >= 21)
        ? this._copyTo(this.uiBuf, this._holdUiBuf)
        : this._copyTo(this.lastGood, this._holdUiBuf);
    return {
      accepted: false,
      held: true,
      ui: holdUi,
      status: this.status,
      reacquired: false,
      clearReason: "",
    };
  }

  /* Truly lost — blank, reset filters (no multi-second ghost). */
  var why = reason || "lost";
  if (age > ttl) why = why + "/ttl";
  else if (this.misses >= maxMiss) why = why + "/miss";
  this.clearReason = why;
  if (this.status !== SB.HAND_STATUS.LOST) {
    this.lossCount++;
  }
  this.reset();
  this.status = SB.HAND_STATUS.LOST;
  this.clearReason = why;
  return {
    accepted: false,
    held: false,
    ui: null,
    status: this.status,
    reacquired: false,
    clearReason: why,
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
  this.clearReason = "";

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
    clearReason: "",
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
