/* ============================================================
   SignBridge — BeUI + Aceternity interaction layer (vanilla)
   Magnetic buttons, wobble cards, gliding nav pill, beams mount.
   ============================================================ */

window.SB = window.SB || {};

SB.mountEffects = function () {
  if (SB.settings && SB.settings.reduceMotion) return;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  SB._mountBeams();
  SB._mountSpotlight();
  SB._enhanceCards();
  SB._enhanceButtons();
  SB._glidingPills();
  SB._glareTrack();

  /* Re-enhance cards painted later by Learn / Practice views */
  if (!SB._cardObserver && window.MutationObserver) {
    var main = SB.$("main") || document.body;
    SB._cardObserver = new MutationObserver(function (muts) {
      var needs = muts.some(function (m) { return m.addedNodes && m.addedNodes.length; });
      if (needs) SB._enhanceCards(main);
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
  document.body.prepend(el);
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
      card.classList.add("ac-wobble", "ac-glare", "ac-glass");

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
    card.classList.add("ac-glass", "ac-glare");
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
    container.prepend(pill);

    function move() {
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
      pill.classList.add("is-ready");
    }

    move();
    requestAnimationFrame(move);
    window.addEventListener("resize", move);
    container.addEventListener("click", function () {
      requestAnimationFrame(function () { requestAnimationFrame(move); });
    });

    /* observe class changes (mode/tab switches) */
    var mo = new MutationObserver(function () { move(); });
    mo.observe(container, { attributes: true, subtree: true, attributeFilter: ["class"] });
  }

  attach(SB.$(".nav"), "a.active");
  SB.$$(".segmented").forEach(function (seg) {
    attach(seg, "button.is-on");
  });
};

/* Glare follow on any .ac-glare without full tilt */
SB._glareTrack = function () {
  document.addEventListener("pointermove", function (e) {
    var t = e.target.closest && e.target.closest(".ac-glare");
    if (!t) return;
    var r = t.getBoundingClientRect();
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
