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
     • optional per-word timestamps + live-word pulse
     • aria-live so screen readers announce signing
   ============================================================ */

window.SB = window.SB || {};

SB._TX_EMPTY_HTML =
  '<div class="empty tx-empty">' +
  '<div class="empty-title">Waiting for signs</div>' +
  '<div class="empty-hint">Words stream here as one growing sentence. Press ' +
  '<span class="kbd">1</span>–<span class="kbd">9</span>, watch the demo, or switch to Live.</div>' +
  "</div>";

function SB_formatClock(d) {
  var h = d.getHours();
  var m = d.getMinutes();
  var s = d.getSeconds();
  var pad = function (n) { return n < 10 ? "0" + n : String(n); };
  return pad(h) + ":" + pad(m) + ":" + pad(s);
}

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
  var lastWordEl = null;
  var startedAt = null;

  function setWorkspaceStatus(mode, live) {
    var status = document.getElementById("txStatus");
    var dot = document.getElementById("txLiveDot");
    if (status) {
      status.textContent = mode || "Idle";
      status.classList.toggle("is-live", !!live);
      status.classList.toggle("is-active", mode === "Streaming" || mode === "Live");
    }
    if (dot) {
      dot.classList.toggle("is-on", !!live || mode === "Streaming");
    }
  }

  function updateCurrentSign(tok) {
    var word = document.getElementById("txCurrentWord");
    var conf = document.getElementById("txCurrentConf");
    var time = document.getElementById("txCurrentTime");
    var panel = document.getElementById("txCurrent");
    if (!word) return;
    if (!tok || !tok.text) {
      word.textContent = "—";
      word.className = "tx-current-word";
      if (conf) conf.textContent = "";
      if (time) time.textContent = "";
      if (panel) panel.classList.remove("has-sign");
      return;
    }
    var label = (tok.glyph ? tok.glyph + " " : "") + tok.text;
    word.textContent = label;
    word.className = "tx-current-word " + SB.confClass(tok.conf);
    if (conf) conf.textContent = SB.confPct(tok.conf);
    if (time) time.textContent = SB_formatClock(new Date());
    if (panel) panel.classList.add("has-sign");
  }

  function ensureStream(tok) {
    if (!stream) {
      el.innerHTML = "";
      stream = document.createElement("div");
      stream.className = "transcript-stream";

      var meta = document.createElement("div");
      meta.className = "stream-meta";
      sourceEl = document.createElement("span");
      sourceEl.className = "stream-src src-" + (tok.source || "demo");
      sourceEl.textContent = tok.source === "live" || tok.source === "lstm"
        ? "● Live"
        : "● Demo";
      meta.appendChild(sourceEl);

      var hint = document.createElement("span");
      hint.className = "stream-hint";
      hint.innerHTML = '<span class="live-word-pip" aria-hidden="true"></span> streaming';
      meta.appendChild(hint);

      if (!startedAt) startedAt = new Date();
      var clock = document.createElement("span");
      clock.className = "stream-clock";
      clock.textContent = "Started " + SB_formatClock(startedAt);
      meta.appendChild(clock);

      sentence = document.createElement("p");
      sentence.className = "stream-sentence is-streaming";
      sentence.setAttribute("aria-live", "polite");

      stream.appendChild(meta);
      stream.appendChild(sentence);
      el.appendChild(stream);
      setWorkspaceStatus("Streaming", tok.source === "live" || tok.source === "lstm");
    } else if (sourceEl && tok.source) {
      sourceEl.className = "stream-src src-" + tok.source;
      sourceEl.textContent = tok.source === "live" || tok.source === "lstm"
        ? "● Live"
        : "● Demo";
      setWorkspaceStatus(
        tok.source === "live" || tok.source === "lstm" ? "Live" : "Streaming",
        tok.source === "live" || tok.source === "lstm"
      );
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

    var raw = (tok && tok.text != null) ? String(tok.text) : "";
    var text = raw.replace(/\s+/g, " ").trim();
    if (!text) return;

    var now = new Date();
    var span = document.createElement("span");
    span.className = "word is-live-word " + SB.confClass(tok.conf);
    span.dataset.conf = tok.conf;
    span.dataset.text = text;
    span.dataset.ts = String(now.getTime());
    var label = (tok.glyph ? tok.glyph + " " : "") + text;
    /* trailing space so words read as a natural sentence */
    span.appendChild(document.createTextNode(label + " "));
    span.title = "Confidence " + SB.confPct(tok.conf) + " · " + SB_formatClock(now);
    span.setAttribute("tabindex", "0");

    var val = document.createElement("span");
    val.className = "conf-val";
    val.textContent = SB.confPct(tok.conf);
    span.appendChild(val);

    var ts = document.createElement("span");
    ts.className = "word-ts";
    ts.textContent = SB_formatClock(now);
    span.appendChild(ts);

    if (lastWordEl) lastWordEl.classList.remove("is-live-word");
    lastWordEl = span;

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
          span.appendChild(ts);
          span.className = "word is-live-word " + SB.confClass(0.95);
          span.title = "Confirmed manually · " + SB_formatClock(now);
          altRow.remove();
          updateCurrentSign({ text: a, conf: 0.95, glyph: tok.glyph });
        });
        altRow.appendChild(btn);
      });
      wrap.appendChild(altRow);
      sentence.appendChild(wrap);
    } else {
      sentence.appendChild(span);
    }

    updateCurrentSign(tok);

    /* keep the newest word in view */
    el.scrollTop = el.scrollHeight;
    if (opts.onToken) opts.onToken(tok);
  };

  /* mark a soft pause between phrases — does NOT open a new card */
  self.endUtterance = function () {
    if (sentence && sentence.querySelector(".word")) pendingBreak = true;
    if (lastWordEl) lastWordEl.classList.remove("is-live-word");
  };

  self.bubbleText = function () {
    return self.allText();
  };

  self.clear = function () {
    el.innerHTML = SB._TX_EMPTY_HTML;
    stream = null;
    sentence = null;
    sourceEl = null;
    pendingBreak = false;
    lastWordEl = null;
    startedAt = null;
    updateCurrentSign(null);
    setWorkspaceStatus("Idle", false);
  };

  self.allText = function () {
    if (!sentence) return "";
    return SB.$$(".word", sentence)
      .map(function (w) { return w.dataset.text || w.textContent; })
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  };

  self.downloadText = function (filename) {
    var text = self.allText();
    if (!text) return false;
    var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    var name = filename || ("signbridge-transcript-" + stamp + ".txt");
    var header = "SignBridge Live Transcript\n" +
      "Exported " + new Date().toLocaleString() + "\n" +
      "----------------------------------------\n\n";
    var blob = new Blob([header + text + "\n"], { type: "text/plain;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    return true;
  };

  self.setCurrentSign = updateCurrentSign;
  self.setStatus = setWorkspaceStatus;

  self.speakAll = function () { SB.speak(self.allText()); };

  /* initial workspace chrome */
  setWorkspaceStatus("Idle", false);
  updateCurrentSign(null);
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
