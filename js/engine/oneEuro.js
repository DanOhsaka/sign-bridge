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

/** Per-hand landmark filter bank: 21 joints × (x,y[,z]). */
SB.HandLandmarkFilter = function (opts) {
  opts = opts || {};
  this.minCutoff = opts.minCutoff == null ? 1.35 : opts.minCutoff;
  this.beta = opts.beta == null ? 0.55 : opts.beta;
  this.dCutoff = opts.dCutoff == null ? 1.0 : opts.dCutoff;
  this.includeZ = !!opts.includeZ;
  this.filters = [];
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
