/* ============================================================
   SignBridge â€” Translate view (translate.js)
   ------------------------------------------------------------
   Two-column learning arc: signing space (left) â†” live
   transcript (right). Everything the learner does here lands in
   the transcript, where confidence and alternates make the
   machine's "reading" visible and correctable.
   ============================================================ */

window.SB = window.SB || {};

SB.TranslateView = function () {
  var transcript = null;
  var spotlight = null;
  var lastPrediction = null;
  var lastPredictionTime = 0;

  function live() { return SB.Engine.getLiveEngine(); }

  function init() {
    transcript = new SB.Transcript(SB.$("#transcript"));
    if (SB.Captions) SB.Captions.attach(transcript);   /* phone pages only: captions over the video */
    spotlight = SB.Spotlight(SB.$("#spotlight"));

    SB.Engine.on("result", function (tok) {
      if (SB.Engine.getMode() === "live") {
        transcript.addToken(tok);
        spotlight.show(tok);
        transcript.endUtterance();
      }
    });

    // Receive predictions from the Python LSTM service.
    window.addEventListener(
      "signbridge:lstm-prediction",
      function (event) {

        // Only update the interface in Live mode.
        if (SB.Engine.getMode() !== "live") {
          return;
        }

        var result = event.detail;

        if (!result || !result.prediction) {
          return;
        }

        var now = Date.now();
              
        if (
          result.prediction === lastPrediction &&
          now - lastPredictionTime < 2000
        ) {
          return;
        }
        
        lastPrediction = result.prediction;
        lastPredictionTime = now;

        var token = {
          text: result.prediction,
          conf: result.confidence
        };

        transcript.addToken(token);
        spotlight.show(token);
        transcript.endUtterance();

        console.log(
          "SignBridge transcript updated:",
          token.text
        );
      }
    );


    /* hand-presence â†’ status line pulse */
    SB.Engine.on("hands", function (count) {
      var st = SB.$("#stageStatus");
      if (!st) return;
      if (SB.DataCapture && typeof SB.DataCapture.isRecording === "function" && SB.DataCapture.isRecording()) {
        st.classList.add("is-hands");
        var fc = SB.DataCapture.getCurrentFrameCount();
        st.innerHTML = '<span class="dot"></span>' + (count > 0
          ? "Recording training data — " + fc + " frames captured"
          : "Recording — bring hand into view (" + fc + " frames so far)");
        return;
      }
      if (count > 0) {
        st.classList.add("is-hands");
        var overlayOn = SB.settings.landmarks !== false;
        st.innerHTML = '<span class="dot"></span>Hand detected — ' +
          (live().hasClassifier()
            ? "recognizing…"
            : (overlayOn
              ? "landmark overlay on. Attach your classifier to start recognizing (see docs/MODELS.md)."
              : "tracking, but overlay is off — turn on Landmarks to see the skeleton."));

      } else {
        st.classList.remove("is-hands");
        st.innerHTML = '<span class="dot"></span>Move a hand into viewâ€¦';
      }
    });

    bindModeSwitch();
    bindToggles();
    bindQuickPhrases();
    bindSpellStrip();
    bindDemoActions();
    bindTranscriptActions();
    bindCapturePanel();
    setPill("demo");
    refreshCapturePanelVisibility();
    /* Reflect saved toggle state even before Live starts. */
    var lmChip = SB.$("#landmarkToggle");
    var mirChip = SB.$("#mirrorToggle");
    if (lmChip) lmChip.classList.toggle("is-on", SB.settings.landmarks !== false);
    if (mirChip) mirChip.classList.toggle("is-on", !!SB.settings.mirror);
  }

  /* ---------- LSTM training: labeled landmark sequences (SB.DataCapture) ---------- */
  function bindCapturePanel() {
    var panel = SB.$("#capturePanel");
    if (!panel || !SB.DataCapture) return;

    var labelInput = SB.$("#captureLabel");
    var btnStart = SB.$("#captureStart");
    var btnStop = SB.$("#captureStop");
    var btnCancel = SB.$("#captureCancel");
    var btnDownload = SB.$("#captureDownload");
    var btnClear = SB.$("#captureClear");
    var statusEl = SB.$("#captureStatus");
    var countsEl = SB.$("#captureCounts");

    function paintCaptureMeta(extra) {
      var n = SB.DataCapture.getSampleCount();
      countsEl.textContent = n + " sample" + (n === 1 ? "" : "s") + " in memory";
      if (extra) statusEl.textContent = extra;
    }

    function setRecordingUI(active) {
      panel.classList.toggle("is-recording", active);
      statusEl.classList.toggle("is-recording", active);
      btnStart.disabled = active;
      btnStop.disabled = !active;
      btnCancel.disabled = !active;
      labelInput.disabled = active;
    }

    SB.DataCapture.setProgressListener(function (info) {
      if (info.recording) {
        statusEl.textContent = "Recording \"" + info.label + "\" — " + info.frameCount + " frames (keep hand in view)";
      } else if (SB.Engine.getMode() === "live") {
        statusEl.textContent = "Ready — perform one sign, then Stop & save.";
      }
      paintCaptureMeta();
    });

    btnStart.addEventListener("click", function () {
      if (SB.Engine.getMode() !== "live") {
        SB.toast("Switch to Live mode first (camera + landmarks).", "error");
        return;
      }
      try {
        SB.DataCapture.startRecording(labelInput.value);
      } catch (err) {
        SB.toast(err.message || "Enter a label.", "error");
        return;
      }
      setRecordingUI(true);
      statusEl.textContent = "Recording… move your hand into the frame.";
      SB.toast("Recording — perform the sign once, then Stop & save.", "info");
    });

    btnStop.addEventListener("click", function () {
      var result = SB.DataCapture.stopRecording({ minFrames: 8 });
      setRecordingUI(false);
      if (!result.ok) {
        SB.toast(result.message, "error");
        refreshCaptureIdleStatus();
        return;
      }
      SB.toast("Saved \"" + result.sample.label + "\" (" + result.sample.length + " frames).", "ok");
      refreshCaptureIdleStatus();
      paintCaptureMeta();
    });

    btnCancel.addEventListener("click", function () {
      SB.DataCapture.cancelRecording();
      setRecordingUI(false);
      refreshCaptureIdleStatus();
      SB.toast("Recording cancelled — frames discarded.", "info");
    });

    btnDownload.addEventListener("click", function () {
      var out = SB.DataCapture.downloadJSON();
      if (!out.ok) { SB.toast(out.message, "error"); return; }
      SB.toast("Downloaded " + out.sampleCount + " samples.", "ok");
    });

    btnClear.addEventListener("click", function () {
      if (!SB.DataCapture.getSampleCount()) return;
      SB.DataCapture.clearDataset();
      paintCaptureMeta();
      SB.toast("Cleared in-memory dataset.", "info");
    });

    function refreshCaptureIdleStatus() {
      if (SB.Engine.getMode() !== "live") {
        statusEl.textContent = "Switch to Live mode to record.";
        return;
      }
      statusEl.textContent = "Ready — perform one sign, then Stop & save.";
    }

    refreshCaptureIdleStatus();
    paintCaptureMeta();
  }

  function refreshCapturePanelVisibility() {
    var panel = SB.$("#capturePanel");
    if (!panel) return;
    panel.hidden = SB.Engine.getMode() !== "live";

  }

  /* ---------- engine status pill (topbar) ---------- */
  function setPill(mode, err) {
    var pill = SB.$("#enginePill");
    if (!pill) return;
    pill.className = "engine-pill is-" + (err ? "error" : mode);
    SB.$(".pill-text", pill).textContent = err ? "Camera unavailable" : (mode === "live" ? "Live · " + (live().hasClassifier() ? "model ready" : "tracking") : "Demo Â· simulated");
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

  function setStageOverlay(kind, title, detail) {
    var stage = SB.$("#stage");
    var overlay = SB.$("#stageOverlay");
    if (!stage) return;
    stage.classList.remove("is-starting", "is-error");
    if (!kind) {
      if (overlay) overlay.hidden = true;
      return;
    }
    stage.classList.add(kind === "error" ? "is-error" : "is-starting");
    if (!overlay) return;
    overlay.hidden = false;
    var titleEl = SB.$(".overlay-title", overlay);
    var detailEl = SB.$(".overlay-detail", overlay);
    var spin = SB.$(".spinner", overlay);
    if (titleEl) titleEl.textContent = title || "";
    if (detailEl) detailEl.textContent = detail || "";
    if (spin) spin.style.display = kind === "starting" ? "" : "none";
  }

  function goDemo() {
    if (window.SignBridgeLiveTest) {
      window.SignBridgeLiveTest.stop();
    }
    if (live().getState() !== "off") { live().stop(); SB.Engine._hands(0); }
    SB.Engine.setMode("demo");
    var stage = SB.$("#stage");
    stage.classList.remove("is-cam", "is-mirror");
    stage.style.aspectRatio = "";
    setStageOverlay(null);
    SB.$("#stageDemo").style.display = "";
    SB.$("#mirrorToggle").classList.remove("is-on");
    var st = SB.$("#stageStatus");
    if (st) {
      st.classList.remove("is-hands");
      st.innerHTML = '<span class="dot"></span>Demo engine — recognition is simulated so the full UI works before the model is trained.';
    }

    setPill("demo");
    refreshCapturePanelVisibility();
  }

  function goLive() {
    var stage = SB.$("#stage");
    SB.$("#stageDemo").style.display = "none";
    setStageOverlay("starting", "Starting camera…", "Allow camera access if prompted. Keep your hands in frame.");
    var st = SB.$("#stageStatus");
    if (st) st.innerHTML = '<span class="dot"></span>Requesting camera permission…';

    SB.Engine.setMode("live", {
      videoEl: SB.$("#cam"),
      canvasEl: SB.$("#overlay"),
      mirror: SB.settings.mirror,
      drawLandmarks: SB.settings.landmarks,
    }).then(function () {
      setStageOverlay(null);
      stage.classList.add("is-cam");
      if (SB.Device && SB.Device.isMobile && SB.$("#cam").videoWidth) {
        stage.style.aspectRatio = SB.$("#cam").videoWidth + " / " + SB.$("#cam").videoHeight;  /* keep skeleton aligned to the real frame */
      }
      stage.classList.toggle("is-mirror", !!SB.settings.mirror);
      if (window.SignBridgeLiveTest && typeof window.SignBridgeLiveTest.start === "function") {
        window.SignBridgeLiveTest.start();
      }

      SB.$("#mirrorToggle").classList.toggle("is-on", SB.settings.mirror);
      SB.$("#landmarkToggle").classList.toggle("is-on", SB.settings.landmarks);
      if (live().setDrawLandmarks) live().setDrawLandmarks(SB.settings.landmarks);
      if (live().setMirror) live().setMirror(SB.settings.mirror);
      setPill("live");
      refreshCapturePanelVisibility();
      if (st) st.innerHTML = '<span class="dot"></span>Camera ready — move a hand into view…';

      SB.toast(live().hasClassifier()
        ? "Live engine on â€” hand tracking + your classifier"
        : "Live engine on â€” hand landmarks tracking (attach a classifier to recognize)", "ok");
    }).catch(function (err) {
      if (window.SignBridgeLiveTest && typeof window.SignBridgeLiveTest.stop === "function") {
        window.SignBridgeLiveTest.stop();
      }
      setStageOverlay("error", "Camera unavailable",
        (err && err.message ? err.message : "Permission denied or no camera found.") + " You can stay in Demo mode.");

      setPill("demo", true);
      SB.toast("Live mode needs a camera â€” " + (err && err.message ? err.message : "unavailable") + ". Staying in demo.", "error");
      SB.$$("#modeSeg button").forEach(function (b) { b.classList.toggle("is-on", b.dataset.mode === "demo"); });
      setTimeout(function () {
        setStageOverlay(null);
        goDemo();
        SB.$$("#modeSeg button").forEach(function (b) { b.classList.toggle("is-on", b.dataset.mode === "demo"); });
        if (SB._moveSegTrack) SB._moveSegTrack();
      }, 2200);
    });
  }

  /* ---------- stage toggles ---------- */
  function bindToggles() {
    var mirrorBtn = SB.$("#mirrorToggle");
    mirrorBtn.addEventListener("click", function () {
      SB.settings.mirror = !SB.settings.mirror;
      SB.saveSettings();
      mirrorBtn.classList.toggle("is-on", SB.settings.mirror);
      var stage = SB.$("#stage");
      if (stage) stage.classList.toggle("is-mirror", !!SB.settings.mirror && stage.classList.contains("is-cam"));
      if (live().setMirror) live().setMirror(SB.settings.mirror);
      SB.toast("Mirror mode " + (SB.settings.mirror ? "on" : "off"), "info");
    });

    var lmBtn = SB.$("#landmarkToggle");
    lmBtn.addEventListener("click", function () {
      SB.settings.landmarks = !SB.settings.landmarks;
      SB.saveSettings();
      lmBtn.classList.toggle("is-on", SB.settings.landmarks);
      /* Must update the running LiveEngine — settings alone don't redraw */
      if (live().setDrawLandmarks) live().setDrawLandmarks(SB.settings.landmarks);
      var st = SB.$("#stageStatus");
      if (st && st.classList.contains("is-hands")) {
        st.innerHTML = SB.settings.landmarks
          ? '<span class="dot"></span>Hand detected — landmark overlay on.'
          : '<span class="dot"></span>Hand detected — overlay off (turn on Landmarks to see the skeleton).';
      }
      SB.toast("Landmark overlay " + (SB.settings.landmarks ? "on" : "off"), "info");
    });
  }

  /* ---------- quick phrases (chips + hotkeys 1â€“9) ---------- */
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
        var glyph = /^[0-9]$/.test(ch) ? { "1": "â˜ï¸", "2": "âœŒï¸", "3": "ðŸ¤Ÿ", "4": "ðŸ––", "5": "ðŸ–ï¸" }[ch] || null : null;
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
