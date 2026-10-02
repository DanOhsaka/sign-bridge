/* ============================================================
   SignBridge — One Euro Filter (oneEuro.js)
   Motion-aware smoothing: stable when slow, responsive when fast.
   Used for UI landmark overlay only — not for recognition features.

   Per-joint tuning: wrist/palm smoother; fingertips follow faster.
   ============================================================ */

window.SB = window.SB || {};

SB.OneEuroFilter = function (minCutoff, beta, dCutoff) {
  this.minCutoff = minCutoff == null ? 1.2 : minCutoff;
  this.beta = beta == null ? 0.45 : beta;
  this.dCutoff = dCutoff == null ? 1.0 : dCutoff;
  this.xPrev = null;
  this.dxPrev = null;
  this.tPrev = null;
};

SB.OneEuroFilter.prototype.reset = function () {
  this.xPrev = null;
  this.dxPrev = null;
  this.tPrev = null;
};

SB.OneEuroFilter.prototype.setParams = function (minCutoff, beta, dCutoff) {
  if (minCutoff != null) this.minCutoff = minCutoff;
  if (beta != null) this.beta = beta;
  if (dCutoff != null) this.dCutoff = dCutoff;
};

SB.OneEuroFilter.prototype.filter = function (t, x) {
  if (this.tPrev == null) {
    this.tPrev = t;
    this.xPrev = x;
    this.dxPrev = 0;
    return x;
  }
  var dt = t - this.tPrev;
  if (dt <= 0) dt = 1e-6;

  var dx = (x - this.xPrev) / dt;
  var edx = SB._oneEuroLowpass(dx, this.dxPrev, SB._oneEuroAlpha(dt, this.dCutoff));
  var cutoff = this.minCutoff + this.beta * Math.abs(edx);
  var xHat = SB._oneEuroLowpass(x, this.xPrev, SB._oneEuroAlpha(dt, cutoff));

  this.tPrev = t;
  this.xPrev = xHat;
  this.dxPrev = edx;
  return xHat;
};

SB._oneEuroAlpha = function (dt, cutoff) {
  var tau = 1.0 / (2 * Math.PI * cutoff);
  return 1.0 / (1.0 + tau / dt);
};

SB._oneEuroLowpass = function (x, xPrev, a) {
  return a * x + (1 - a) * xPrev;
};

/* MediaPipe hand indices: 0 wrist, tips 4/8/12/16/20 */
SB.HAND_JOINT_PROFILE = function (index) {
  /* Higher minCutoff + beta → less lag when moving */
  if (index === 0) return { minCutoff: 1.05, beta: 0.32 };           /* wrist */
  if (index === 1 || index === 5 || index === 9 || index === 13 || index === 17) {
    return { minCutoff: 1.25, beta: 0.45 };                          /* palm / MCP */
  }
  if (index === 4 || index === 8 || index === 12 || index === 16 || index === 20) {
    return { minCutoff: 1.85, beta: 0.95 };                          /* tips */
  }
  return { minCutoff: 1.45, beta: 0.65 };                            /* PIP / DIP */
};

/** Per-hand landmark filter bank: 21 joints × (x,y[,z]). */
SB.HandLandmarkFilter = function (opts) {
  opts = opts || {};
  this.baseMinCutoff = opts.minCutoff == null ? 1.35 : opts.minCutoff;
  this.baseBeta = opts.beta == null ? 0.55 : opts.beta;
  this.dCutoff = opts.dCutoff == null ? 1.0 : opts.dCutoff;
  this.includeZ = !!opts.includeZ;
  this.perJoint = opts.perJoint !== false;
  this.filters = [];
  this._ensure(21);
};

SB.HandLandmarkFilter.prototype._paramsFor = function (index) {
  if (!this.perJoint) {
    return { minCutoff: this.baseMinCutoff, beta: this.baseBeta };
  }
  return SB.HAND_JOINT_PROFILE(index);
};

SB.HandLandmarkFilter.prototype._ensure = function (n) {
  while (this.filters.length < n) {
    var i = this.filters.length;
    var p = this._paramsFor(i);
    this.filters.push({
      x: new SB.OneEuroFilter(p.minCutoff, p.beta, this.dCutoff),
      y: new SB.OneEuroFilter(p.minCutoff, p.beta, this.dCutoff),
      z: new SB.OneEuroFilter(p.minCutoff, p.beta, this.dCutoff),
    });
  }
};

SB.HandLandmarkFilter.prototype.reset = function () {
  for (var i = 0; i < this.filters.length; i++) {
    this.filters[i].x.reset();
    this.filters[i].y.reset();
    this.filters[i].z.reset();
  }
};

/**
 * @param {number} tSec  timestamp in seconds
 * @param {Array<{x,y,z}>} landmarks
 * @param {Array<{x,y,z}>} out   reusable output buffer (length 21)
 */
SB.HandLandmarkFilter.prototype.apply = function (tSec, landmarks, out) {
  if (!landmarks || !landmarks.length) return null;
  this._ensure(landmarks.length);
  if (!out) out = [];
  for (var i = 0; i < landmarks.length; i++) {
    var p = landmarks[i];
    var f = this.filters[i];
    if (!out[i]) out[i] = { x: 0, y: 0, z: 0 };
    out[i].x = f.x.filter(tSec, p.x);
    out[i].y = f.y.filter(tSec, p.y);
    out[i].z = this.includeZ ? f.z.filter(tSec, p.z || 0) : (p.z || 0);
  }
  out.length = landmarks.length;
  return out;
};
