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
  var livePending = null; /* { letter, conf, firstMs, lastMs } */
  var liveConfirmTimer = null;
  var liveListenersBound = false;

  function live() { return SB.Engine.getLiveEngine(); }

  function save() { SB.store.set("progress", progress); }

  function init() {
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

  function attachLetterClassifier() {
    var eng = live();
    if (SB.LetterClassifier && typeof SB.LetterClassifier.classify === "function") {
      eng.setClassifier(function (feats) {
        return SB.LetterClassifier.classify(feats);
      });
      eng._classifierKind = "letter";
      return true;
    }
    eng.setClassifier(null);
    eng._classifierKind = null;
    return false;
  }

  function clearLivePending() {
    livePending = null;
    if (liveConfirmTimer != null) {
      clearTimeout(liveConfirmTimer);
      liveConfirmTimer = null;
    }
  }

  function holdMsFor(conf) {
    conf = typeof conf === "number" ? conf : 0;
    if (conf >= 0.85) return 140;
    if (conf >= 0.7) return 220;
    if (conf >= 0.55) return 320;
    return 420;
  }

  function normalizeLiveLetter(text) {
    var t = String(text || "").trim().toUpperCase();
    if (/^[A-Z]$/.test(t)) return t;
    return null;
  }

  function highlightLivePad(letter) {
    SB.$$("#letterPad button").forEach(function (b) {
      b.classList.toggle("is-live", !!letter && b.dataset.l === letter);
    });
  }

  function considerLiveLetter(tok) {
    if (state.tab !== "arena" || !cameraOn || state.locked) return;
    var letter = normalizeLiveLetter(tok && tok.text);
    if (!letter) return;
    var conf = typeof tok.conf === "number" ? tok.conf : 0;
    var now = performance.now();
    highlightLivePad(letter);

    if (livePending && livePending.letter === letter) {
      livePending.lastMs = now;
      livePending.conf = Math.max(livePending.conf, conf);
    } else {
      livePending = { letter: letter, conf: conf, firstMs: now, lastMs: now };
      if (liveConfirmTimer != null) clearTimeout(liveConfirmTimer);
      var hold = holdMsFor(conf);
      liveConfirmTimer = setTimeout(function () {
        liveConfirmTimer = null;
        if (!livePending || livePending.letter !== letter) return;
        if (state.locked || state.tab !== "arena" || !cameraOn) return;
        var waited = Math.max(0, livePending.lastMs - livePending.firstMs);
        var scored = livePending.letter;
        clearLivePending();
        try {
          var eng = live();
          if (eng && eng.noteConfirmMs) eng.noteConfirmMs(waited);
        } catch (e) {}
        sign(scored, { source: "live", conf: conf });
      }, hold);
    }
  }

  function stopCamera(opts) {
    opts = opts || {};
    cameraOn = false;
    liveStarting = false;
    clearLivePending();
    highlightLivePad(null);
    syncCameraChip();
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
      stage.classList.remove("is-cam", "is-mirror", "is-starting", "is-error");
    }
    setStageOverlay(
      "waiting",
      "Waiting for camera to be turned on",
      "Toggle Camera on to sign letters with Live tracking."
    );
    var st = SB.$("#stageStatus");
    if (st) {
      st.classList.remove("is-hands");
      st.innerHTML = '<span class="dot"></span>Camera off — turn Camera on for Live letter drills.';
    }
    if (!opts.silent) SB.toast("Camera off", "info");
  }

  function goLive() {
    if (state.tab !== "arena") return;
    if (liveStarting) return;
    cameraOn = true;
    liveStarting = true;
    syncCameraChip();
    clearLivePending();

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
        st.innerHTML = live().hasClassifier()
          ? '<span class="dot"></span>Live letter cam on — sign the target handshape.'
          : '<span class="dot"></span>Camera on — landmarks only (letter classifier missing).';
      }
      SB.toast("Live letter cam on", "ok");
    }).catch(function (err) {
      liveStarting = false;
      cameraOn = false;
      syncCameraChip();
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
    setStageOverlay(
      "waiting",
      "Waiting for camera to be turned on",
      "Open Arena and toggle Camera on to start Live letter drills."
    );

    if (!liveListenersBound) {
      liveListenersBound = true;
      SB.Engine.on("result", function (tok) {
        if (state.tab !== "arena" || !cameraOn) return;
        considerLiveLetter(tok);
      });
      SB.Engine.on("hands", function (count) {
        if (state.tab !== "arena" || !cameraOn) return;
        var st = SB.$("#stageStatus");
        if (!st) return;
        if (count > 0) {
          st.classList.add("is-hands");
          st.innerHTML = '<span class="dot"></span>Hand detected — reading letter handshape…';
        } else {
          st.classList.remove("is-hands");
          st.innerHTML = '<span class="dot"></span>Move a hand into view and sign the target letter.';
          clearLivePending();
          highlightLivePad(null);
        }
      });
      window.addEventListener("pagehide", function () {
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
    clearLivePending();
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
    fb.innerHTML = cameraOn
      ? "<div><strong>Waiting for your answer…</strong><p>Sign the target with the Live camera — the pad lights up as it reads. You can also tap the pad or press a key.</p></div>"
      : "<div><strong>Waiting for your answer…</strong><p>Turn Camera on to sign with Live tracking, or tap the pad / press a key.</p></div>";
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
    var letter = String(tok.text || "").toUpperCase();
    var target = state.target;
    var padBtn = SB.$('#letterPad button[data-l="' + letter + '"]');
    var arena = SB.$("#arenaTarget");
    var src = tok.source === "live" ? "camera" : "pad";

    if (letter === target) {
      progress.letters[letter] = progress.letters[letter] || { tried: 0, n: 0, correct: 0 };
      progress.letters[letter].correct++;
      state.sessionCorrect++;
      progress.streak++;
      progress.best = Math.max(progress.best, progress.streak);
      arena.classList.add("is-correct");
      if (padBtn) {
        padBtn.classList.remove("is-miss");
        padBtn.classList.add("is-correct");
      }
      showFeedback("correct",
        "<span class='fb-ico'>✓</span><div><strong>Correct — " + target + "</strong>" +
        "<p>" + (tok.conf < 0.85
          ? "Caught via " + src + " at " + SB.confPct(tok.conf) + " (near-miss zone). Practice this handshape again later."
          : "Read via " + src + " at " + SB.confPct(tok.conf) + ". Clear handshape.") +
        "</p></div>");
      if (progress.review.length && progress.review[0] === target) {
        progress.review.shift();
      }
      save();
      updateStats();
      bumpStat("#statStreak");
      state.nextTimer = setTimeout(pickTarget, SB.settings.reduceMotion ? 200 : 700);
    } else {
      progress.streak = 0;
      var info = SB.LETTER_MAP[target];
      var confs = (SB.CONFUSIONS[target] || []).slice(0, 3);
      if (padBtn) padBtn.classList.add("is-miss");
      arena.classList.add("is-wrong");
      showFeedback("missed",
        "<span class='fb-ico'>✕</span><div><strong>Not quite — " + src + " read " + letter + "</strong>" +
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
          clearLivePending();
          arena.className = "arena-target";
          resetFeedbackIdle();
          SB.$$("#letterPad button").forEach(function (b) {
            b.classList.toggle("is-target", b.dataset.l === target);
            b.classList.remove("is-live");
          });
        });
      }
      if (next) {
        next.addEventListener("click", function () { pickTarget(); });
      }
      /* unlock after miss so try-again / live cam can continue */
      state.locked = false;
    }
  }

  /**
   * Score a letter guess from pad, keyboard, or Live camera.
   * @param {string} letter
   * @param {{source?:string, conf?:number}=} liveTok
   */
  function sign(letter, liveTok) {
    if (state.locked || state.tab !== "arena") return;
    letter = String(letter || "").toUpperCase();
    if (!/^[A-Z]$/.test(letter)) return;

    progress.letters[letter] = progress.letters[letter] || { tried: 0, n: 0, correct: 0 };
    progress.letters[letter].tried++;
    progress.letters[letter].n++;
    state.sessionTried++;
    state.locked = true;
    clearLivePending();

    if (liveTok && liveTok.source === "live") {
      applyGuess({
        text: letter,
        conf: typeof liveTok.conf === "number" ? liveTok.conf : 0.8,
        source: "live",
      });
      return;
    }

    /* Pad / keyboard: keep SimEngine near-miss behavior for drills without cam. */
    SB.Engine.signLetter(letter, function (tok) {
      applyGuess(Object.assign({ source: "demo" }, tok));
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

  return { init: init };
};
