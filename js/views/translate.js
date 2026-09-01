/* ============================================================
   SignBridge — Translate view (translate.js)
   ------------------------------------------------------------
   Two-column learning arc: signing space (left) ↔ live
   transcript (right). Everything the learner does here lands in
   the transcript, where confidence and alternates make the
   machine's "reading" visible and correctable.
   ============================================================ */

window.SB = window.SB || {};

SB.TranslateView = function () {
  var transcript = null;
  var spotlight = null;

  function live() { return SB.Engine.getLiveEngine(); }

  function init() {
    transcript = new SB.Transcript(SB.$("#transcript"));
    spotlight = SB.Spotlight(SB.$("#spotlight"));

    SB.Engine.on("result", function (tok) {
      if (SB.Engine.getMode() === "live") {
        transcript.addToken(tok);
        spotlight.show(tok);
        transcript.endUtterance();
      }
    });

    /* hand-presence → status line pulse */
    SB.Engine.on("hands", function (count) {
      var st = SB.$("#stageStatus");
      if (!st) return;
      if (count > 0) {
        st.classList.add("is-hands");
        st.innerHTML = '<span class="dot"></span>Hand detected — ' +
          (live().hasClassifier()
            ? "recognizing…"
            : "landmarks tracking. Attach your classifier to start recognizing (see docs/MODELS.md).");
      } else {
        st.classList.remove("is-hands");
        st.innerHTML = '<span class="dot"></span>Move a hand into view…';
      }
    });

    bindModeSwitch();
    bindToggles();
    bindQuickPhrases();
    bindSpellStrip();
    bindDemoActions();
    bindTranscriptActions();
    setPill("demo");
  }

  /* ---------- engine status pill (topbar) ---------- */
  function setPill(mode, err) {
    var pill = SB.$("#enginePill");
    if (!pill) return;
    pill.className = "engine-pill is-" + (err ? "error" : mode);
    SB.$(".pill-text", pill).textContent = err ? "Camera unavailable" : (mode === "live" ? "Live · model ready" : "Demo · simulated");
  }

  /* ---------- Demo / Live mode switch ---------- */
  function bindModeSwitch() {
    SB.$$("#modeSeg button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (btn.classList.contains("is-on")) return;
        SB.$$("#modeSeg button").forEach(function (b) { b.classList.remove("is-on"); });
        btn.classList.add("is-on");
        var mode = btn.dataset.mode;
        if (mode === "live") { goLive(); } else { goDemo(); }
      });
    });
  }

  function goDemo() {
    if (live().getState() !== "off") { live().stop(); SB.Engine._hands(0); }
    SB.Engine.setMode("demo");
    SB.$("#stage").classList.remove("is-cam");
    SB.$("#stageDemo").style.display = "";
    SB.$("#mirrorToggle").classList.remove("is-on");
    var st = SB.$("#stageStatus");
    if (st) { st.classList.remove("is-hands"); st.innerHTML = '<span class="dot"></span>Demo engine — recognition is simulated so the full UI works before the model is trained.'; }
    setPill("demo");
  }

  function goLive() {
    var stage = SB.$("#stage");
    SB.Engine.setMode("live", {
      videoEl: SB.$("#cam"),
      canvasEl: SB.$("#overlay"),
      mirror: SB.settings.mirror,
      drawLandmarks: SB.settings.landmarks,
    }).then(function () {
      stage.classList.add("is-cam");
      SB.$("#stageDemo").style.display = "none";
      SB.$("#mirrorToggle").classList.toggle("is-on", SB.settings.mirror);
      SB.$("#landmarkToggle").classList.toggle("is-on", SB.settings.landmarks);
      setPill("live");
      SB.toast(live().hasClassifier()
        ? "Live engine on — hand tracking + your classifier"
        : "Live engine on — hand landmarks tracking (attach a classifier to recognize)", "ok");
    }).catch(function (err) {
      setPill("demo", true);
      SB.toast("Live mode needs a camera — " + (err && err.message ? err.message : "unavailable") + ". Staying in demo.", "error");
      SB.$$("#modeSeg button").forEach(function (b) { b.classList.toggle("is-on", b.dataset.mode === "demo"); });
    });
  }

  /* ---------- stage toggles ---------- */
  function bindToggles() {
    var mirrorBtn = SB.$("#mirrorToggle");
    mirrorBtn.addEventListener("click", function () {
      SB.settings.mirror = !SB.settings.mirror;
      SB.saveSettings();
      mirrorBtn.classList.toggle("is-on", SB.settings.mirror);
      SB.toast("Mirror mode " + (SB.settings.mirror ? "on" : "off"), "info");
    });

    var lmBtn = SB.$("#landmarkToggle");
    lmBtn.addEventListener("click", function () {
      SB.settings.landmarks = !SB.settings.landmarks;
      SB.saveSettings();
      lmBtn.classList.toggle("is-on", SB.settings.landmarks);
      SB.toast("Landmark overlay " + (SB.settings.landmarks ? "on" : "off"), "info");
    });
  }

  /* ---------- quick phrases (chips + hotkeys 1–9) ---------- */
  function bindQuickPhrases() {
    var wrap = SB.$("#quickChips");
    SB.QUICK_PHRASES.forEach(function (p, i) {
      var btn = document.createElement("button");
      btn.className = "chip";
      btn.innerHTML = '<span>' + p.emoji + "</span> " + SB.PHRASE_MAP[p.id].name + '<span class="kbd-hint">' + (i + 1) + "</span>";
      btn.addEventListener("click", function () { signPhrase(p.id); });
      wrap.appendChild(btn);
    });

    document.addEventListener("keydown", function (e) {
      if (e.target.tagName === "INPUT") return;
      var n = parseInt(e.key, 10);
      if (n >= 1 && n <= SB.QUICK_PHRASES.length) {
        signPhrase(SB.QUICK_PHRASES[n - 1].id);
      }
    });
  }

  function signPhrase(id) {
    var p = SB.PHRASE_MAP[id];
    if (!p) return;
    transcript.endUtterance();
    SB.Engine.signPhrase(id, function (tok) {
      transcript.addToken(tok, {});
      spotlight.show(tok);
    }).then(function () { transcript.endUtterance(); });
  }

  /* ---------- spell strip: type any word, watch it fingerspelled ---------- */
  function bindSpellStrip() {
    var input = SB.$("#spellInput");
    var go = SB.$("#spellGo");

    function spell() {
      var text = input.value.trim().toUpperCase();
      if (!text) return;
      if (text.length > 24) { SB.toast("Keep it under 24 characters for the demo", "error"); return; }
      input.value = "";
      transcript.endUtterance();
      var tokens = text.split("").map(function (ch) {
        if (!/^[A-Z0-9]$/.test(ch)) return null;
        var glyph = /^[0-9]$/.test(ch) ? { "1": "☝️", "2": "✌️", "3": "🤟", "4": "🖖", "5": "🖐️" }[ch] || null : null;
        return { text: ch, conf: 0.93, glyph: glyph };
      }).filter(Boolean);
      SB.Engine.signTokens(tokens, function (tok) {
        transcript.addToken(tok);
        spotlight.show(tok);
      }).then(function () { transcript.endUtterance(); });
    }

    go.addEventListener("click", spell);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") spell(); });
  }

  /* ---------- watch-demo + transcript actions ---------- */
  function bindDemoActions() {
    SB.$("#watchDemo").addEventListener("click", function () {
      if (SB.Engine.getMode() !== "demo") return;
      transcript.endUtterance();
      SB.Engine.signDemo(function (tok) {
        transcript.addToken(tok);
        spotlight.show(tok);
      }).then(function () { transcript.endUtterance(); });
    });

    /* "Try real hand tracking" inside the demo stage */
    var goLive = SB.$("[data-go-live]");
    if (goLive) goLive.addEventListener("click", function () {
      var btn = SB.$('#modeSeg button[data-mode="live"]');
      if (btn) btn.click();
    });
  }

  function bindTranscriptActions() {
    SB.$("#tClear").addEventListener("click", function () {
      transcript.clear();
      spotlight.clear();
    });
    SB.$("#tCopy").addEventListener("click", function () {
      var text = transcript.allText();
      if (!text) { SB.toast("Nothing to copy yet", "info"); return; }
      SB.copyText(text);
    });
    SB.$("#tSpeak").addEventListener("click", function () {
      var text = transcript.allText();
      if (!text) { SB.toast("Nothing to speak yet", "info"); return; }
      SB.speak(text);
    });
  }

  return { init: init };
};
