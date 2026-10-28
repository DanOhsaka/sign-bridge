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
  speakLang: "en",        // BCP-47 primary tag for TTS output language
  rate: 1,
  reduceMotion: false,
  perfHud: false,         // Opt-in FPS/latency HUD only (?perf=1 / Settings)
  mode: "demo",
};

/* Languages offered in Settings → Speak language (transcript is English/ASL gloss) */
SB.SPEAK_LANGS = [
  { code: "en", label: "English", bcp47: "en-US" },
  { code: "es", label: "Spanish", bcp47: "es-ES" },
  { code: "fr", label: "French", bcp47: "fr-FR" },
  { code: "de", label: "German", bcp47: "de-DE" },
  { code: "it", label: "Italian", bcp47: "it-IT" },
  { code: "pt", label: "Portuguese", bcp47: "pt-BR" },
  { code: "zh", label: "Chinese", bcp47: "zh-CN" },
  { code: "ja", label: "Japanese", bcp47: "ja-JP" },
  { code: "ko", label: "Korean", bcp47: "ko-KR" },
  { code: "hi", label: "Hindi", bcp47: "hi-IN" },
  { code: "ar", label: "Arabic", bcp47: "ar-SA" },
];

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
SB.prefersReducedMotion = function () {
  if (SB.settings && SB.settings.reduceMotion) return true;
  try {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch (e) { return false; }
};

SB.resolveTheme = function () {
  var pref = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  return SB.settings.theme === "auto" ? pref : SB.settings.theme;
};

SB._themeAnimTimer = 0;

SB.applyTheme = function (opts) {
  opts = opts || {};
  var theme = SB.resolveTheme();
  var root = document.documentElement;
  var prev = root.getAttribute("data-theme");
  var reduce = SB.prefersReducedMotion();

  root.classList.toggle("reduce-motion", !!(SB.settings && SB.settings.reduceMotion));

  /* Mark a short anim window so CSS can use longer token transitions.
     Skip when reduced-motion or when theme did not change (resize / init). */
  if (!reduce && opts.animate !== false && prev && prev !== theme) {
    root.classList.add("sb-theme-changing");
    if (SB._themeAnimTimer) clearTimeout(SB._themeAnimTimer);
    SB._themeAnimTimer = setTimeout(function () {
      root.classList.remove("sb-theme-changing");
      SB._themeAnimTimer = 0;
    }, 420);
  }

  if (prev !== theme) root.setAttribute("data-theme", theme);
  else if (!prev) root.setAttribute("data-theme", theme);

  SB._positionThemePill(theme);
};

/* CSS-driven pill — toggle classes only (no getBoundingClientRect thrash). */
SB._positionThemePill = function (theme) {
  var sw = SB.$("#themeSwitch");
  if (!sw) return;

  var resolved = theme;
  if (resolved === "auto") {
    resolved = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }

  /* Clear any legacy inline geometry from older builds */
  var pill = SB.$("#tsPill");
  if (pill) {
    pill.style.left = "";
    pill.style.width = "";
  }

  sw.classList.toggle("is-dark", resolved === "dark");
  sw.classList.toggle("is-light", resolved === "light");
  sw.setAttribute("aria-checked", resolved === "light" ? "true" : "false");
  sw.setAttribute("aria-label", resolved === "light" ? "Theme: Light" : "Theme: Dark");
};

SB.setTheme = function (theme) {
  if (theme !== "dark" && theme !== "light" && theme !== "auto") return;
  var before = SB.resolveTheme();
  SB.settings.theme = theme;
  SB.saveSettings();
  var after = SB.resolveTheme();
  SB.applyTheme({ animate: before !== after });
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
SB._translateCache = SB._translateCache || {};

SB.loadVoices = function () {
  var fill = function () {
    SB.voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  };
  fill();
  if (window.speechSynthesis && speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.onvoiceschanged = fill;
  }
};

SB._speakLangMeta = function (code) {
  var c = (code || "en").split("-")[0].toLowerCase();
  return SB.SPEAK_LANGS.find(function (l) { return l.code === c; }) ||
    { code: c, label: c, bcp47: c };
};

SB._pickVoiceForLang = function (bcp47) {
  var voices = SB.voices || [];
  if (!voices.length) return null;
  var primary = (bcp47 || "en").toLowerCase();
  var base = primary.split("-")[0];
  function matchesLang(v) {
    var lang = (v.lang || "").toLowerCase();
    return lang === primary || lang.indexOf(base) === 0;
  }
  /* Named voice only if it actually speaks the target language —
     never force an English voice onto translated text (sounds like an accent). */
  var want = SB.settings.voice;
  if (want) {
    var named = voices.find(function (v) { return v.name === want; });
    if (named && matchesLang(named)) return named;
  }
  return (
    voices.find(function (v) { return (v.lang || "").toLowerCase() === primary; }) ||
    voices.find(function (v) { return matchesLang(v); }) ||
    null
  );
};

/* ASL gloss → natural phrase per speak language (MyMemory fails on HELLO/ALL-CAPS). */
SB.SPEAK_GLOSSARY = {
  hello: {
    es: "Hola", fr: "Bonjour", de: "Hallo", it: "Ciao", pt: "Olá",
    zh: "你好", ja: "こんにちは", ko: "안녕하세요", hi: "नमस्ते", ar: "مرحبا"
  },
  hi: {
    es: "Hola", fr: "Salut", de: "Hi", it: "Ciao", pt: "Oi",
    zh: "嗨", ja: "こんにちは", ko: "안녕", hi: "नमस्ते", ar: "مرحبا"
  },
  my: {
    es: "mi", fr: "mon", de: "mein", it: "mio", pt: "meu",
    zh: "我的", ja: "私の", ko: "나의", hi: "मेरा", ar: "لي"
  },
  name: {
    es: "nombre", fr: "nom", de: "Name", it: "nome", pt: "nome",
    zh: "名字", ja: "名前", ko: "이름", hi: "नाम", ar: "اسم"
  },
  yes: {
    es: "Sí", fr: "Oui", de: "Ja", it: "Sì", pt: "Sim",
    zh: "是", ja: "はい", ko: "네", hi: "हाँ", ar: "نعم"
  },
  no: {
    es: "No", fr: "Non", de: "Nein", it: "No", pt: "Não",
    zh: "不", ja: "いいえ", ko: "아니요", hi: "नहीं", ar: "لا"
  },
  thanks: {
    es: "Gracias", fr: "Merci", de: "Danke", it: "Grazie", pt: "Obrigado",
    zh: "谢谢", ja: "ありがとう", ko: "감사합니다", hi: "धन्यवाद", ar: "شكرا"
  },
  thank: {
    es: "Gracias", fr: "Merci", de: "Danke", it: "Grazie", pt: "Obrigado",
    zh: "谢谢", ja: "ありがとう", ko: "감사합니다", hi: "धन्यवाद", ar: "شكرا"
  },
  please: {
    es: "Por favor", fr: "S'il vous plaît", de: "Bitte", it: "Per favore", pt: "Por favor",
    zh: "请", ja: "お願いします", ko: "부탁합니다", hi: "कृपया", ar: "من فضلك"
  },
  goodbye: {
    es: "Adiós", fr: "Au revoir", de: "Tschüss", it: "Arrivederci", pt: "Adeus",
    zh: "再见", ja: "さようなら", ko: "안녕히 가세요", hi: "अलविदा", ar: "مع السلامة"
  },
  help: {
    es: "Ayuda", fr: "Aide", de: "Hilfe", it: "Aiuto", pt: "Ajuda",
    zh: "帮助", ja: "助けて", ko: "도와주세요", hi: "मदद", ar: "مساعدة"
  },
  love: {
    es: "Amor", fr: "Amour", de: "Liebe", it: "Amore", pt: "Amor",
    zh: "爱", ja: "愛", ko: "사랑", hi: "प्यार", ar: "حب"
  },
  friend: {
    es: "Amigo", fr: "Ami", de: "Freund", it: "Amico", pt: "Amigo",
    zh: "朋友", ja: "友達", ko: "친구", hi: "दोस्त", ar: "صديق"
  },
  "thank you": {
    es: "Gracias", fr: "Merci", de: "Danke", it: "Grazie", pt: "Obrigado",
    zh: "谢谢", ja: "ありがとう", ko: "감사합니다", hi: "धन्यवाद", ar: "شكرا"
  },
  "my name": {
    es: "Me llamo", fr: "Je m'appelle", de: "Ich heiße", it: "Mi chiamo", pt: "Meu nome é",
    zh: "我叫", ja: "私の名前は", ko: "제 이름은", hi: "मेरा नाम", ar: "اسمي"
  },
  "hello my name": {
    es: "Hola, me llamo", fr: "Bonjour, je m'appelle", de: "Hallo, ich heiße",
    it: "Ciao, mi chiamo", pt: "Olá, meu nome é",
    zh: "你好，我叫", ja: "こんにちは、私の名前は", ko: "안녕하세요, 제 이름은",
    hi: "नमस्ते, मेरा नाम", ar: "مرحبا، اسمي"
  }
};

/** ALL-CAPS ASL gloss → sentence case so MyMemory accepts it. */
SB._normalizeForTranslate = function (text) {
  var s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  var letters = s.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 2 && letters === letters.toUpperCase()) {
    return s.toLowerCase().replace(/(^|\s)([a-z])/g, function (_, a, b) {
      return a + b.toUpperCase();
    });
  }
  return s;
};

SB._glossaryLookup = function (text, lang) {
  var key = String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!key) return null;
  var dst = (lang || "").split("-")[0].toLowerCase();
  var table = SB.SPEAK_GLOSSARY || {};
  if (table[key] && table[key][dst]) return table[key][dst];
  /* Word-by-word for multi-gloss phrases when every token is known */
  var parts = key.split(" ");
  if (parts.length < 2) return null;
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var row = table[parts[i]];
    if (!row || !row[dst]) return null;
    out.push(row[dst]);
  }
  return out.join(" ");
};

SB._isSameLanguageText = function (a, b) {
  return String(a || "").replace(/\s+/g, " ").trim().toLowerCase() ===
    String(b || "").replace(/\s+/g, " ").trim().toLowerCase();
};

SB._looksUntranslated = function (source, translated, dst) {
  var out = String(translated || "").trim();
  if (!out) return true;
  if (/MYMEMORY WARNING/i.test(out)) return true;
  if (/^testvalue$/i.test(out)) return true;
  if (SB._isSameLanguageText(source, out)) return true;
  /* Latin script target got back pure ASCII matching English words only */
  var srcLetters = String(source || "").replace(/[^A-Za-z]/g, "").toLowerCase();
  var outLetters = out.replace(/[^A-Za-z\u00C0-\u024F]/g, "").toLowerCase();
  if (dst === "ja" || dst === "zh" || dst === "ko" || dst === "ar" || dst === "hi") {
    /* Must contain non-Latin for these scripts when source was English letters */
    if (srcLetters && !/[^\u0000-\u007F]/.test(out)) return true;
  }
  return false;
};

/**
 * Translate English source text → target language.
 * Prefers same-origin /api/translate (MyMemory proxy), then direct MyMemory.
 * Normalizes ALL-CAPS glosses and uses a local glossary so HELLO→Hola/こんにちは.
 */
SB.translateText = function (text, fromLang, toLang) {
  var src = (fromLang || "en").split("-")[0].toLowerCase();
  var dst = (toLang || "en").split("-")[0].toLowerCase();
  var trimmed = String(text || "").replace(/\s+/g, " ").trim();
  if (!trimmed) return Promise.resolve("");
  if (src === dst) return Promise.resolve(trimmed);

  var cacheKey = src + "|" + dst + "|" + trimmed.toLowerCase();
  if (SB._translateCache[cacheKey]) {
    return Promise.resolve(SB._translateCache[cacheKey]);
  }

  var normalized = SB._normalizeForTranslate(trimmed);
  var gloss = SB._glossaryLookup(normalized, dst) || SB._glossaryLookup(trimmed, dst);
  if (gloss) {
    SB._translateCache[cacheKey] = gloss;
    return Promise.resolve(gloss);
  }

  function accept(out) {
    var translated = String(out || "").trim();
    if (SB._looksUntranslated(trimmed, translated, dst) &&
        SB._looksUntranslated(normalized, translated, dst)) {
      throw new Error("untranslated");
    }
    return translated;
  }

  function viaMyMemory(q) {
    var url =
      "https://api.mymemory.translated.net/get?q=" +
      encodeURIComponent(String(q).slice(0, 450)) +
      "&langpair=" + encodeURIComponent(src + "|" + dst);
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error("translate HTTP " + res.status);
      return res.json();
    }).then(function (data) {
      var out = data && data.responseData && data.responseData.translatedText;
      if (!out || /MYMEMORY WARNING/i.test(out)) {
        throw new Error((data && data.responseDetails) || "translate failed");
      }
      return accept(out);
    });
  }

  function viaProjectApi(q) {
    var base = (typeof SB.API_BASE === "string" ? SB.API_BASE : "");
    return fetch(base + "/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: q, source: src, target: dst }),
    }).then(function (res) {
      if (!res.ok) throw new Error("api translate " + res.status);
      return res.json();
    }).then(function (data) {
      if (!data || !data.translatedText) throw new Error("empty api translate");
      return accept(data.translatedText);
    });
  }

  /* Same-origin proxy first (CORS-safe), then browser → MyMemory.
     Try sentence-case query; ALL-CAPS HELLO is rejected by MyMemory. */
  var query = normalized || trimmed;
  return viaProjectApi(query)
    .catch(function () { return viaMyMemory(query); })
    .then(function (translated) {
      SB._translateCache[cacheKey] = translated;
      return translated;
    });
};

/**
 * Speak transcript text. English path is unchanged (no network).
 * Other speakLang values: translate EN → target, then speak ONLY the
 * translated text with a matching-language voice — never English+accent.
 */
SB.speak = function (text) {
  if (!window.speechSynthesis) {
    SB.toast("Speech synthesis not available in this browser", "error");
    return;
  }
  var raw = String(text || "").trim();
  if (!raw) return;

  var meta = SB._speakLangMeta(SB.settings.speakLang || "en");
  var bcp47 = meta.bcp47 || meta.code || "en-US";

  function utter(spoken) {
    var say = String(spoken || "").trim();
    if (!say) return;
    speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(say);
    u.lang = bcp47;
    u.rate = SB.settings.rate || 1;
    var voice = SB._pickVoiceForLang(bcp47);
    if (voice) {
      u.voice = voice;
      if (voice.lang) u.lang = voice.lang;
    }
    speechSynthesis.speak(u);
  }

  if (meta.code === "en") {
    utter(raw);
    return;
  }

  SB.toast("Translating to " + (meta.label || meta.code) + "…", "info");
  SB.translateText(raw, "en", meta.code).then(function (translated) {
    var out = String(translated || "").trim();
    if (!out) throw new Error("empty translation");
    if (SB._looksUntranslated(raw, out, meta.code)) {
      throw new Error("still english");
    }
    utter(out);
  }).catch(function () {
    SB.toast(
      "Translation unavailable — won't speak English with a " +
        (meta.label || meta.code) + " accent. Try again or pick English.",
      "error"
    );
  });
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
  var drawer = SB.$("#" + id);
  var backdrop = SB.$("#drawerBackdrop");
  if (drawer) drawer.classList.add("is-open");
  if (backdrop) backdrop.classList.add("is-open");
};
SB.closeDrawer = function () {
  SB.$$(".drawer").forEach(function (d) { d.classList.remove("is-open"); });
  var backdrop = SB.$("#drawerBackdrop");
  if (backdrop) backdrop.classList.remove("is-open");
};

SB.initCommon = function () {
  SB.loadVoices();

  /* ensure settings starts closed (guards against stale classes) */
  SB.closeDrawer();

  /* global topbar wiring — sliding theme switch (CSS pill, no layout measure) */
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
    themeSwitch.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        if (e.key === "ArrowLeft") SB.setTheme("dark");
        else if (e.key === "ArrowRight") SB.setTheme("light");
        else SB.toggleTheme();
      }
    });
    if (!themeSwitch.hasAttribute("tabindex")) themeSwitch.setAttribute("tabindex", "0");
    /* Initial class sync without animating */
    SB.applyTheme({ animate: false });
  }

  /* Ensure every page has a sliding nav pill */
  var navEl = SB.$(".nav");
  if (navEl && !SB.$("#navPill", navEl)) {
    var pillEl = document.createElement("div");
    pillEl.className = "nav-pill";
    pillEl.id = "navPill";
    navEl.insertBefore(pillEl, navEl.firstChild);
  }

  /* active nav state BEFORE first pill measure */
  var view = document.body.getAttribute("data-view");
  SB.$$(".nav a[data-nav]").forEach(function (a) {
    a.classList.toggle("active", a.getAttribute("data-nav") === view);
  });

  /* nav sliding pill — same duration as theme via CSS --sb-nav-dur */
  SB._navOrder = { translate: 0, practice: 1, learn: 2 };
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

  /* MPA nav: stash direction for cross-doc View Transitions, then let
     `@view-transition { navigation: auto }` run (do NOT preventDefault —
     that broke Live/Three teardown and skipped the browser VT path). */
  SB.$$(".nav a[data-nav]").forEach(function (a) {
    a.addEventListener("click", function (e) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target === "_blank") return;
      if (SB.prefersReducedMotion && SB.prefersReducedMotion()) return;
      var href = a.getAttribute("href");
      if (!href || href.charAt(0) === "#") return;
      var to = a.getAttribute("data-nav");
      var from = document.body.getAttribute("data-view") || "";
      if (to === from) {
        e.preventDefault();
        return;
      }
      var fromI = SB._navOrder[from];
      var toI = SB._navOrder[to];
      var dir = "0";
      if (typeof fromI === "number" && typeof toI === "number" && toI !== fromI) {
        dir = toI > fromI ? "1" : "-1";
      }
      try {
        sessionStorage.setItem("sb.navDir", dir);
        sessionStorage.setItem("sb.navFrom", from);
        sessionStorage.setItem("sb.navTo", to || "");
      } catch (err) {}
      document.documentElement.setAttribute("data-nav-dir", dir);
      /* Soft-pause Three during nav so the VT snapshot stays cheap;
         next page remounts atmosphere fresh. Live cam ends with unload. */
      if (SB.pauseThreeFX) {
        try { SB.pauseThreeFX(); } catch (err2) {}
      }
    });
  });

  /* segmented mode-switch track — align exactly to the active button
     (do NOT subtract padding; that left a crescent gap on the right) */
  SB._moveSegTrack = function () {
    var seg   = SB.$("#modeSeg");
    var track = SB.$("#modeSegTrack");
    if (!seg || !track) return;
    var active = seg.querySelector("button.is-on");
    if (!active) return;
    var sr = seg.getBoundingClientRect();
    var br = active.getBoundingClientRect();
    track.style.left   = (br.left - sr.left) + "px";
    track.style.top    = (br.top - sr.top) + "px";
    track.style.width  = br.width + "px";
    track.style.height = br.height + "px";
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

  SB.applyTheme({ animate: false });

  if (SB.paintAuthSlot) SB.paintAuthSlot();

  /* BeUI + Aceternity decorative layer (no-ops if effects.js not loaded) */
  if (SB.initEffects) SB.initEffects();
};
