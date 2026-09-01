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
    bindVoice();
    bindToggle("setMirror", "mirror");
    bindToggle("setLandmarks", "landmarks");
    bindToggle("setReduceMotion", "reduceMotion");
    bindRate();
    bindThreshold();
    bindReset();
    syncForm();
  }

  function bindTheme() {
    SB.$("#setTheme").addEventListener("change", function (e) {
      SB.settings.theme = e.target.value;
      SB.saveSettings();
      SB.applyTheme();
    });
  }

  function bindVoice() {
    var sel = SB.$("#setVoice");
    function fill() {
      sel.innerHTML = '<option value="">Default voice</option>';
      (SB.voices || []).forEach(function (v) {
        var o = document.createElement("option");
        o.value = v.name;
        o.textContent = v.name + " (" + v.lang + ")";
        sel.appendChild(o);
      });
      sel.value = SB.settings.voice || "";
    }
    if (SB.voices.length) fill();
    else setTimeout(fill, 400); // voices load async
    sel.addEventListener("change", function (e) {
      SB.settings.voice = e.target.value || null;
      SB.saveSettings();
    });
  }

  function bindToggle(id, key) {
    var btn = SB.$("#" + id);
    btn.addEventListener("click", function () {
      SB.settings[key] = !SB.settings[key];
      SB.saveSettings();
      syncForm();
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
    SB.$("#setTheme").value = SB.settings.theme;
    SB.$("#setMirror").classList.toggle("is-on", SB.settings.mirror);
    SB.$("#setLandmarks").classList.toggle("is-on", SB.settings.landmarks);
    SB.$("#setReduceMotion").classList.toggle("is-on", SB.settings.reduceMotion);
    SB.$("#setRate").value = SB.settings.rate;
    SB.$("#setRateVal").textContent = SB.settings.rate + "×";
    SB.$("#setRate").style.setProperty("--fill", ((SB.settings.rate - 0.5) / 1.5 * 100) + "%");
    SB.$("#setThreshold").value = SB.settings.threshold;
    SB.$("#setThresholdVal").textContent = SB.confPct(SB.settings.threshold) + " → 'check this'";
    SB.$("#setThreshold").style.setProperty("--fill", ((SB.settings.threshold - 0.3) / 0.5 * 100) + "%");
  }

  return { bind: bind };
};
