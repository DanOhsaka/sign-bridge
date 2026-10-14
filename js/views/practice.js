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
    tab: "letters",
    target: null,
    sessionCorrect: 0,
    sessionTried: 0,
    locked: false,
    nextTimer: null,
  };

  function save() { SB.store.set("progress", progress); }

  function init() {
    bindTabs();
    pickTarget();
    bindPad();
    bindKeyboard();
    bindReview();
    bindPhraseDeck();
    renderMinipairs();
    resetFeedbackIdle();
    updateStats();
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
        SB.$("#lettersPane").style.display = state.tab === "letters" ? "" : "none";
        SB.$("#phrasesPane").style.display = state.tab === "phrases" ? "" : "none";
      });
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
    fb.innerHTML = "<div><strong>Waiting for your answer…</strong><p>Press the matching letter on your keyboard, or tap the pad below.</p></div>";
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

  function sign(letter) {
    if (state.locked || state.tab !== "letters") return;
    var target = state.target;
    progress.letters[letter] = progress.letters[letter] || { tried: 0, n: 0, correct: 0 };
    progress.letters[letter].tried++;
    progress.letters[letter].n++;
    state.sessionTried++;
    state.locked = true;

    SB.Engine.signLetter(letter, function (tok) {
      var got = tok.text;
      var padBtn = SB.$('#letterPad button[data-l="' + letter + '"]');
      var arena = SB.$("#arenaTarget");

      if (got === target) {
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
            ? "Caught at " + SB.confPct(tok.conf) + " (near-miss zone). Practice this handshape again later."
            : "Read at " + SB.confPct(tok.conf) + ". Clear handshape.") +
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
          "<span class='fb-ico'>✕</span><div><strong>Not quite — read as " + got + "</strong>" +
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
            arena.className = "arena-target";
            resetFeedbackIdle();
            SB.$$("#letterPad button").forEach(function (b) {
              b.classList.toggle("is-target", b.dataset.l === target);
            });
          });
        }
        if (next) {
          next.addEventListener("click", function () { pickTarget(); });
        }
        /* unlock after miss so try-again works; don't auto-advance */
        state.locked = false;
      }
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
      if (state.tab !== "letters") return;
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
