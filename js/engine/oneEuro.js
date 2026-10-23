/* ============================================================
   SignBridge — One Euro Filter (oneEuro.js)
   Motion-aware smoothing: stable when slow, responsive when fast.
   Used for UI landmark overlay only — not for recognition features.
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

/** Keep last position, clear velocity — recovers from brief occlusion without a sticky lag. */
SB.OneEuroFilter.prototype.softReset = function () {
  this.dxPrev = 0;
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

/**
 * Per-hand landmark filter bank: 21 joints × (x,y[,z]).
 * Adaptive: raises beta when landmarks move fast; soft-resets after gaps.
 */
SB.HandLandmarkFilter = function (opts) {
  opts = opts || {};
  this.baseMinCutoff = opts.minCutoff == null ? 1.8 : opts.minCutoff;
  this.baseBeta = opts.beta == null ? 0.95 : opts.beta;
  this.dCutoff = opts.dCutoff == null ? 1.0 : opts.dCutoff;
  this.includeZ = !!opts.includeZ;
  this.minCutoff = this.baseMinCutoff;
  this.beta = this.baseBeta;
  this.filters = [];
  this._lastT = null;
  this._misses = 0;
  this._ensure(21);
};

SB.HandLandmarkFilter.prototype._ensure = function (n) {
  while (this.filters.length < n) {
    this.filters.push({
      x: new SB.OneEuroFilter(this.minCutoff, this.beta, this.dCutoff),
      y: new SB.OneEuroFilter(this.minCutoff, this.beta, this.dCutoff),
      z: new SB.OneEuroFilter(this.minCutoff, this.beta, this.dCutoff),
    });
  }
};

SB.HandLandmarkFilter.prototype.reset = function () {
  for (var i = 0; i < this.filters.length; i++) {
    this.filters[i].x.reset();
    this.filters[i].y.reset();
    this.filters[i].z.reset();
  }
  this._lastT = null;
  this._misses = 0;
  this.minCutoff = this.baseMinCutoff;
  this.beta = this.baseBeta;
};

SB.HandLandmarkFilter.prototype.softReset = function () {
  for (var i = 0; i < this.filters.length; i++) {
    this.filters[i].x.softReset();
    this.filters[i].y.softReset();
    this.filters[i].z.softReset();
  }
  this._lastT = null;
};

SB.HandLandmarkFilter.prototype.noteMiss = function () {
  this._misses++;
  /* Brief occlusion: soft reset so reacquire isn't oversmoothed.
     Longer gaps: hard reset. */
  if (this._misses === 2) this.softReset();
  else if (this._misses >= 6) this.reset();
};

SB.HandLandmarkFilter.prototype._applyParams = function () {
  for (var i = 0; i < this.filters.length; i++) {
    this.filters[i].x.setParams(this.minCutoff, this.beta, this.dCutoff);
    this.filters[i].y.setParams(this.minCutoff, this.beta, this.dCutoff);
    this.filters[i].z.setParams(this.minCutoff, this.beta, this.dCutoff);
  }
};

/**
 * @param {number} tSec  timestamp in seconds
 * @param {Array<{x,y,z}>} landmarks
 * @param {Array<{x,y,z}>} out   reusable output buffer (length 21)
 */
SB.HandLandmarkFilter.prototype.apply = function (tSec, landmarks, out) {
  if (!landmarks || !landmarks.length) {
    this.noteMiss();
    return null;
  }
  this._misses = 0;
  this._ensure(landmarks.length);

  /* Adaptive responsiveness from wrist + middle-tip speed */
  if (this._lastT != null && landmarks[0] && this.filters[0].x.xPrev != null) {
    var dt = Math.max(1e-3, tSec - this._lastT);
    var wx = landmarks[0].x - this.filters[0].x.xPrev;
    var wy = landmarks[0].y - this.filters[0].y.xPrev;
    var tip = landmarks[12] || landmarks[8] || landmarks[0];
    var fTip = this.filters[12] || this.filters[8] || this.filters[0];
    var tx = tip.x - (fTip.x.xPrev != null ? fTip.x.xPrev : tip.x);
    var ty = tip.y - (fTip.y.xPrev != null ? fTip.y.xPrev : tip.y);
    var speed = Math.sqrt(wx * wx + wy * wy + tx * tx + ty * ty) / dt;
    /* speed in norm-units/sec; ~0.2 idle, >1.5 fast swipe */
    if (speed > 1.2) {
      this.minCutoff = this.baseMinCutoff + 0.6;
      this.beta = this.baseBeta + 0.85;
    } else if (speed > 0.45) {
      this.minCutoff = this.baseMinCutoff + 0.25;
      this.beta = this.baseBeta + 0.35;
    } else {
      this.minCutoff = this.baseMinCutoff;
      this.beta = this.baseBeta;
    }
    this._applyParams();
  }
  this._lastT = tSec;

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
