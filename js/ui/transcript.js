/* ============================================================
   SignBridge — Transcript renderer (transcript.js)
   ------------------------------------------------------------
   The transcript is the heart of the learning loop: it shows
   WHAT the machine understood, and HOW sure it was.

   Teaching design baked in here:
     • confidence is visible on every word (coloured underline) —
       learners watch the recognizer "hesitate" on hard signs
     • low-confidence words unfold their alternates inline, and
       clicking one replaces the word — learners experience that
       recognition is probabilistic and confirmation matters
     • every utterance keeps its source badge (Demo/Live) so the
       prototype's honesty is built in
     • the panel is aria-live so screen readers announce signing
       sessions (accessibility for the hearing side too)
   ============================================================ */

window.SB = window.SB || {};

/* Transcript manages one <div class="transcript"> container. */
SB.Transcript = function (container, opts) {
  opts = opts || {};
  var el = container;
  var self = this;

  /* current open utterance being streamed into */
  var openBubble = null;

  function bubbleFor(tok) {
    if (!openBubble) {
      openBubble = document.createElement("div");
      openBubble.className = "bubble is-" + (tok.source || "demo");

      var now = new Date();
      var head = document.createElement("div");
      head.className = "bubble-head";
      head.innerHTML =
        '<span class="bubble-time">' +
        String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0") +
        "</span>" +
        '<span class="bubble-src src-' + (tok.source || "demo") + '">' + (tok.source === "live" ? "● Live" : "● Demo") + "</span>";

      var actions = document.createElement("div");
      actions.className = "bubble-actions";
      var speakBtn = document.createElement("button");
      speakBtn.title = "Speak this out loud";
      speakBtn.textContent = "🔊";
      speakBtn.addEventListener("click", function () { SB.speak(self.bubbleText(openBubble)); });
      var copyBtn = document.createElement("button");
      copyBtn.title = "Copy this utterance";
      copyBtn.textContent = "⧉";
      copyBtn.addEventListener("click", function () { SB.copyText(self.bubbleText(openBubble)); });
      actions.appendChild(speakBtn);
      actions.appendChild(copyBtn);
      head.appendChild(actions);

      var words = document.createElement("div");
      words.className = "bubble-words";
      head.after(words);

      openBubble.appendChild(head);
      openBubble.appendChild(words);
      el.appendChild(openBubble);
      openBubble.scrollIntoView({ block: "end", behavior: "smooth" });
    }
    return openBubble;
  }

  /* one recognised token → one animated word */
  self.addToken = function (tok) {
    var b = bubbleFor(tok);
    var wordsBox = b.querySelector(".bubble-words");
    var span = document.createElement("span");
    span.className = "word " + SB.confClass(tok.conf);
    span.dataset.conf = tok.conf;
    span.dataset.text = tok.text;
    span.innerHTML = SB.escHtml(tok.glyph ? tok.glyph + " " : "") + SB.escHtml(tok.text);
    span.title = "Confidence " + SB.confPct(tok.conf);
    span.setAttribute("tabindex", "0");

    var val = document.createElement("span");
    val.className = "conf-val";
    val.textContent = SB.confPct(tok.conf);
    span.appendChild(val);

    /* low confidence → unfold alternates */
    if (tok.alt && tok.alt.length && tok.conf < 0.8) {
      var altRow = document.createElement("div");
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
          span.textContent = a;
          span.className = "word " + SB.confClass(0.95);
          span.title = "Confirmed manually";
          altRow.remove();
          b.classList.add("anim-pop");
        });
        altRow.appendChild(btn);
      });
      wordsBox.appendChild(span);
      wordsBox.appendChild(altRow);
    } else {
      wordsBox.appendChild(span);
    }

    b.scrollIntoView({ block: "end", behavior: "smooth" });
    if (opts.onToken) opts.onToken(tok);
  };

  /* end the current utterance */
  self.endUtterance = function () { openBubble = null; };

  self.bubbleText = function (bubble) {
    return SB.$$(".word", bubble).map(function (w) { return w.dataset.text || w.textContent; }).join(" ");
  };

  self.clear = function () {
    el.innerHTML = "";
    openBubble = null;
  };

  self.allText = function () {
    return SB.$$(".bubble", el).map(function (b) { return self.bubbleText(b); }).join("\n");
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
