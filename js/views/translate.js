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
  /* Adaptive confirm: high-confidence static glosses commit faster. */
  var pending = null; /* { text, conf, source, firstMs, lastMs, glyph, alt } */
  var confirmTimer = null;
  /* Same gloss appends once until pose changes or hand leaves the frame. */
  var lockedGloss = null; /* lowercase text last committed while hand stayed up */
  var poseChangeNeeded = false; /* after commit, require a different held gloss */
  var cameraOn = true; /* Camera chip — off stops tracks; on restarts Live */
  var liveStarting = false;

  function live() { return SB.Engine.getLiveEngine(); }

  function holdMsFor(conf) {
    conf = typeof conf === "number" ? conf : 0;
    if (conf >= 0.85) return 100;
    if (conf >= 0.65) return 160;
    if (conf >= 0.5) return 240;
    return 320;
  }

  function glossKey(text) {
    return String(text || "").trim().toLowerCase();
  }

  function clearGlossLock() {
    lockedGloss = null;
    poseChangeNeeded = false;
  }

  /**
   * Live recognition: Holistic + Python LSTM (/api/predict → :9001).
   * Detach the experimental landmark→Hello/Yes gloss heuristic (wrong signs).
   * No-spam lock below still applies when LSTM tokens arrive.
   */
  function ensureLiveRecognizer() {
    var eng = live();
    if (eng._classifierKind === "handshape") {
      eng.setClassifier(null);
      eng._classifierKind = null;
      if (SB.HandshapeClassifier && SB.HandshapeClassifier.reset) {
        try { SB.HandshapeClassifier.reset(); } catch (e) {}
      }
    }
    return eng.hasClassifier();
  }

  function commitToken(tok, waitedMs) {
    if (!tok || !tok.text) return;
    var textKey = glossKey(tok.text);
    /* Hard lock: never re-append the same gloss until pose change / hand leave */
    if (textKey && textKey === lockedGloss) return;

    lockedGloss = textKey;
    poseChangeNeeded = true;
    /* Live sentence stream — strip alternates so UI never shows "Did you mean?" */
    var out = {
      text: tok.text,
      conf: tok.conf,
      glyph: tok.glyph,
      source: tok.source || "live",
    };
    if (String(out.source).indexOf("live") !== 0 && tok.alt) out.alt = tok.alt;
    transcript.addToken(out);
    spotlight.show(out);
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

  function previewCurrent(tok) {
    /* Show CURRENT SIGN immediately while confirm hold runs */
    if (transcript && transcript.setCurrentSign) transcript.setCurrentSign(tok);
  }

  function considerLiveToken(tok) {
    if (!tok || !tok.text) return;
    var now = performance.now();
    var text = String(tok.text).trim();
    var textKey = glossKey(text);
    var conf = typeof tok.conf === "number" ? tok.conf : 0;
    var hold = holdMsFor(conf);

    /* Still preview the active reading, but do not re-queue a locked gloss */
    if (textKey && textKey === lockedGloss) {
      previewCurrent(tok);
      clearPending();
      return;
    }

    /* After a commit, ignore the same family until a *different* gloss is held */
    if (poseChangeNeeded && textKey === lockedGloss) {
      previewCurrent(tok);
      return;
    }

    if (pending && glossKey(pending.text) === textKey) {
      pending.lastMs = now;
      pending.conf = Math.max(pending.conf, conf);
      if (tok.glyph) pending.glyph = tok.glyph;
      if (tok.alt) pending.alt = tok.alt;
      previewCurrent({
        text: pending.text,
        conf: pending.conf,
        glyph: pending.glyph,
        alt: pending.alt,
      });
      if (now - pending.firstMs >= holdMsFor(pending.conf)) {
        var waited = now - pending.firstMs;
        var out = {
          text: pending.text,
          conf: pending.conf,
          alt: pending.alt,
          glyph: pending.glyph,
          source: tok.source || pending.source || "live",
        };
        clearPending();
        commitToken(out, waited);
      }
      return;
    }

    /* New distinct gloss → unlock prior lock and start a fresh hold */
    if (lockedGloss && textKey && textKey !== lockedGloss) {
      lockedGloss = null;
      poseChangeNeeded = false;
    }

    clearPending();
    pending = {
      text: text,
      conf: conf,
      source: tok.source || "live",
      firstMs: now,
      lastMs: now,
      glyph: tok.glyph,
      /* Live never carries alts into the sentence stream */
      alt: null,
    };
    previewCurrent(tok);
    confirmTimer = setTimeout(function () {
      if (!pending || glossKey(pending.text) !== textKey) return;
      if (textKey === lockedGloss) {
        clearPending();
        return;
      }
      var waited = performance.now() - pending.firstMs;
      var out = {
        text: pending.text,
        conf: pending.conf,
        source: pending.source,
        glyph: pending.glyph,
        alt: pending.alt,
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


    /* hand-presence → status line pulse; leaving frame unlocks gloss re-fire */
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
              ? "landmark overlay on — waiting for Holistic + LSTM recognition."
              : "tracking, but overlay is off — turn on Landmarks to see the skeleton."));

      } else {
        st.classList.remove("is-hands");
        st.innerHTML = '<span class="dot"></span>Move a hand into view…';
        /* Hand left → allow the same gloss again on next raise */
        clearGlossLock();
        clearPending();
        if (SB.HandshapeClassifier && SB.HandshapeClassifier.reset) {
          try { SB.HandshapeClassifier.reset(); } catch (e) {}
        }
      }
    });

    bindToggles();
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
    /* Reflect saved toggle state even before Live starts. */
    var lmChip = SB.$("#landmarkToggle");
    var mirChip = SB.$("#mirrorToggle");
    var camChip = SB.$("#cameraToggle");
    if (lmChip) lmChip.classList.toggle("is-on", SB.settings.landmarks !== false);
    if (mirChip) mirChip.classList.toggle("is-on", !!SB.settings.mirror);
    if (camChip) {
      camChip.classList.toggle("is-on", cameraOn);
      camChip.setAttribute("aria-pressed", cameraOn ? "true" : "false");
    }
    /* Translate is Live-only — start camera + LSTM immediately. */
    goLive();
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
        SB.toast("Wait for the Live camera to start, then record.", "error");
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
  function recognizerPillLabel() {
    if (!live().hasClassifier()) return "tracking";
    return "model ready";
  }

  function setPill(mode, err) {
    var pill = SB.$("#enginePill");
    if (!pill) return;
    pill.className = "engine-pill is-" + (err ? "error" : "live");
    SB.$(".pill-text", pill).textContent = err
      ? "Camera unavailable"
      : ("Live · " + recognizerPillLabel());
  }

  function setStageOverlay(kind, title, detail) {
    var stage = SB.$("#stage");
    var overlay = SB.$("#stageOverlay");
    if (!stage) return;
    stage.classList.remove("is-starting", "is-error", "is-waiting");
    if (!kind) {
      if (overlay) overlay.hidden = true;
      return;
    }
    var klass = kind === "error" ? "is-error"
      : kind === "waiting" ? "is-waiting"
      : "is-starting";
    stage.classList.add(klass);
    if (!overlay) return;
    overlay.hidden = false;
    overlay.dataset.kind = kind;
    var titleEl = SB.$(".overlay-title", overlay);
    var detailEl = SB.$(".overlay-detail", overlay);
    var spin = SB.$(".spinner", overlay);
    var waitFx = SB.$(".stage-wait-fx", overlay);
    if (titleEl) titleEl.textContent = title || "";
    if (detailEl) {
      detailEl.textContent = detail || "";
      detailEl.hidden = !detail;
    }
    /* Classic spinner for starting; BeUI/Aceternity orbits for waiting. */
    if (spin) spin.style.display = kind === "starting" ? "" : "none";
    if (waitFx) waitFx.style.display = kind === "waiting" ? "" : "none";
  }

  function syncCameraChip() {
    var camChip = SB.$("#cameraToggle");
    if (!camChip) return;
    camChip.classList.toggle("is-on", !!cameraOn);
    camChip.setAttribute("aria-pressed", cameraOn ? "true" : "false");
  }

  function stopCamera() {
    cameraOn = false;
    liveStarting = false;
    syncCameraChip();
    try {
      if (window.SignBridgeLiveTest && typeof window.SignBridgeLiveTest.stop === "function") {
        window.SignBridgeLiveTest.stop();
      }
    } catch (e) {}
    try {
      if (live().getState && live().getState() !== "off") live().stop();
    } catch (e2) {}
    try { SB.Engine._hands(0); } catch (e3) {}
    clearGlossLock();
    clearPending();
    var stage = SB.$("#stage");
    if (stage) {
      stage.classList.remove("is-cam", "is-mirror", "is-starting", "is-error");
    }
    setStageOverlay(
      "waiting",
      "Waiting for camera to be turned on",
      "Toggle Camera on to restart Live tracking."
    );
    var st = SB.$("#stageStatus");
    if (st) {
      st.classList.remove("is-hands");
      st.innerHTML = '<span class="dot"></span>Camera off — waiting for Camera to be turned on.';
    }
    if (transcript && transcript.setStatus) transcript.setStatus("Idle", false);
    if (transcript && transcript.setLiveHint) {
      transcript.setLiveHint("Camera is off. Toggle <strong>Camera</strong> on to resume Live recognition.");
    }
    setPill("live");
    try {
      var pill = SB.$("#enginePill");
      if (pill) SB.$(".pill-text", pill).textContent = "Live · camera off";
    } catch (e4) {}
    refreshCapturePanelVisibility();
    if (SB.resumeThreeFX) SB.resumeThreeFX();
    SB.toast("Camera off", "info");
  }

  function goLive() {
    if (liveStarting) return;
    cameraOn = true;
    liveStarting = true;
    syncCameraChip();

    var stage = SB.$("#stage");
    setStageOverlay("starting", "Starting camera…", "Allow camera access if prompted. Keep your hands in frame.");
    var st = SB.$("#stageStatus");
    if (st) st.innerHTML = '<span class="dot"></span>Requesting camera permission…';
    if (SB.resumeThreeFX) SB.resumeThreeFX();

    /* Attach recognizer BEFORE camera start so first accepted frames classify. */
    ensureLiveRecognizer();

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
      liveStarting = false;
      if (!cameraOn) {
        /* User toggled off while starting — don't leave tracks running. */
        try { live().stop(); } catch (eStop) {}
        return;
      }
      setStageOverlay(null);
      stage.classList.add("is-cam");
      stage.classList.toggle("is-mirror", !!SB.settings.mirror);

      /* Detach bad gloss heuristic; keep any real setClassifier model. */
      ensureLiveRecognizer();
      var recogLabel = recognizerPillLabel();

      /* Always wire Live → Holistic landmarks → SignBridgeLiveTest → /api/predict */
      var lstmOn = false;
      if (window.SignBridgeLiveTest &&
          typeof window.SignBridgeLiveTest.start === "function") {
        window.SignBridgeLiveTest.start();
        lstmOn = true;
        recogLabel = recogLabel === "model ready" ? "model + LSTM" : "Holistic · LSTM";
      }

      SB.$("#mirrorToggle").classList.toggle("is-on", !!SB.settings.mirror);
      SB.$("#landmarkToggle").classList.toggle("is-on", SB.settings.landmarks !== false);
      syncCameraChip();
      /* Push chip state into the running engine (settings alone don't redraw) */
      if (live().setDrawLandmarks) live().setDrawLandmarks(SB.settings.landmarks !== false);
      if (live().setMirror) live().setMirror(!!SB.settings.mirror);
      setPill("live");
      refreshCapturePanelVisibility();
      if (st) {
        st.innerHTML = lstmOn
          ? '<span class="dot"></span>Live recognition on — Holistic + LSTM (<code>signbridge_lstm.keras</code>).'
          : live().hasClassifier()
            ? '<span class="dot"></span>Live recognition on — trained classifier attached.'
            : '<span class="dot"></span>Camera ready — landmarks only. Waiting for LSTM recognition.';
      }
      if (transcript && transcript.setStatus) transcript.setStatus("Live", true);
      if (transcript && transcript.setLiveHint) {
        transcript.setLiveHint(lstmOn
          ? "Words stream here from the Keras LSTM when a 30-frame Holistic window is confident."
          : live().hasClassifier()
            ? "Words stream here as one sentence when the model is confident."
            : "Live tracks hands. Transcript words appear when the LSTM is confident.");
      }

      SB.toast(lstmOn
        ? "Live on — Holistic tracking + Keras LSTM"
        : live().hasClassifier()
          ? "Live engine on — hand tracking + your classifier"
          : "Live on — landmarks only. Waiting for LSTM.", "ok");
      try {
        var pill = SB.$("#enginePill");
        if (pill) SB.$(".pill-text", pill).textContent = "Live · " + recogLabel;
      } catch (e2) {}
    }).catch(function (err) {
      liveStarting = false;
      cameraOn = false;
      syncCameraChip();
      if (window.SignBridgeLiveTest && typeof window.SignBridgeLiveTest.stop === "function") {
        window.SignBridgeLiveTest.stop();
      }
      setStageOverlay("error", "Camera unavailable",
        (err && err.message ? err.message : "Permission denied or no camera found.") +
        " Toggle Camera on after allowing access.");

      setPill("live", true);
      if (SB.resumeThreeFX) SB.resumeThreeFX();
      SB.toast(
        "Live camera unavailable — " +
          (err && err.message ? err.message : "permission denied") + ".",
        "error"
      );
    });
  }

  /* ---------- stage toggles ---------- */
  function bindToggles() {
    var camBtn = SB.$("#cameraToggle");
    if (camBtn) {
      camBtn.addEventListener("click", function () {
        if (cameraOn || liveStarting) {
          stopCamera();
          return;
        }
        goLive();
      });
    }

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
