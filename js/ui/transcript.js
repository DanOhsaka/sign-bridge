/* ============================================================
   SignBridge — Transcript renderer (transcript.js)
   ------------------------------------------------------------
   Streaming sentence UX: words append into ONE continuous
   paragraph (like a generating sentence), not a vertical queue
   of per-word timestamped cards.

   Teaching design kept:
     • confidence is visible on every word (coloured underline)
     • low-confidence words unfold alternates inline
     • source badge (Demo/Live) shown once for the stream
     • aria-live so screen readers announce signing
   ============================================================ */

window.SB = window.SB || {};

/* Transcript manages one <div class="transcript"> container. */
SB.Transcript = function (container, opts) {
  opts = opts || {};
  var el = container;
  var self = this;

  /* single streaming sentence surface */
  var stream = null;
  var sentence = null;
  var sourceEl = null;
  var pendingBreak = false;

  function ensureStream(tok) {
    if (!stream) {
      el.innerHTML = "";
      stream = document.createElement("div");
      stream.className = "transcript-stream";

      var meta = document.createElement("div");
      meta.className = "stream-meta";
      sourceEl = document.createElement("span");
      sourceEl.className = "stream-src src-" + (tok.source || "demo");
      sourceEl.textContent = tok.source === "live" ? "● Live" : "● Demo";
      meta.appendChild(sourceEl);

      var hint = document.createElement("span");
      hint.className = "stream-hint";
      hint.textContent = "streaming";
      meta.appendChild(hint);

      sentence = document.createElement("p");
      sentence.className = "stream-sentence is-streaming";
      sentence.setAttribute("aria-live", "polite");

      stream.appendChild(meta);
      stream.appendChild(sentence);
      el.appendChild(stream);
    } else if (sourceEl && tok.source) {
      sourceEl.className = "stream-src src-" + tok.source;
      sourceEl.textContent = tok.source === "live" ? "● Live" : "● Demo";
    }
    return sentence;
  }

  function appendBreakIfNeeded() {
    if (!pendingBreak || !sentence || !sentence.childNodes.length) {
      pendingBreak = false;
      return;
    }
    /* soft sentence break — keep one continuous stream, no new card */
    var gap = document.createElement("span");
    gap.className = "sentence-gap";
    gap.setAttribute("aria-hidden", "true");
    gap.textContent = " · ";
    sentence.appendChild(gap);
    pendingBreak = false;
  }

  /* one recognised token → one word appended to the growing sentence */
  self.addToken = function (tok) {
    ensureStream(tok);
    appendBreakIfNeeded();

    var span = document.createElement("span");
    span.className = "word " + SB.confClass(tok.conf);
    span.dataset.conf = tok.conf;
    span.dataset.text = tok.text;
    var label = (tok.glyph ? tok.glyph + " " : "") + tok.text;
    /* trailing space so words read as a natural sentence */
    span.appendChild(document.createTextNode(label + " "));
    span.title = "Confidence " + SB.confPct(tok.conf);
    span.setAttribute("tabindex", "0");

    var val = document.createElement("span");
    val.className = "conf-val";
    val.textContent = SB.confPct(tok.conf);
    span.appendChild(val);

    /* low confidence → unfold alternates under the word (inline) */
    if (tok.alt && tok.alt.length && tok.conf < 0.8) {
      var wrap = document.createElement("span");
      wrap.className = "word-wrap";
      wrap.appendChild(span);

      var altRow = document.createElement("span");
      altRow.className = "word-alts";
      var lbl = document.createElement("span");
      lbl.className = "alt-lbl";
      lbl.textContent = "Did you mean?";
      altRow.appendChild(lbl);
      tok.alt.forEach(function (a) {
        var btn = document.createElement("button");
        btn.className = "alt-btn";
        btn.textContent = a;
        btn.addEventListener("click", function () {
          span.dataset.text = a;
          while (span.firstChild) span.removeChild(span.firstChild);
          span.appendChild(document.createTextNode(a + " "));
          span.appendChild(val);
          span.className = "word " + SB.confClass(0.95);
          span.title = "Confirmed manually";
          altRow.remove();
        });
        altRow.appendChild(btn);
      });
      wrap.appendChild(altRow);
      sentence.appendChild(wrap);
    } else {
      sentence.appendChild(span);
    }

    /* keep the newest word in view */
    el.scrollTop = el.scrollHeight;
    if (opts.onToken) opts.onToken(tok);
  };

  /* mark a soft pause between phrases — does NOT open a new card */
  self.endUtterance = function () {
    if (sentence && sentence.querySelector(".word")) pendingBreak = true;
  };

  self.bubbleText = function () {
    return self.allText();
  };

  self.clear = function () {
    el.innerHTML =
      '<div class="empty">' +
      '<div class="empty-icon">🗣️</div>' +
      'Press <span class="kbd">1</span>–<span class="kbd">9</span>, click a phrase, or hit ' +
      "<em>Watch a live demo</em> — everything streams here as a sentence, word by word." +
      "</div>";
    stream = null;
    sentence = null;
    sourceEl = null;
    pendingBreak = false;
  };

  self.allText = function () {
    if (!sentence) return "";
    return SB.$$(".word", sentence)
      .map(function (w) { return w.dataset.text || w.textContent; })
      .join(" ");
  };

  self.speakAll = function () { SB.speak(self.allText()); };
};

/* Shared "last sign" spotlight on the translate page */
SB.Spotlight = function (el) {
  var wordEl = SB.$(".spotlight-word", el);
  var confEl = SB.$(".conf-fill", el);
  var altsEl = SB.$(".spotlight-alts", el);

  return {
    show: function (tok) {
      wordEl.className = "spotlight-word " + SB.confClass(tok.conf);
      wordEl.innerHTML =
        (tok.glyph ? '<span class="glyph">' + tok.glyph + "</span>" : "") +
        SB.escHtml(tok.text) +
        '<span class="conf-pct">' + SB.confPct(tok.conf) + "</span>";
      confEl.style.width = (tok.conf * 100).toFixed(0) + "%";
      confEl.classList.toggle("is-low", tok.conf < 0.7);

      altsEl.innerHTML = "";
      if (tok.alt && tok.alt.length && tok.conf < 0.8) {
        var lbl = document.createElement("span");
        lbl.className = "alt-lbl";
        lbl.textContent = "Did you mean?";
        altsEl.appendChild(lbl);
        tok.alt.forEach(function (a) {
          var btn = document.createElement("button");
          btn.className = "alt-btn";
          btn.textContent = a;
          btn.addEventListener("click", function () {
            wordEl.textContent = a;
            wordEl.className = "spotlight-word is-high";
            confEl.style.width = "97%";
            altsEl.innerHTML = "";
            SB.toast("Confirmed: " + a + " — taught the model a correction", "ok");
          });
          altsEl.appendChild(btn);
        });
      }
    },
    clear: function () {
      wordEl.textContent = "—";
      wordEl.className = "spotlight-word";
      confEl.style.width = "0%";
      altsEl.innerHTML = "";
    },
  };
};
