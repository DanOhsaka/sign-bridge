/* ============================================================
   SignBridge — Practice view (practice.js)
   ------------------------------------------------------------
   Pedagogy at work:

     • LETTERS run on spaced practice — letters you miss go on
       the review list and are served again, until they leave.
     • Every miss shows the MINIMAL PAIR: "S has the thumb
       wrapped OVER the fingers — check you're not doing T."
       Error + explanation = the strongest learning moment.
     • The arena always shows the four phonological parameters
       (handshape · orientation · location · movement), the same
       lens a teacher corrects with.
     • The simulated recognizer mirrors real near-misses
       (A/S/T, U/V, M/N…) so students learn the confusions the
       actual model will later have.

   Input today: keyboard / letter pad (demo engine). When the
   real classifier plugs in (SB.LiveEngine.setClassifier), the
   same arena can score real webcam signing — the UI already
   speaks tokens, not keys.
   ============================================================ */

window.SB = window.SB || {};

SB.PracticeView = function () {
  var progress = SB.store.get("progress", {
    letters: {},      // { A: {tried, n, correct} }
    review: [],       // letters to re-drill
    phrases: {},      // { id: {tried, n} }
    streak: 0,
    best: 0,
  });

  var state = { tab: "letters", target: null, sessionCorrect: 0, sessionTried: 0 };

  function save() { SB.store.set("progress", progress); }

  function init() {
    bindTabs();
    pickTarget();
    bindPad();
    bindKeyboard();
    bindReview();
    bindPhraseDeck();
    renderMinipairs();
    updateStats();
  }

  /* ---------- minimal-pairs cheat sheet ---------- */
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

  /* ---------- tabs ---------- */
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

  /* ---------- arena ---------- */
  function pickTarget() {
    /* review letters get priority — spaced repetition */
    if (progress.review.length) {
      state.target = progress.review[0];
    } else {
      var unvisited = SB.LETTERS.filter(function (e) { return !progress.letters[e.l]; });
      var pool = (unvisited.length ? unvisited : SB.LETTERS);
      state.target = pool[Math.floor(Math.random() * pool.length)].l;
    }
    renderTarget();
  }

  function renderTarget() {
    var info = SB.LETTER_MAP[state.target];
    var arena = SB.$("#arenaTarget");
    arena.className = "arena-target";
    SB.$("#targetLetter").textContent = info.l;
    SB.$("#targetDesc").textContent = info.tip;
    SB.$("#pShape").textContent = info.shape;
    SB.$("#pOrient").textContent = info.orient;
    SB.$("#pLoc").textContent = info.loc;
    SB.$("#pMove").textContent = info.move;

    /* highlight the target on the pad */
    SB.$$("#letterPad button").forEach(function (b) {
      b.classList.toggle("is-target", b.dataset.l === info.l);
    });

    SB.$("#feedback").className = "feedback";
  }

  function showFeedback(kind, html) {
    var fb = SB.$("#feedback");
    fb.className = "feedback is-show is-" + kind;
    fb.innerHTML = html;
  }

  /* ---------- signing a letter (the core loop) ---------- */
  function sign(letter) {
    var target = state.target;
    progress.letters[letter] = progress.letters[letter] || { tried: 0, n: 0, correct: 0 };
    progress.letters[letter].tried++;
    progress.letters[letter].n++;
    state.sessionTried++;

    SB.Engine.signLetter(letter, function (tok) {
      var got = tok.text;
      var padBtn = SB.$('#letterPad button[data-l="' + letter + '"]');
      var arena = SB.$("#arenaTarget");

      if (got === target) {
        /* correct — possibly with a confidence wobble (near-miss) */
        progress.letters[letter].correct++;
        state.sessionCorrect++;
        progress.streak++;
        progress.best = Math.max(progress.best, progress.streak);
        arena.classList.add("is-correct");
        showFeedback("correct",
          "<span class='fb-ico'>🎉</span><div><strong>" + target + " — nice!</strong>" +
          "<p>" + (tok.conf < 0.85
            ? "The recognizer caught it at " + SB.confPct(tok.conf) + " — that's the near-miss zone. Practice this handshape once more later."
            : "The recognizer read it at " + SB.confPct(tok.conf) + ". Strong, clear handshape.") + "</p></div>");
        if (padBtn) { padBtn.classList.remove("is-miss"); padBtn.classList.add("is-target"); }
        /* review letters leave the list when mastered */
        if (progress.review.length) {
          progress.review.shift();
          save();
        }
        setTimeout(pickTarget, 900);
      } else {
        /* missed — teach the difference, add to review */
        progress.streak = 0;
        var info = SB.LETTER_MAP[target];
        var confs = (SB.CONFUSIONS[target] || []).slice(0, 3);
        var gotName = SB.LETTER_MAP[got] ? " — read as " + got : "";
        if (padBtn) padBtn.classList.add("is-miss");
        arena.classList.add("is-wrong");
        showFeedback("missed",
          "<span class='fb-ico'>💡</span><div><strong>Near-miss: the recognizer read " + got + gotName + "</strong>" +
          "<p>Check the handshape. <em>" + info.tip + "</em></p>" +
          (confs.length ? "<p>Commonly confused with: <strong>" + confs.join(" · ") + "</strong>. Feel the difference, then try again.</p>" : "") +
          "</div>");
        if (progress.review.indexOf(target) === -1) progress.review.push(target);
        save();
        setTimeout(function () { arena.classList.remove("is-wrong"); }, 500);
        setTimeout(pickTarget, 1600);
      }
      updateStats();
    });
  }

  /* ---------- input: pad + keyboard ---------- */
  function bindPad() {
    var pad = SB.$("#letterPad");
    pad.innerHTML = "";
    SB.LETTERS.forEach(function (e) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.l = e.l;
      btn.textContent = e.l;
      btn.title = e.l + " — " + e.shape;
      btn.addEventListener("click", function () { sign(e.l); });
      pad.appendChild(btn);
    });
  }

  function bindKeyboard() {
    document.addEventListener("keydown", function (e) {
      if (state.tab !== "letters") return;
      if (e.target.tagName === "INPUT") return;
      var k = e.key.toUpperCase();
      if (/^[A-Z]$/.test(k)) sign(k);
      else if (/^[0-9]$/.test(k)) sign(k); // numbers 1–8 are letters in ASL too
    });
  }

  /* ---------- review list ---------- */
  function bindReview() {
    var list = SB.$("#reviewList");
    function render() {
      list.innerHTML = "";
      if (!progress.review.length) {
        list.innerHTML = '<div class="empty"><div class="empty-icon">🧘</div>No letters in review — you\'re nailing it.</div>';
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
    /* re-render after each round via the ring update path */
    SB.PracticeView._rerenderReview = render;
  }

  /* ---------- stats + progress ring ---------- */
  function updateStats() {
    var tried = progress.letters[state.target] ? progress.letters[state.target].n : 0;
    var correct = progress.letters[state.target] ? progress.letters[state.target].correct : 0;
    SB.$("#statLetter").textContent = state.target;
    SB.$("#statLetterNote").textContent = tried ? Math.round(correct / tried * 100) + "% on " + state.target : "first try";
    SB.$("#statStreak").innerHTML = progress.streak + (progress.streak ? " <em>🔥</em>" : "");
    SB.$("#statBest").textContent = progress.best;

    var ringFg = SB.$("#ringFg");
    var pct = state.sessionTried ? state.sessionCorrect / state.sessionTried : 0;
    var C = 283; // 2πr
    ringFg.style.strokeDashoffset = C * (1 - pct);
    SB.$("#ringPct").textContent = Math.round(pct * 100) + "%";
    SB.$("#ringNote").textContent = state.sessionCorrect + " / " + state.sessionTried + " this session";

    if (SB.PracticeView._rerenderReview) SB.PracticeView._rerenderReview();
  }

  /* ---------- phrases deck ---------- */
  function bindPhraseDeck() {
    var deck = SB.$("#phraseDeck");
    deck.innerHTML = "";
    SB.PHRASES.forEach(function (p) {
      var card = document.createElement("div");
      card.className = "phrase-card";
      card.innerHTML =
        '<div class="pc-top"><span class="pc-glyph">' + p.emoji + "</span><h4>" + p.name + "</h4>" +
        '<span class="badge badge-violet pc-cat">' + p.cat + "</span></div>" +
        "<p>" + p.desc + "</p>" +
        '<div class="pc-actions"><button class="btn btn-soft btn-sm">🤟 Practice</button></div>';
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
          SB.toast("Practiced \"" + p.name + "\" — repeat it until it feels smooth", "ok");
        });
      });
      deck.appendChild(card);
    });
  }

  return { init: init };
};
