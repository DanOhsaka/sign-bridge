/* ============================================================
   SignBridge — Practice view (practice.js)
   UX polish: reserved feedback, delayed next, try-again,
   animated stats, clearer pad semantics.
   ============================================================ */

window.SB = window.SB || {};

SB.PracticeView = function () {
  var progress = SB.store.get("progress", {
    letters: {},
    review: [],
    phrases: {},
    streak: 0,
    best: 0,
  });

  var state = {
    tab: "signs",
    target: null,
    sessionCorrect: 0,
    sessionTried: 0,
    locked: false,
    nextTimer: null,
  };

  var signFilter = { q: "", cat: "All" };
  var cameraOn = false;
  var liveStarting = false;
  var liveListenersBound = false;

  /* Clip capture: landmark feature buffer + optional MediaRecorder video */
  var recording = false;
  var clipReady = false;
  var clipFeats = []; /* Float32Array[] while recording / after stop */
  var clipVotes = []; /* {text,conf}[] live previews while recording */
  var mediaRecorder = null;
  var recChunks = [];
  var clipBlobUrl = null;
  var recStartedAt = 0;
  var recTimerId = null;

  function live() { return SB.Engine.getLiveEngine(); }

  function save() { SB.store.set("progress", progress); }

  function init() {
    SB.PracticeView._instance = api;
    bindTabs();
    bindSignBrowser();
    bindLiveCamera();
    pickTarget();
    bindPad();
    bindKeyboard();
    bindReview();
    bindPhraseDeck();
    renderMinipairs();
    resetFeedbackIdle();
    updateStats();
    /* Start Live when Arena is already selected (e.g. deep link). */
    if (state.tab === "arena") goLive();
  }

  function renderMinipairs() {
    var list = SB.$("#minipairList");
    if (!list) return;
    list.innerHTML = "";
    SB.MINIP_AIRS.forEach(function (mp) {
      var item = document.createElement("div");
      item.className = "minipair";
      item.innerHTML = '<span class="mp-letters">' + mp.letters + "</span>" +
        '<span class="mp-diff">' + mp.diff + "</span>";
      list.appendChild(item);
    });
  }

  function bindTabs() {
    SB.$$("#practiceTabs button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        SB.$$("#practiceTabs button").forEach(function (b) { b.classList.remove("is-on"); });
        btn.classList.add("is-on");
        state.tab = btn.dataset.tab;
        var signs = SB.$("#signsPane");
        var arena = SB.$("#arenaPane");
        if (signs) signs.style.display = state.tab === "signs" ? "" : "none";
        if (arena) arena.style.display = state.tab === "arena" ? "" : "none";
        if (state.tab === "arena") {
          goLive();
        } else {
          stopCamera({ silent: true });
        }
      });
    });
  }

  /* ---------- Live camera (reuse Translate engine + waiting UI) ---------- */
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
    if (spin) spin.style.display = kind === "starting" ? "" : "none";
    if (waitFx) waitFx.style.display = kind === "waiting" ? "" : "none";
  }

  function syncCameraChip() {
    var camChip = SB.$("#cameraToggle");
    if (!camChip) return;
    camChip.classList.toggle("is-on", !!cameraOn);
    camChip.setAttribute("aria-pressed", cameraOn ? "true" : "false");
  }

  function highlightLivePad(letter) {
    SB.$$("#letterPad button").forEach(function (b) {
      b.classList.toggle("is-live", !!letter && b.dataset.l === letter);
    });
  }

  function normalizeLiveLetter(text) {
    var t = String(text || "").trim().toUpperCase();
    return /^[A-Z]$/.test(t) ? t : null;
  }

  function attachLetterClassifier() {
    var eng = live();
    if (SB.LetterClassifier && typeof SB.LetterClassifier.classify === "function") {
      /* Buffer landmarks while recording; never auto-score via Engine._result. */
      eng.setClassifier(function (feats) {
        var tok = null;
        try { tok = SB.LetterClassifier.classify(feats); } catch (e) { tok = null; }
        if (recording && feats && feats.length >= 63) {
          clipFeats.push(Float32Array.from(feats));
          var letter = tok && normalizeLiveLetter(tok.text);
          if (letter) {
            clipVotes.push({ text: letter, conf: typeof tok.conf === "number" ? tok.conf : 0 });
            highlightLivePad(letter);
          }
        }
        return null;
      });
      eng._classifierKind = "letter-clip";
      return true;
    }
    eng.setClassifier(null);
    eng._classifierKind = null;
    return false;
  }

  function revokeClipUrl() {
    if (clipBlobUrl) {
      try { URL.revokeObjectURL(clipBlobUrl); } catch (e) {}
      clipBlobUrl = null;
    }
    var replay = SB.$("#clipReplay");
    if (replay) {
      replay.pause();
      replay.removeAttribute("src");
      replay.load();
      replay.hidden = true;
    }
    var stage = SB.$("#stage");
    if (stage) stage.classList.remove("is-replay");
  }

  function clearClip() {
    if (recording) {
      recording = false;
      if (recTimerId) {
        clearInterval(recTimerId);
        recTimerId = null;
      }
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        try {
          mediaRecorder.ondataavailable = null;
          mediaRecorder.onstop = null;
          mediaRecorder.stop();
        } catch (e) {}
      }
      mediaRecorder = null;
    }
    clipFeats = [];
    clipVotes = [];
    clipReady = false;
    recChunks = [];
    revokeClipUrl();
    highlightLivePad(null);
    syncRecUi();
    resetFeedbackIdle();
  }

  function syncRecUi() {
    var startBtn = SB.$("#recStartBtn");
    var stopBtn = SB.$("#recStopBtn");
    var clearBtn = SB.$("#recClearBtn");
    var badge = SB.$("#recBadge");
    var meta = SB.$("#clipMeta");
    var stage = SB.$("#stage");
    if (startBtn) startBtn.disabled = !cameraOn || recording || state.locked;
    if (stopBtn) stopBtn.disabled = !recording;
    if (clearBtn) clearBtn.disabled = recording || (!clipReady && !clipFeats.length);
    if (badge) badge.hidden = !recording;
    if (stage) stage.classList.toggle("is-recording", !!recording);
    if (!meta) return;
    if (!cameraOn) {
      meta.textContent = "Turn Camera on to record a signing clip.";
    } else if (recording) {
      meta.textContent = "Recording… keep the target handshape steady. Live preview on the pad.";
    } else if (clipReady) {
      meta.textContent = "Clip ready (" + clipFeats.length + " landmark frames). Pick a letter on the pad or keyboard to grade.";
    } else if (clipBlobUrl) {
      meta.textContent = "Video preview saved, but no hand landmarks — record again with your hand in frame.";
    } else {
      meta.textContent = "Camera on → Record → Stop → pick a letter to grade.";
    }
  }

  function tickRecTimer() {
    var el = SB.$("#recTimer");
    if (!el || !recording) return;
    var sec = (performance.now() - recStartedAt) / 1000;
    el.textContent = sec.toFixed(1) + "s";
  }

  function pickRecorderMime() {
    if (typeof MediaRecorder === "undefined") return "";
    var types = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    for (var i = 0; i < types.length; i++) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(types[i])) return types[i];
    }
    return "";
  }

  function startRecording() {
    if (!cameraOn || recording || state.locked || state.tab !== "arena") return;
    var video = SB.$("#cam");
    var stream = video && video.srcObject;
    if (!stream) {
      SB.toast("Camera stream not ready", "error");
      return;
    }

    clipFeats = [];
    clipVotes = [];
    clipReady = false;
    recChunks = [];
    revokeClipUrl();
    recording = true;
    recStartedAt = performance.now();
    tickRecTimer();
    if (recTimerId) clearInterval(recTimerId);
    recTimerId = setInterval(tickRecTimer, 100);

    var mime = pickRecorderMime();
    try {
      mediaRecorder = mime
        ? new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 900000 })
        : new MediaRecorder(stream);
      mediaRecorder.ondataavailable = function (ev) {
        if (ev.data && ev.data.size) recChunks.push(ev.data);
      };
      mediaRecorder.onerror = function () {
        SB.toast("MediaRecorder error — landmark buffer still grades", "info");
      };
      mediaRecorder.start(200);
    } catch (err) {
      mediaRecorder = null;
      SB.toast("Video encode unavailable — grading from landmark buffer", "info");
    }

    syncRecUi();
    var st = SB.$("#stageStatus");
    if (st) st.innerHTML = '<span class="dot"></span>Recording clip — sign the target letter.';
    resetFeedbackIdle();
    SB.toast("Recording…", "ok");
  }

  function stopRecording(opts) {
    opts = opts || {};
    if (!recording) return;
    recording = false;
    if (recTimerId) {
      clearInterval(recTimerId);
      recTimerId = null;
    }

    function finish() {
      /* Grading needs landmark frames; video alone is preview-only. */
      clipReady = clipFeats.length > 0;
      if (recChunks.length) {
        var blob = new Blob(recChunks, { type: recChunks[0].type || "video/webm" });
        revokeClipUrl();
        clipBlobUrl = URL.createObjectURL(blob);
        var replay = SB.$("#clipReplay");
        var stage = SB.$("#stage");
        if (replay && clipBlobUrl) {
          replay.src = clipBlobUrl;
          replay.hidden = false;
          if (stage) stage.classList.add("is-replay");
          replay.play().catch(function () {});
        }
      }
      syncRecUi();
      var st = SB.$("#stageStatus");
      if (st) {
        st.innerHTML = clipReady
          ? '<span class="dot"></span>Clip saved — ' + clipFeats.length + ' landmark frames. Pick a letter to grade.'
          : '<span class="dot"></span>Clip stopped — no hand landmarks captured. Record again with hand in frame.';
      }
      resetFeedbackIdle();
      if (!opts.silent) {
        SB.toast(
          clipReady
            ? "Clip ready — pick a letter to grade"
            : "No landmarks in clip — try again",
          clipReady ? "ok" : "error"
        );
      }
    }

    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.onstop = function () {
        mediaRecorder = null;
        finish();
      };
      try { mediaRecorder.stop(); } catch (e) {
        mediaRecorder = null;
        finish();
      }
    } else {
      mediaRecorder = null;
      finish();
    }
  }

  /**
   * Majority / confidence-weighted vote over buffered landmark frames.
   * @returns {{text:string, conf:number, frames:number, votes:number}|null}
   */
  function gradeClip() {
    var tallies = {};
    var i;
    /* Re-classify stored features (authoritative) */
    for (i = 0; i < clipFeats.length; i++) {
      var tok = null;
      try {
        if (SB.LetterClassifier) tok = SB.LetterClassifier.classify(clipFeats[i]);
      } catch (e) { tok = null; }
      var letter = tok && normalizeLiveLetter(tok.text);
      if (!letter) continue;
      if (!tallies[letter]) tallies[letter] = { n: 0, confSum: 0 };
      tallies[letter].n++;
      tallies[letter].confSum += typeof tok.conf === "number" ? tok.conf : 0.6;
    }
    /* Fallback to live votes if features somehow empty but votes exist */
    if (!Object.keys(tallies).length) {
      for (i = 0; i < clipVotes.length; i++) {
        var v = clipVotes[i];
        var L = normalizeLiveLetter(v && v.text);
        if (!L) continue;
        if (!tallies[L]) tallies[L] = { n: 0, confSum: 0 };
        tallies[L].n++;
        tallies[L].confSum += typeof v.conf === "number" ? v.conf : 0.6;
      }
    }
    var best = null;
    Object.keys(tallies).forEach(function (L) {
      var t = tallies[L];
      var score = t.n + t.confSum / Math.max(1, t.n);
      if (!best || score > best.score) {
        best = {
          text: L,
          conf: t.confSum / Math.max(1, t.n),
          frames: clipFeats.length,
          votes: t.n,
          score: score,
        };
      }
    });
    return best;
  }

  function stopCamera(opts) {
    opts = opts || {};
    cameraOn = false;
    liveStarting = false;
    clearClip();
    highlightLivePad(null);
    syncCameraChip();
    syncRecUi();
    try {
      var eng = live();
      if (eng.setClassifier) eng.setClassifier(null);
      eng._classifierKind = null;
    } catch (e0) {}
    try {
      if (live().getState && live().getState() !== "off") live().stop();
    } catch (e2) {}
    try { SB.Engine._hands(0); } catch (e3) {}
    var stage = SB.$("#stage");
    if (stage) {
      stage.classList.remove("is-cam", "is-mirror", "is-starting", "is-error", "is-recording", "is-replay");
    }
    setStageOverlay(
      "waiting",
      "Waiting for camera to be turned on",
      "Toggle Camera on to record letter signing clips."
    );
    var st = SB.$("#stageStatus");
    if (st) {
      st.classList.remove("is-hands");
      st.innerHTML = '<span class="dot"></span>Camera off — turn Camera on to record clips.';
    }
    if (!opts.silent) SB.toast("Camera off", "info");
  }

  function goLive() {
    if (state.tab !== "arena") return;
    if (liveStarting) return;
    cameraOn = true;
    liveStarting = true;
    syncCameraChip();
    clearClip();

    var stage = SB.$("#stage");
    setStageOverlay("starting", "Starting camera…", "Allow camera access if prompted. Keep your signing hand in frame.");
    var st = SB.$("#stageStatus");
    if (st) st.innerHTML = '<span class="dot"></span>Requesting camera permission…';
    if (SB.resumeThreeFX) SB.resumeThreeFX();

    attachLetterClassifier();

    SB.Engine.setMode("live", {
      videoEl: SB.$("#cam"),
      canvasEl: SB.$("#overlay"),
      mirror: SB.settings.mirror,
      drawLandmarks: SB.settings.landmarks !== false,
      showHud: !!(SB.settings && SB.settings.perfHud),
    }).then(function () {
      liveStarting = false;
      if (!cameraOn || state.tab !== "arena") {
        try { live().stop(); } catch (eStop) {}
        return;
      }
      attachLetterClassifier();
      setStageOverlay(null);
      if (stage) {
        stage.classList.add("is-cam");
        stage.classList.toggle("is-mirror", !!SB.settings.mirror);
      }
      var mir = SB.$("#mirrorToggle");
      var lm = SB.$("#landmarkToggle");
      if (mir) mir.classList.toggle("is-on", !!SB.settings.mirror);
      if (lm) lm.classList.toggle("is-on", SB.settings.landmarks !== false);
      syncCameraChip();
      if (live().setDrawLandmarks) live().setDrawLandmarks(SB.settings.landmarks !== false);
      if (live().setMirror) live().setMirror(!!SB.settings.mirror);
      if (st) {
        st.innerHTML = '<span class="dot"></span>Live preview on — press Record, sign the target, then Stop.';
      }
      syncRecUi();
      SB.toast("Live letter cam on — record a clip", "ok");
    }).catch(function (err) {
      liveStarting = false;
      cameraOn = false;
      syncCameraChip();
      syncRecUi();
      setStageOverlay("error", "Camera unavailable",
        (err && err.message ? err.message : "Permission denied or no camera found.") +
        " Toggle Camera on after allowing access.");
      SB.toast(
        "Live camera unavailable — " +
          (err && err.message ? err.message : "permission denied") + ".",
        "error"
      );
    });
  }

  function bindLiveCamera() {
    if (!SB.$("#stage") || !SB.$("#cameraToggle")) return;

    var lmChip = SB.$("#landmarkToggle");
    var mirChip = SB.$("#mirrorToggle");
    if (lmChip) lmChip.classList.toggle("is-on", SB.settings.landmarks !== false);
    if (mirChip) mirChip.classList.toggle("is-on", !!SB.settings.mirror);
    syncCameraChip();
    syncRecUi();
    setStageOverlay(
      "waiting",
      "Waiting for camera to be turned on",
      "Open Arena and toggle Camera on to record letter clips."
    );

    if (!liveListenersBound) {
      liveListenersBound = true;
      SB.Engine.on("hands", function (count) {
        if (state.tab !== "arena" || !cameraOn || recording) return;
        var st = SB.$("#stageStatus");
        if (!st || clipReady) return;
        if (count > 0) {
          st.classList.add("is-hands");
          st.innerHTML = '<span class="dot"></span>Hand detected — press Record when ready.';
        } else {
          st.classList.remove("is-hands");
          st.innerHTML = '<span class="dot"></span>Move a hand into view, then Record.';
          highlightLivePad(null);
        }
      });
      window.addEventListener("pagehide", function () {
        try { if (recording) stopRecording({ silent: true }); } catch (e0) {}
        try {
          if (live().getState && live().getState() !== "off") live().stop();
        } catch (e) {}
      });
    }

    var camBtn = SB.$("#cameraToggle");
    camBtn.addEventListener("click", function () {
      if (cameraOn || liveStarting) {
        stopCamera();
        return;
      }
      goLive();
    });

    var startBtn = SB.$("#recStartBtn");
    var stopBtn = SB.$("#recStopBtn");
    var clearBtn = SB.$("#recClearBtn");
    if (startBtn) startBtn.addEventListener("click", function () { startRecording(); });
    if (stopBtn) stopBtn.addEventListener("click", function () { stopRecording(); });
    if (clearBtn) clearBtn.addEventListener("click", function () {
      clearClip();
      SB.toast("Clip cleared", "info");
    });

    var mirrorBtn = SB.$("#mirrorToggle");
    if (mirrorBtn) {
      mirrorBtn.addEventListener("click", function () {
        SB.settings.mirror = !SB.settings.mirror;
        SB.saveSettings();
        mirrorBtn.classList.toggle("is-on", SB.settings.mirror);
        var stage = SB.$("#stage");
        if (stage) stage.classList.toggle("is-mirror", !!SB.settings.mirror && stage.classList.contains("is-cam"));
        if (live().setMirror) live().setMirror(SB.settings.mirror);
        SB.toast("Mirror mode " + (SB.settings.mirror ? "on" : "off"), "info");
      });
    }

    var lmBtn = SB.$("#landmarkToggle");
    if (lmBtn) {
      lmBtn.addEventListener("click", function () {
        SB.settings.landmarks = !SB.settings.landmarks;
        SB.saveSettings();
        lmBtn.classList.toggle("is-on", SB.settings.landmarks);
        if (live().setDrawLandmarks) live().setDrawLandmarks(SB.settings.landmarks);
        SB.toast("Landmark overlay " + (SB.settings.landmarks ? "on" : "off"), "info");
      });
    }
  }

  /* ---------- Sign browser (moved from Learn) ---------- */
  function bindSignBrowser() {
    if (!SB.$("#signGrid")) return;
    buildSignCategories();
    renderSignGrid();
    var input = SB.$("#learnSearch");
    if (input) {
      input.addEventListener("input", function () {
        signFilter.q = input.value.trim().toLowerCase();
        renderSignGrid();
      });
    }
  }

  function buildSignCategories() {
    var wrap = SB.$("#catChips");
    if (!wrap) return;
    var cats = ["All"];
    (SB.PHRASES || []).forEach(function (p) {
      if (cats.indexOf(p.cat) === -1) cats.push(p.cat);
    });
    wrap.innerHTML = "";
    cats.forEach(function (c) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip" + (c === "All" ? " is-on" : "");
      chip.dataset.cat = c;
      chip.textContent = c;
      chip.addEventListener("click", function () {
        SB.$$("#catChips .chip").forEach(function (x) { x.classList.remove("is-on"); });
        chip.classList.add("is-on");
        signFilter.cat = c;
        renderSignGrid();
      });
      wrap.appendChild(chip);
    });
  }

  function renderSignGrid() {
    var grid = SB.$("#signGrid");
    if (!grid) return;
    grid.innerHTML = "";

    var items = (SB.PHRASES || []).filter(function (p) {
      var catOk = signFilter.cat === "All" || p.cat === signFilter.cat;
      var qOk = !signFilter.q ||
        p.name.toLowerCase().indexOf(signFilter.q) !== -1 ||
        p.desc.toLowerCase().indexOf(signFilter.q) !== -1 ||
        p.cat.toLowerCase().indexOf(signFilter.q) !== -1;
      return catOk && qOk;
    });

    if (!items.length) {
      grid.innerHTML =
        '<div class="empty" style="grid-column:1/-1">' +
        '<div class="empty-icon">⌕</div>' +
        '<div class="empty-title">No signs match</div>' +
        '<div class="empty-hint">Try another search term, or clear the category filter.</div>' +
        "</div>";
      return;
    }

    items.forEach(function (p) {
      var card = document.createElement("article");
      card.className = "sign-card anim-rise";
      card.innerHTML =
        '<div class="sc-top"><span class="sc-glyph" aria-hidden="true">' + p.emoji + "</span>" +
        "<h4>" + p.name + "</h4></div>" +
        '<p class="sc-desc">' + p.desc + "</p>" +
        '<div class="sc-foot">' +
        '<span class="badge badge-cat sc-cat">' + p.cat + "</span>" +
        '<div class="sc-actions"><button type="button" class="btn btn-soft btn-sm" data-show>Practice →</button></div>' +
        "</div>";
      card.querySelector("[data-show]").addEventListener("click", function () {
        var box = SB.$("#tryTranscript");
        box.classList.add("is-show");
        box.innerHTML = "";
        SB.Engine.signPhrase(p.id, function (tok) {
          var w = document.createElement("span");
          w.className = "word " + SB.confClass(tok.conf);
          w.textContent = (tok.glyph ? tok.glyph + " " : "") + tok.text;
          box.appendChild(w);
        });
      });
      grid.appendChild(card);
    });
  }

  function clearNextTimer() {
    if (state.nextTimer) {
      clearTimeout(state.nextTimer);
      state.nextTimer = null;
    }
  }

  function pickTarget() {
    clearNextTimer();
    clearClip();
    highlightLivePad(null);
    state.locked = false;
    if (progress.review.length) {
      state.target = progress.review[0];
    } else {
      var unvisited = SB.LETTERS.filter(function (e) { return !progress.letters[e.l]; });
      var pool = (unvisited.length ? unvisited : SB.LETTERS);
      state.target = pool[Math.floor(Math.random() * pool.length)].l;
    }
    renderTarget();
    resetFeedbackIdle();
    updateStats();
    syncRecUi();
  }

  function renderTarget() {
    var info = SB.LETTER_MAP[state.target];
    var arena = SB.$("#arenaTarget");
    arena.className = "arena-target";
    SB.$("#targetLetter").textContent = info.l;
    var title = SB.$("#targetTitle");
    if (title) title.textContent = info.l;
    SB.$("#targetDesc").textContent = info.tip;
    SB.$("#pShape").textContent = info.shape;
    SB.$("#pOrient").textContent = info.orient;
    SB.$("#pLoc").textContent = info.loc;
    SB.$("#pMove").textContent = info.move;

    SB.$$("#letterPad button").forEach(function (b) {
      b.classList.toggle("is-target", b.dataset.l === info.l);
      b.classList.remove("is-correct");
    });
  }

  function resetFeedbackIdle() {
    var fb = SB.$("#feedback");
    if (!fb) return;
    fb.className = "feedback";
    if (recording) {
      fb.innerHTML = "<div><strong>Recording…</strong><p>Hold the target handshape steady. The pad previews live reads — press <strong>Stop</strong> when done.</p></div>";
    } else if (clipReady && clipFeats.length) {
      fb.innerHTML = "<div><strong>Clip ready — pick a letter</strong><p>Tap the pad or press a key. We grade accuracy from the recorded landmark clip (not live).</p></div>";
    } else if (cameraOn) {
      fb.innerHTML = "<div><strong>Waiting for a clip…</strong><p>Press <strong>Record</strong>, sign the target, then <strong>Stop</strong>. Pick a letter to grade the clip.</p></div>";
    } else {
      fb.innerHTML = "<div><strong>Camera off</strong><p>Turn Camera on to record a signing clip, or use the pad without a clip for simulated drills.</p></div>";
    }
  }

  function showFeedback(kind, html) {
    var fb = SB.$("#feedback");
    fb.className = "feedback is-show is-" + kind;
    fb.innerHTML = html;
  }

  function bumpStat(id) {
    var el = SB.$(id);
    if (!el) return;
    el.classList.remove("is-bump");
    void el.offsetWidth;
    el.classList.add("is-bump");
    setTimeout(function () { el.classList.remove("is-bump"); }, 240);
  }

  function applyGuess(tok) {
    var got = String(tok.text || "").toUpperCase();
    var pick = tok.pick ? String(tok.pick).toUpperCase() : got;
    var target = state.target;
    var padBtn = SB.$('#letterPad button[data-l="' + pick + '"]');
    var gotBtn = SB.$('#letterPad button[data-l="' + got + '"]');
    var arena = SB.$("#arenaTarget");
    var fromClip = tok.source === "clip";
    var detail = fromClip
      ? ("Clip graded <strong>" + got + "</strong> at " + SB.confPct(tok.conf) +
        " (" + (tok.frames || 0) + " landmark frames, " + (tok.votes || 0) + " letter votes). You picked " + pick + ".")
      : ("Read via pad at " + SB.confPct(tok.conf) + ".");

    if (got === target) {
      progress.letters[target] = progress.letters[target] || { tried: 0, n: 0, correct: 0 };
      progress.letters[target].correct++;
      state.sessionCorrect++;
      progress.streak++;
      progress.best = Math.max(progress.best, progress.streak);
      arena.classList.add("is-correct");
      if (gotBtn) {
        gotBtn.classList.remove("is-miss");
        gotBtn.classList.add("is-correct");
      }
      showFeedback("correct",
        "<span class='fb-ico'>✓</span><div><strong>Correct — clip matches " + target + "</strong>" +
        "<p>" + detail + (tok.conf < 0.85
          ? " Near-miss confidence — practice this handshape again."
          : " Clear handshape.") +
        "</p></div>");
      if (progress.review.length && progress.review[0] === target) {
        progress.review.shift();
      }
      save();
      updateStats();
      bumpStat("#statStreak");
      syncRecUi();
      state.nextTimer = setTimeout(pickTarget, SB.settings.reduceMotion ? 200 : 900);
    } else {
      progress.streak = 0;
      var info = SB.LETTER_MAP[target];
      var confs = (SB.CONFUSIONS[target] || []).slice(0, 3);
      if (padBtn) padBtn.classList.add("is-miss");
      if (gotBtn && got !== pick) gotBtn.classList.add("is-live");
      arena.classList.add("is-wrong");
      showFeedback("missed",
        "<span class='fb-ico'>✕</span><div><strong>Not quite — target " + target + ", clip read " + got + "</strong>" +
        "<p>" + detail + "</p>" +
        "<p>Check the handshape. <em>" + info.tip + "</em></p>" +
        (confs.length ? "<p>Often confused with: <strong>" + confs.join(" · ") + "</strong>.</p>" : "") +
        "<div class='fb-actions'>" +
        "<button type='button' class='btn btn-soft btn-sm' data-retry>Try again</button>" +
        "<button type='button' class='btn btn-ghost btn-sm' data-next>Next letter</button>" +
        "</div></div>");
      if (progress.review.indexOf(target) === -1) progress.review.push(target);
      save();
      updateStats();
      setTimeout(function () { arena.classList.remove("is-wrong"); }, 450);

      var retry = SB.$("[data-retry]", SB.$("#feedback"));
      var next = SB.$("[data-next]", SB.$("#feedback"));
      if (retry) {
        retry.addEventListener("click", function () {
          state.locked = false;
          clearClip();
          arena.className = "arena-target";
          resetFeedbackIdle();
          SB.$$("#letterPad button").forEach(function (b) {
            b.classList.toggle("is-target", b.dataset.l === target);
            b.classList.remove("is-live", "is-miss", "is-correct");
          });
          syncRecUi();
        });
      }
      if (next) {
        next.addEventListener("click", function () { pickTarget(); });
      }
      state.locked = false;
      syncRecUi();
    }
  }

  /**
   * Pad / keyboard: grade recorded clip (preferred) or simulated drill.
   * Pick = letter the learner taps; got = classifier vote over the clip.
   */
  function sign(letter) {
    if (state.locked || state.tab !== "arena") return;
    if (recording) {
      SB.toast("Stop recording before grading", "info");
      return;
    }
    letter = String(letter || "").toUpperCase();
    if (!/^[A-Z]$/.test(letter)) return;

    /* Camera path: require a landmark clip, then grade from buffer. */
    if (cameraOn) {
      if (!clipReady || !clipFeats.length) {
        SB.toast("Record and stop a clip first, then pick a letter", "info");
        resetFeedbackIdle();
        return;
      }
      var analysis = gradeClip();
      if (!analysis) {
        SB.toast("Could not read a letter from the clip — record again", "error");
        return;
      }

      progress.letters[state.target] = progress.letters[state.target] || { tried: 0, n: 0, correct: 0 };
      progress.letters[state.target].tried++;
      progress.letters[state.target].n++;
      state.sessionTried++;
      state.locked = true;
      syncRecUi();

      applyGuess({
        text: analysis.text,
        pick: letter,
        conf: analysis.conf,
        frames: analysis.frames,
        votes: analysis.votes,
        source: "clip",
      });
      return;
    }

    /* No camera: keep SimEngine pad drills. */
    progress.letters[letter] = progress.letters[letter] || { tried: 0, n: 0, correct: 0 };
    progress.letters[letter].tried++;
    progress.letters[letter].n++;
    state.sessionTried++;
    state.locked = true;
    SB.Engine.signLetter(letter, function (tok) {
      applyGuess(Object.assign({ source: "demo", pick: letter }, tok));
    });
  }

  function bindPad() {
    var pad = SB.$("#letterPad");
    pad.innerHTML = "";
    SB.LETTERS.forEach(function (e) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.l = e.l;
      btn.textContent = e.l;
      btn.setAttribute("aria-label", "Sign letter " + e.l);
      btn.title = e.l + " — " + e.shape;
      btn.addEventListener("click", function () { sign(e.l); });
      pad.appendChild(btn);
    });
  }

  function bindKeyboard() {
    document.addEventListener("keydown", function (e) {
      if (state.tab !== "arena") return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
      var k = e.key.toUpperCase();
      if (/^[A-Z]$/.test(k)) {
        e.preventDefault();
        sign(k);
      }
    });
  }

  function bindReview() {
    var list = SB.$("#reviewList");
    function render() {
      list.innerHTML = "";
      if (!progress.review.length) {
        list.innerHTML = '<div class="empty" style="min-height:120px"><div class="empty-icon">✓</div><div class="empty-title">Review clear</div><div class="empty-hint">Missed letters show up here until you master them.</div></div>';
        return;
      }
      progress.review.forEach(function (l) {
        var info = SB.LETTER_MAP[l];
        var item = document.createElement("div");
        item.className = "review-item";
        item.innerHTML =
          '<span class="rl-letter">' + l + "</span>" +
          '<div><strong style="font-size:13px">' + info.shape + "</strong>" +
          '<div class="rl-note">' + info.tip + "</div></div>";
        list.appendChild(item);
      });
    }
    render();
    SB.PracticeView._rerenderReview = render;
  }

  function updateStats() {
    var tried = progress.letters[state.target] ? progress.letters[state.target].n : 0;
    var correct = progress.letters[state.target] ? progress.letters[state.target].correct : 0;
    SB.$("#statLetter").textContent = state.target;
    SB.$("#statLetterNote").textContent = tried ? Math.round(correct / tried * 100) + "% on " + state.target : "first try";
    SB.$("#statStreak").textContent = String(progress.streak);
    SB.$("#statBest").textContent = String(progress.best);

    var ringFg = SB.$("#ringFg");
    var pct = state.sessionTried ? state.sessionCorrect / state.sessionTried : 0;
    var C = 283;
    ringFg.style.strokeDashoffset = C * (1 - pct);
    SB.$("#ringPct").textContent = Math.round(pct * 100) + "%";
    SB.$("#ringNote").textContent = state.sessionCorrect + " / " + state.sessionTried + " this session";

    if (SB.PracticeView._rerenderReview) SB.PracticeView._rerenderReview();
  }

  function bindPhraseDeck() {
    var deck = SB.$("#phraseDeck");
    deck.innerHTML = "";
    SB.PHRASES.forEach(function (p) {
      var card = document.createElement("div");
      card.className = "phrase-card";
      card.innerHTML =
        '<div class="pc-top"><span class="pc-glyph">' + p.emoji + "</span><h4>" + p.name + "</h4></div>" +
        "<p>" + p.desc + "</p>" +
        '<div class="pc-actions"><span class="badge badge-cat">' + p.cat + "</span>" +
        '<button class="btn btn-soft btn-sm">Practice</button></div>';
      var btn = card.querySelector(".pc-actions .btn");
      btn.addEventListener("click", function () {
        btn.disabled = true;
        var t = new SB.Transcript(SB.$("#phraseResult"), {});
        t.clear();
        SB.Engine.signPhrase(p.id, function (tok) { t.addToken(tok); }).then(function () {
          t.endUtterance();
          progress.phrases[p.id] = progress.phrases[p.id] || { tried: 0, n: 0 };
          progress.phrases[p.id].tried++;
          progress.phrases[p.id].n++;
          save();
          btn.disabled = false;
          SB.toast("Practiced \"" + p.name + "\"", "ok");
        });
      });
      deck.appendChild(card);
    });
  }

  var api = {
    init: init,
    /* CDP / local harness: seed a landmark clip then pad-grade. */
    _debugSeedClip: function (letter, frames) {
      letter = normalizeLiveLetter(letter) || "A";
      frames = frames || 12;
      clipFeats = [];
      clipVotes = [];
      var i;
      for (i = 0; i < frames; i++) {
        clipFeats.push(new Float32Array(63));
        clipVotes.push({ text: letter, conf: 0.88 });
      }
      var orig = SB.LetterClassifier && SB.LetterClassifier.classify;
      if (SB.LetterClassifier) {
        SB.LetterClassifier.classify = function () {
          return { text: letter, conf: 0.9, source: "live" };
        };
      }
      clipReady = true;
      syncRecUi();
      resetFeedbackIdle();
      return {
        frames: clipFeats.length,
        restore: function () {
          if (SB.LetterClassifier && orig) SB.LetterClassifier.classify = orig;
        },
      };
    },
  };
  return api;
};
