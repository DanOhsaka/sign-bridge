/* ============================================================
   SignBridge — BeUI + Aceternity interaction layer (vanilla)
   Magnetic buttons, wobble cards, gliding nav pill, beams mount.

   Important: observers must be re-entrancy safe. A tight
   MutationObserver ↔ DOM write loop freezes the main thread
   and makes every click appear dead.
   ============================================================ */

window.SB = window.SB || {};

SB.mountEffects = function () {
  if (SB._effectsMounted) return;
  SB._effectsMounted = true;

  if (SB.settings && SB.settings.reduceMotion) return;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }

  try {
    /* Three.js owns the deep atmosphere when available; keep CSS beams as fallback */
    if (SB.mountThreeFX) {
      SB.mountThreeFX();
    }
    if (!document.documentElement.classList.contains("sb-has-three")) {
      SB._mountBeams();
    }
    SB._mountSpotlight();
    SB._spotlightTrack();
    SB._enhanceCards();
    SB._enhanceButtons();
    SB._glidingPills();
    SB._glareTrack();
  } catch (err) {
    console.warn("SB.mountEffects failed:", err);
  }

  /* Debounced re-enhance for Learn / Practice late paints — never sync-loop */
  if (!SB._cardObserver && window.MutationObserver) {
    var main = SB.$("main") || document.body;
    var scheduled = false;
    SB._cardObserver = new MutationObserver(function () {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () {
        scheduled = false;
        try { SB._enhanceCards(main); } catch (e) { /* ignore */ }
      });
    });
    SB._cardObserver.observe(main, { childList: true, subtree: true });
  }
};

/* Aceternity Background Beams — SVG path field behind the app */
SB._mountBeams = function () {
  if (document.querySelector(".ac-beams")) return;
  var wrap = document.createElement("div");
  wrap.className = "ac-beams";
  wrap.setAttribute("aria-hidden", "true");
  wrap.style.pointerEvents = "none";
  wrap.innerHTML =
    '<svg viewBox="0 0 1200 800" preserveAspectRatio="none">' +
    '<path d="M-40 120 C 180 40, 320 240, 520 160 S 820 40, 1040 180 S 1280 320, 1400 220"/>' +
    '<path d="M-60 280 C 160 200, 360 360, 560 280 S 860 160, 1080 300 S 1300 420, 1420 340"/>' +
    '<path d="M-20 460 C 200 380, 380 540, 600 460 S 900 340, 1120 500 S 1320 620, 1440 520"/>' +
    '<path d="M-80 620 C 140 540, 340 700, 540 600 S 840 480, 1060 640 S 1280 760, 1460 680"/>' +
    '<path d="M-30 40 C 220 120, 400 -20, 620 80 S 920 200, 1140 60 S 1340 -40, 1480 100"/>' +
    '<path d="M-50 740 C 170 680, 390 800, 610 720 S 910 600, 1130 760 S 1350 860, 1500 780"/>' +
    "</svg>";
  document.body.prepend(wrap);
};

/* Aceternity Spotlight glow */
SB._mountSpotlight = function () {
  if (document.querySelector(".ac-spotlight")) return;
  var el = document.createElement("div");
  el.className = "ac-spotlight";
  el.setAttribute("aria-hidden", "true");
  el.style.pointerEvents = "none";
  document.body.prepend(el);
};


/* Full-viewport spotlight follow — not bound to .app / columns */
SB._spotlightTrack = function () {
  if (SB._spotlightBound) return;
  SB._spotlightBound = true;
  var spot = null;
  var raf = 0;
  var tx = 50;
  var ty = 38;
  var x = 50;
  var y = 38;

  function ensure() {
    spot = document.querySelector(".ac-spotlight");
    return spot;
  }

  function tick() {
    raf = 0;
    if (!ensure()) return;
    x += (tx - x) * 0.18;
    y += (ty - y) * 0.18;
    spot.style.setProperty("--sx", x.toFixed(2) + "%");
    spot.style.setProperty("--sy", y.toFixed(2) + "%");
    if (Math.abs(tx - x) > 0.05 || Math.abs(ty - y) > 0.05) {
      raf = requestAnimationFrame(tick);
    }
  }

  window.addEventListener("pointermove", function (e) {
    var w = window.innerWidth || 1;
    var h = window.innerHeight || 1;
    tx = (e.clientX / w) * 100;
    ty = (e.clientY / h) * 100;
    if (!raf) raf = requestAnimationFrame(tick);
  }, { passive: true });
};

/* Aceternity wobble / tilt on interactive cards */
SB._enhanceCards = function (root) {
  var scope = root || document;
  var sels = [
    ".sign-card",
    ".phrase-card",
    ".auth-welcome",
    ".auth-form-card",
    "#spotlight",
    ".arena",
    ".fact-card",
  ];
  sels.forEach(function (sel) {
    SB.$$(sel, scope).forEach(function (card) {
      if (card.dataset.acEnhanced) return;
      card.dataset.acEnhanced = "1";
      card.classList.add("ac-wobble", "ac-glass");
      /* Arena/auth are large layout panels — glare reads as a mid-page wash */
      if (
        !card.classList.contains("arena") &&
        !card.classList.contains("auth-welcome") &&
        !card.classList.contains("auth-form-card")
      ) {
        card.classList.add("ac-glare");
      }

      card.addEventListener("pointermove", function (e) {
        var r = card.getBoundingClientRect();
        var px = (e.clientX - r.left) / r.width;
        var py = (e.clientY - r.top) / r.height;
        var rx = (0.5 - py) * 8;
        var ry = (px - 0.5) * 10;
        card.classList.add("is-tilting");
        card.style.transform =
          "perspective(900px) rotateX(" + rx.toFixed(2) + "deg) rotateY(" + ry.toFixed(2) + "deg) scale3d(1.01,1.01,1.01)";
        card.style.setProperty("--gx", (px * 100).toFixed(1) + "%");
        card.style.setProperty("--gy", (py * 100).toFixed(1) + "%");
      });
      card.addEventListener("pointerleave", function () {
        card.classList.remove("is-tilting");
        card.style.transform = "";
      });
    });
  });

  /* Glass only on heavy layout cards — no tilt (keeps camera / transcript usable) */
  SB.$$(".stage-card, .transcript-card, .etiquette", scope).forEach(function (card) {
    if (card.dataset.acGlass) return;
    card.dataset.acGlass = "1";
    /* Heavy layout cards: opaque glass, no glare wash (avoids L/R Three bleed seam) */
    if (
      card.classList.contains("stage-card") ||
      card.classList.contains("transcript-card") ||
      card.classList.contains("etiquette")
    ) {
      card.classList.add("ac-glass");
    } else {
      card.classList.add("ac-glass", "ac-glare");
    }
  });
};

/* BeUI magnetic primary / soft buttons */
SB._enhanceButtons = function () {
  SB.$$(".btn-primary, .btn-soft").forEach(function (btn) {
    if (btn.dataset.beMagnetic) return;
    btn.dataset.beMagnetic = "1";
    btn.classList.add("be-magnetic");
    btn.addEventListener("pointermove", function (e) {
      var r = btn.getBoundingClientRect();
      var x = e.clientX - (r.left + r.width / 2);
      var y = e.clientY - (r.top + r.height / 2);
      btn.style.transform =
        "translate(" + (x * 0.12).toFixed(1) + "px," + (y * 0.12).toFixed(1) + "px) scale(var(--press,1))";
    });
    btn.addEventListener("pointerleave", function () {
      btn.style.transform = "";
    });
  });
};

/* BeUI gliding layout pill for nav + segmented controls */
SB._glidingPills = function () {
  function attach(container, activeSel) {
    if (!container || container.dataset.bePill) return;
    container.dataset.bePill = "1";
    var pill = document.createElement("span");
    pill.className = "be-pill";
    pill.style.pointerEvents = "none";
    container.prepend(pill);

    var moving = false;
    function move() {
      if (moving) return;
      moving = true;
      try {
        var active = container.querySelector(activeSel);
        if (!active) {
          pill.classList.remove("is-ready");
          return;
        }
        var cr = container.getBoundingClientRect();
        var ar = active.getBoundingClientRect();
        pill.style.left = ar.left - cr.left + "px";
        pill.style.top = ar.top - cr.top + "px";
        pill.style.width = ar.width + "px";
        pill.style.height = ar.height + "px";
        if (!pill.classList.contains("is-ready")) pill.classList.add("is-ready");
      } finally {
        moving = false;
      }
    }

    move();
    requestAnimationFrame(move);
    window.addEventListener("resize", move);
    container.addEventListener("click", function () {
      requestAnimationFrame(function () { requestAnimationFrame(move); });
    });

    /* Observe only the active control classes — never write classes that
       re-trigger this observer in a tight loop. */
    if (window.MutationObserver) {
      var mo = new MutationObserver(function () {
        requestAnimationFrame(move);
      });
      mo.observe(container, { attributes: true, subtree: true, attributeFilter: ["class"] });
    }
  }

  attach(SB.$(".nav"), "a.active");
  /* Skip controls that already have a native .seg-track (Demo/Live).
     Double pills (be-pill + seg-track) cause crescent/glow artifacts. */
  SB.$$(".segmented").forEach(function (seg) {
    if (seg.querySelector(".seg-track")) return;
    attach(seg, "button.is-on");
  });
};

/* Glare follow on any .ac-glare without full tilt */
SB._glareTrack = function () {
  if (SB._glareBound) return;
  SB._glareBound = true;
  document.addEventListener("pointermove", function (e) {
    var t = e.target.closest && e.target.closest(".ac-glare");
    if (!t) return;
    var r = t.getBoundingClientRect();
    if (!r.width || !r.height) return;
    t.style.setProperty("--gx", (((e.clientX - r.left) / r.width) * 100).toFixed(1) + "%");
    t.style.setProperty("--gy", (((e.clientY - r.top) / r.height) * 100).toFixed(1) + "%");
  }, { passive: true });
};

/* Brand shimmer on logo — keep page titles solid for readability */
SB.initEffects = function () {
  var name = SB.$(".logo-name");
  if (name) name.classList.add("ac-text-shimmer");
  SB.mountEffects();
};
