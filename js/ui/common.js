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
SB.applyTheme = function () {
  var pref = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  var theme = SB.settings.theme === "auto" ? pref : SB.settings.theme;
  document.documentElement.setAttribute("data-theme", theme);
  var btn = SB.$("#themeBtn");
  if (btn) btn.textContent = theme === "dark" ? "☾" : "☀";
};

SB.toggleTheme = function () {
  var order = ["dark", "light", "auto"];
  SB.settings.theme = order[(order.indexOf(SB.settings.theme) + 1) % order.length];
  SB.saveSettings();
  SB.applyTheme();
  SB.toast("Theme: " + SB.settings.theme, "info");
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

  /* global topbar wiring */
  var themeBtn = SB.$("#themeBtn");
  if (themeBtn) themeBtn.addEventListener("click", SB.toggleTheme);

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
