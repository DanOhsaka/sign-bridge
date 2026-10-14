/* ============================================================
   SignBridge — Common UI helpers (common.js)
   Settings, theme, toasts, speech synthesis, DOM helpers.
   ============================================================ */

window.SB = window.SB || {};

SB.$ = function (sel, root) { return (root || document).querySelector(sel); };
SB.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

SB.escHtml = function (s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
};

/* ---------- Settings + localStorage ---------- */
SB.DEFAULTS = {
  theme: "dark",          // dark | light | auto
  mirror: true,
  landmarks: true,
  threshold: 0.6,         // conf below this → "check this" styling
  voice: null,            // speech synthesis voice name
  rate: 1,
  reduceMotion: false,
  mode: "demo",
};

SB.store = {
  get: function (key, fallback) {
    try {
      var raw = localStorage.getItem("sb." + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  },
  set: function (key, val) {
    try { localStorage.setItem("sb." + key, JSON.stringify(val)); } catch (e) {}
  },
};

SB.settings = Object.assign({}, SB.DEFAULTS, SB.store.get("settings", {}));
SB.saveSettings = function () { SB.store.set("settings", SB.settings); };

/* ---------- Theme ---------- */
SB.resolveTheme = function () {
  var pref = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  return SB.settings.theme === "auto" ? pref : SB.settings.theme;
};

SB.applyTheme = function () {
  var theme = SB.resolveTheme();
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.classList.toggle("reduce-motion", !!SB.settings.reduceMotion);
  SB._positionThemePill(theme);
};

/* Move the sliding pill to the active side */
SB._positionThemePill = function (theme) {
  var sw   = SB.$("#themeSwitch");
  var pill = SB.$("#tsPill");
  if (!sw || !pill) return;

  // resolve "auto" to the real theme for pill position
  var resolved = theme;
  if (resolved === "auto") {
    resolved = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }

  var target = sw.querySelector(".ts-" + resolved);
  var track  = sw.querySelector(".ts-track");
  if (!target || !track) return;

  var tr = track.getBoundingClientRect();
  var mr = target.getBoundingClientRect();
  pill.style.left  = (mr.left - tr.left) + "px";
  pill.style.width = mr.width + "px";

  sw.classList.toggle("is-dark",  resolved === "dark");
  sw.classList.toggle("is-light", resolved === "light");
};

SB.setTheme = function (theme) {
  if (theme !== "dark" && theme !== "light" && theme !== "auto") return;
  SB.settings.theme = theme;
  SB.saveSettings();
  SB.applyTheme();
};

SB.toggleTheme = function () {
  var current = SB.resolveTheme();
  SB.setTheme(current === "dark" ? "light" : "dark");
};

/* ---------- Toasts ---------- */
SB.toast = function (msg, type) {
  var wrap = SB.$("#toastWrap");
  if (!wrap) return;
  var el = document.createElement("div");
  el.className = "toast is-" + (type || "info");
  var ico = { info: "💡", ok: "✓", error: "!" };
  el.innerHTML = '<span class="t-ico">' + (ico[type] || ico.info) + "</span><span>" + SB.escHtml(msg) + "</span>";
  wrap.appendChild(el);
  setTimeout(function () {
    el.classList.add("is-out");
    setTimeout(function () { el.remove(); }, 180);
  }, 3400);
};

/* ---------- Speech synthesis (speak the transcript back) ---------- */
SB.voices = [];
SB.loadVoices = function () {
  var fill = function () {
    SB.voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  };
  fill();
  if (window.speechSynthesis && speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.onvoiceschanged = fill;
  }
};

SB.speak = function (text) {
  if (!window.speechSynthesis) { SB.toast("Speech synthesis not available in this browser", "error"); return; }
  speechSynthesis.cancel();
  var u = new SpeechSynthesisUtterance(text);
  u.rate = SB.settings.rate || 1;
  var want = SB.settings.voice;
  if (want) {
    var match = SB.voices.find(function (v) { return v.name === want; });
    if (match) u.voice = match;
  }
  speechSynthesis.speak(u);
};

/* ---------- Clipboard with file:// fallback ---------- */
SB.copyText = function (text) {
  var done = function () { SB.toast("Copied to clipboard", "ok"); };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, function () { fallback(); });
  } else { fallback(); }
  function fallback() {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { SB.toast("Couldn't copy", "error"); }
    ta.remove();
  }
};

/* ---------- Confidence → colour class ---------- */
SB.confClass = function (conf) {
  if (conf >= 0.85) return "is-high";
  if (conf >= SB.settings.threshold) return "is-mid";
  return "is-low";
};

SB.confPct = function (conf) { return Math.round(conf * 100) + "%"; };

/* ---------- Settings drawer ---------- */
SB.openDrawer = function (id) {
  SB.$("#" + id).classList.add("is-open");
  SB.$("#drawerBackdrop").classList.add("is-open");
};
SB.closeDrawer = function () {
  SB.$$(".drawer.is-open").forEach(function (d) { d.classList.remove("is-open"); });
  SB.$("#drawerBackdrop").classList.remove("is-open");
};

SB.initCommon = function () {
  SB.loadVoices();

  /* global topbar wiring — sliding theme switch */
  var themeSwitch = SB.$("#themeSwitch");
  if (themeSwitch) {
    /* One handler only — inline onclick on some pages caused double-toggle */
    themeSwitch.addEventListener("click", function (e) {
      var opt = e.target.closest && e.target.closest(".ts-dark, .ts-light");
      if (opt) {
        var want = opt.classList.contains("ts-light") ? "light" : "dark";
        if (SB.resolveTheme() !== want) SB.setTheme(want);
        return;
      }
      SB.toggleTheme();
    });
    requestAnimationFrame(function () {
      setTimeout(function () { SB._positionThemePill(SB.resolveTheme()); }, 80);
    });
    window.addEventListener("resize", function () { SB.applyTheme(); });
  }

  /* Ensure every page has a sliding nav pill */
  var navEl = SB.$(".nav");
  if (navEl && !SB.$("#navPill", navEl)) {
    var pillEl = document.createElement("div");
    pillEl.className = "nav-pill";
    pillEl.id = "navPill";
    navEl.insertBefore(pillEl, navEl.firstChild);
  }

  /* nav sliding pill */
  SB._movePill = function () {
    var active = SB.$(".nav a.active");
    var pill   = SB.$("#navPill");
    var nav    = SB.$(".nav");
    if (!active || !pill || !nav) return;
    var nr = nav.getBoundingClientRect();
    var ar = active.getBoundingClientRect();
    pill.style.left  = (ar.left - nr.left) + "px";
    pill.style.width = ar.width + "px";
  };
  requestAnimationFrame(function () {
    SB._movePill();
    setTimeout(SB._movePill, 80);
  });
  window.addEventListener("resize", SB._movePill);

  /* Soft MPA navigation via View Transitions when available */
  SB.$$(".nav a[data-nav], .logo").forEach(function (a) {
    a.addEventListener("click", function (e) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target === "_blank") return;
      if (!document.startViewTransition) return;
      var href = a.getAttribute("href");
      if (!href || href.charAt(0) === "#") return;
      e.preventDefault();
      document.startViewTransition(function () {
        window.location.href = a.href;
      });
    });
  });

  /* segmented mode-switch track */
  SB._moveSegTrack = function () {
    var seg   = SB.$("#modeSeg");
    var track = SB.$("#modeSegTrack");
    if (!seg || !track) return;
    var active = seg.querySelector("button.is-on");
    if (!active) return;
    var sr = seg.getBoundingClientRect();
    var br = active.getBoundingClientRect();
    track.style.left  = (br.left - sr.left - 3) + "px";
    track.style.width = br.width + "px";
  };
  setTimeout(SB._moveSegTrack, 120);
  var modeSeg = SB.$("#modeSeg");
  if (modeSeg) modeSeg.addEventListener("click", function () { setTimeout(SB._moveSegTrack, 10); });

  var settingsBtn = SB.$("#settingsBtn");
  var backdrop = SB.$("#drawerBackdrop");
  var closeBtn = SB.$("#drawerClose");
  if (settingsBtn) settingsBtn.addEventListener("click", function () { SB.openDrawer("settingsDrawer"); });
  if (backdrop) backdrop.addEventListener("click", SB.closeDrawer);
  if (closeBtn) closeBtn.addEventListener("click", SB.closeDrawer);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") SB.closeDrawer();
  });

  SB.applyTheme();

  /* active nav state */
  var view = document.body.getAttribute("data-view");
  SB.$$(".nav a[data-nav]").forEach(function (a) {
    if (a.getAttribute("data-nav") === view) a.classList.add("active");
  });

  if (SB.paintAuthSlot) SB.paintAuthSlot();
};
