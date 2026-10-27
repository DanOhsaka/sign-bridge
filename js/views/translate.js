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
  /* Adaptive confirm: high-confidence static glosses commit faster. */
  var pending = null; /* { text, conf, source, firstMs, lastMs } */
  var confirmTimer = null;

  function live() { return SB.Engine.getLiveEngine(); }

  function debounceMsFor(conf) {
    conf = typeof conf === "number" ? conf : 0;
    if (conf >= 0.9) return 450;
    if (conf >= 0.75) return 900;
    return 1600;
  }

  function holdMsFor(conf) {
    conf = typeof conf === "number" ? conf : 0;
    /* High-confidence static signs: short hold; lower conf needs longer stability. */
    if (conf >= 0.9) return 120;
    if (conf >= 0.8) return 220;
    if (conf >= 0.7) return 350;
    return 500;
  }

  function commitToken(tok, waitedMs) {
    if (!tok || !tok.text) return;
    var now = Date.now();
    var textKey = String(tok.text).trim().toLowerCase();
    if (
      textKey &&
      textKey === lastPrediction &&
      now - lastPredictionTime < debounceMsFor(tok.conf)
    ) {
      return;
    }
    lastPrediction = textKey;
    lastPredictionTime = now;
    transcript.addToken(tok);
    spotlight.show(tok);
    try {
      var eng = live();
      if (eng && eng.noteConfirmMs) eng.noteConfirmMs(waitedMs || 0);
    } catch (e) {}
  }

  function clearPending() {
    pending = null;
    if (confirmTimer != null) {
      clearTimeout(confirmTimer);
      confirmTimer = null;
    }
  }

  function considerLiveToken(tok) {
    if (!tok || !tok.text) return;
    var now = performance.now();
    var text = String(tok.text).trim();
    var conf = typeof tok.conf === "number" ? tok.conf : 0;
    var hold = holdMsFor(conf);

    if (pending && pending.text === text) {
      pending.lastMs = now;
      pending.conf = Math.max(pending.conf, conf);
      if (now - pending.firstMs >= holdMsFor(pending.conf)) {
        var waited = now - pending.firstMs;
        var out = {
          text: pending.text,
          conf: pending.conf,
          alt: tok.alt,
          glyph: tok.glyph,
          source: tok.source || pending.source || "live",
        };
        clearPending();
        commitToken(out, waited);
      }
      return;
    }

    clearPending();
    pending = {
      text: text,
      conf: conf,
      source: tok.source || "live",
      firstMs: now,
      lastMs: now,
    };
    confirmTimer = setTimeout(function () {
      if (!pending || pending.text !== text) return;
      var waited = performance.now() - pending.firstMs;
      var out = {
        text: pending.text,
        conf: pending.conf,
        source: pending.source,
      };
      clearPending();
      commitToken(out, waited);
    }, hold + 16);
  }

  function init() {
    transcript = new SB.Transcript(SB.$("#transcript"));
    spotlight = SB.Spotlight(SB.$("#spotlight"));

    SB.Engine.on("result", function (tok) {
      if (SB.Engine.getMode() === "live") {
        considerLiveToken(tok);
        /* keep one continuous sentence — do not open a new card per word */
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

        considerLiveToken({
          text: result.prediction,
          conf: result.confidence,
          source: "lstm",
        });

        console.log(
          "SignBridge transcript candidate:",
          result.prediction,
          result.confidence
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
    /* Release camera / worker cleanly when navigating Translate → other pages */
    window.addEventListener("pagehide", function () {
      try {
        if (window.SignBridgeLiveTest && typeof window.SignBridgeLiveTest.stop === "function") {
          window.SignBridgeLiveTest.stop();
        }
      } catch (e) {}
      try {
        if (live().getState && live().getState() !== "off") live().stop();
      } catch (e2) {}
    });
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

  function setDemoEmptyVisible(show) {
    var demo = SB.$("#stageDemo");
    var hint = SB.$("#demoHintBar");
    if (demo) {
      demo.style.display = show ? "" : "none";
      demo.setAttribute("aria-hidden", show ? "false" : "true");
    }
    if (hint) {
      hint.hidden = !show;
      hint.setAttribute("aria-hidden", show ? "false" : "true");
    }
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
    /* Live overlay owns the stage copy — never stack Demo tip / empty state under it */
    setDemoEmptyVisible(false);
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
    stage.classList.remove("is-cam", "is-mirror", "is-starting", "is-error");
    setStageOverlay(null);
    setDemoEmptyVisible(true);
    SB.$("#mirrorToggle").classList.remove("is-on");
    var st = SB.$("#stageStatus");
    if (st) {
      st.classList.remove("is-hands");
      st.innerHTML = '<span class="dot"></span>Demo engine — recognition is simulated so the full UI works before the model is trained.';
    }

    setPill("demo");
    refreshCapturePanelVisibility();
    if (transcript && transcript.setStatus) transcript.setStatus("Idle", false);
    /* Restore page atmosphere when leaving live camera */
    if (SB.resumeThreeFX) SB.resumeThreeFX();
  }

  function goLive() {
    var stage = SB.$("#stage");
    setDemoEmptyVisible(false);
    setStageOverlay("starting", "Starting camera…", "Allow camera access if prompted. Keep your hands in frame.");
    var st = SB.$("#stageStatus");
    if (st) st.innerHTML = '<span class="dot"></span>Requesting camera permission…';
    /* Live cam owns the stage plane — pause bg motion to save GPU while filming */
    if (SB.pauseThreeFX) SB.pauseThreeFX();

    /* Perf HUD never auto-on with Live — only Settings / ?perf=1 / ?debugTrack=1 */
    var wantHud = !!(SB.settings && SB.settings.perfHud);
    try {
      wantHud = wantHud || /(?:^|[?&])(?:perf|debugTrack)=1(?:&|$)/.test(location.search || "");
    } catch (e) {}
    SB.Engine.setMode("live", {
      videoEl: SB.$("#cam"),
      canvasEl: SB.$("#overlay"),
      mirror: SB.settings.mirror,
      drawLandmarks: SB.settings.landmarks !== false,
      showHud: !!wantHud,
    }).then(function () {
      setStageOverlay(null);
      stage.classList.add("is-cam");
      stage.classList.toggle("is-mirror", !!SB.settings.mirror);
      /* LSTM needs Holistic pose — only auto-start with ?holistic=1 */
      var wantLstm = false;
      try {
        wantLstm = /(?:^|[?&])holistic=1(?:&|$)/.test(location.search || "");
      } catch (e) {}
      if (wantLstm && window.SignBridgeLiveTest &&
          typeof window.SignBridgeLiveTest.start === "function") {
        window.SignBridgeLiveTest.start();
      }

      SB.$("#mirrorToggle").classList.toggle("is-on", !!SB.settings.mirror);
      SB.$("#landmarkToggle").classList.toggle("is-on", SB.settings.landmarks !== false);
      /* Push chip state into the running engine (settings alone don't redraw) */
      if (live().setDrawLandmarks) live().setDrawLandmarks(SB.settings.landmarks !== false);
      if (live().setMirror) live().setMirror(!!SB.settings.mirror);
      setPill("live");
      refreshCapturePanelVisibility();
      if (st) st.innerHTML = '<span class="dot"></span>Camera ready — move a hand into view…';
      if (transcript && transcript.setStatus) transcript.setStatus("Live", true);

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
      if (SB.resumeThreeFX) SB.resumeThreeFX();
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

  /* ---------- quick phrases (chips + hotkeys 1–9) ---------- */
  function bindQuickPhrases() {
    var wrap = SB.$("#quickChips");
    if (!wrap) return;
    wrap.innerHTML = "";
    var list = SB.QUICK_PHRASES || [];
    list.forEach(function (p, i) {
      var phrase = SB.PHRASE_MAP && SB.PHRASE_MAP[p.id];
      if (!phrase) return;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.innerHTML =
        "<span aria-hidden=\"true\">" + (p.emoji || "") + "</span> " +
        SB.escHtml(phrase.name) +
        '<span class="kbd-hint">' + (i + 1) + "</span>";
      btn.addEventListener("click", function () { signPhrase(p.id); });
      wrap.appendChild(btn);
    });

    document.addEventListener("keydown", function (e) {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      var n = parseInt(e.key, 10);
      if (n >= 1 && n <= list.length) {
        signPhrase(list[n - 1].id);
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
    var dl = SB.$("#tDownload");
    if (dl) {
      dl.addEventListener("click", function () {
        if (!transcript.downloadText()) {
          SB.toast("Nothing to download yet", "info");
          return;
        }
        SB.toast("Transcript downloaded", "ok");
      });
    }
    SB.$("#tSpeak").addEventListener("click", function () {
      var text = transcript.allText();
      if (!text) { SB.toast("Nothing to speak yet", "info"); return; }
      SB.speak(text);
    });
  }

  return { init: init };
};
