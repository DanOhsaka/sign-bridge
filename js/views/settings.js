/* ============================================================
   SignBridge — Settings drawer (settings.js)
   Everything persists to localStorage via SB.settings and is
   applied live. New settings = one entry in SB.DEFAULTS +
   one row here.
   ============================================================ */

window.SB = window.SB || {};

SB.SettingsView = function () {

  function bind() {
    bindTheme();
    bindSpeakLang();
    bindVoice();
    bindToggle("setMirror", "mirror");
    bindToggle("setLandmarks", "landmarks");
    bindToggle("setReduceMotion", "reduceMotion");
    bindToggle("setPerfHud", "perfHud");
    bindRate();
    bindThreshold();
    bindReset();
    syncForm();
  }

  function bindSpeakLang() {
    var sel = SB.$("#setSpeakLang");
    if (!sel) return;
    sel.innerHTML = "";
    (SB.SPEAK_LANGS || []).forEach(function (l) {
      var o = document.createElement("option");
      o.value = l.code;
      o.textContent = l.label;
      sel.appendChild(o);
    });
    sel.value = SB.settings.speakLang || "en";
    sel.addEventListener("change", function (e) {
      SB.settings.speakLang = e.target.value || "en";
      /* Clear a mismatched manual voice so we auto-pick for the new language */
      var meta = SB._speakLangMeta(SB.settings.speakLang);
      var cur = (SB.voices || []).find(function (v) { return v.name === SB.settings.voice; });
      if (cur && (cur.lang || "").toLowerCase().indexOf(meta.code) !== 0) {
        SB.settings.voice = null;
      }
      SB.saveSettings();
      bindVoiceFill();
    });
  }

  function bindVoiceFill() {
    var sel = SB.$("#setVoice");
    if (!sel) return;
    var meta = SB._speakLangMeta(SB.settings.speakLang || "en");
    var base = meta.code;
    sel.innerHTML = '<option value="">Auto (' + (meta.label || base) + ")</option>";
    var list = (SB.voices || []).slice().sort(function (a, b) {
      var am = (a.lang || "").toLowerCase().indexOf(base) === 0 ? 0 : 1;
      var bm = (b.lang || "").toLowerCase().indexOf(base) === 0 ? 0 : 1;
      return am - bm || a.name.localeCompare(b.name);
    });
    list.forEach(function (v) {
      var o = document.createElement("option");
      o.value = v.name;
      o.textContent = v.name + " (" + v.lang + ")";
      sel.appendChild(o);
    });
    sel.value = SB.settings.voice || "";
  }

  function bindTheme() {
    SB.$("#setTheme").addEventListener("change", function (e) {
      if (SB.setTheme) SB.setTheme(e.target.value);
      else {
        SB.settings.theme = e.target.value;
        SB.saveSettings();
        SB.applyTheme();
      }
    });
  }

  function bindVoice() {
    var sel = SB.$("#setVoice");
    if (!sel) return;
    if (SB.voices.length) bindVoiceFill();
    else setTimeout(bindVoiceFill, 400); // voices load async
    sel.addEventListener("change", function (e) {
      SB.settings.voice = e.target.value || null;
      /* If user picks a voice, align speakLang to that voice's language */
      if (SB.settings.voice) {
        var v = (SB.voices || []).find(function (x) { return x.name === SB.settings.voice; });
        if (v && v.lang) {
          var code = String(v.lang).split("-")[0].toLowerCase();
          if (code && code !== SB.settings.speakLang) {
            SB.settings.speakLang = code;
            var langSel = SB.$("#setSpeakLang");
            if (langSel) langSel.value = code;
          }
        }
      }
      SB.saveSettings();
    });
  }

  function bindToggle(id, key) {
    var btn = SB.$("#" + id);
    btn.addEventListener("click", function () {
      SB.settings[key] = !SB.settings[key];
      SB.saveSettings();
      syncForm();
      if (key === "reduceMotion") {
        SB.applyTheme();
        if (SB.refreshThreeMotion) SB.refreshThreeMotion();
      }
      /* Keep live camera overlay/mirror in sync with settings drawer */
      try {
        var eng = SB.Engine && SB.Engine.getLiveEngine && SB.Engine.getLiveEngine();
        if (eng) {
          if (key === "landmarks" && eng.setDrawLandmarks) eng.setDrawLandmarks(SB.settings.landmarks);
          if (key === "mirror" && eng.setMirror) {
            eng.setMirror(SB.settings.mirror);
            var stage = SB.$("#stage");
            if (stage) stage.classList.toggle("is-mirror", !!SB.settings.mirror && stage.classList.contains("is-cam"));
          }
          if (key === "perfHud" && eng.setShowHud) eng.setShowHud(!!SB.settings.perfHud);
        }
      } catch (e) {}
    });
  }

  function bindRate() {
    var r = SB.$("#setRate");
    var v = SB.$("#setRateVal");
    r.addEventListener("input", function () {
      SB.settings.rate = +r.value;
      v.textContent = r.value + "×";
      r.style.setProperty("--fill", ((r.value - 0.5) / 1.5 * 100) + "%");
      SB.saveSettings();
    });
  }

  function bindThreshold() {
    var r = SB.$("#setThreshold");
    var v = SB.$("#setThresholdVal");
    r.addEventListener("input", function () {
      SB.settings.threshold = +r.value;
      v.textContent = SB.confPct(r.value) + " → 'check this'";
      r.style.setProperty("--fill", ((r.value - 0.3) / 0.5 * 100) + "%");
      SB.saveSettings();
    });
  }

  function bindReset() {
    SB.$("#setReset").addEventListener("click", function () {
      SB.store.set("progress", null);
      SB.store.set("settings", null);
      location.reload();
    });
  }

  function syncForm() {
    var theme = SB.$("#setTheme");
    if (theme) theme.value = SB.settings.theme;
    var speakLang = SB.$("#setSpeakLang");
    if (speakLang) speakLang.value = SB.settings.speakLang || "en";
    var mirror = SB.$("#setMirror");
    if (mirror) mirror.classList.toggle("is-on", SB.settings.mirror);
    var landmarks = SB.$("#setLandmarks");
    if (landmarks) landmarks.classList.toggle("is-on", SB.settings.landmarks);
    var reduce = SB.$("#setReduceMotion");
    if (reduce) reduce.classList.toggle("is-on", SB.settings.reduceMotion);
    var perfHud = SB.$("#setPerfHud");
    if (perfHud) perfHud.classList.toggle("is-on", !!SB.settings.perfHud);
    var rate = SB.$("#setRate");
    var rateVal = SB.$("#setRateVal");
    if (rate) {
      rate.value = SB.settings.rate;
      rate.style.setProperty("--fill", ((SB.settings.rate - 0.5) / 1.5 * 100) + "%");
    }
    if (rateVal) rateVal.textContent = SB.settings.rate + "×";
    var thr = SB.$("#setThreshold");
    var thrVal = SB.$("#setThresholdVal");
    if (thr) {
      thr.value = SB.settings.threshold;
      thr.style.setProperty("--fill", ((SB.settings.threshold - 0.3) / 0.5 * 100) + "%");
    }
    if (thrVal) thrVal.textContent = SB.confPct(SB.settings.threshold) + " → 'check this'";
  }

  return { bind: bind };
};
