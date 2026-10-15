/* SignBridge — live captions over the camera feed (phone pages).
   Mirrors what the transcript receives, shows the current phrase as
   subtitles on the stage, then fades out a few seconds after signing stops. */
SB.Captions = (function () {
  var el = null, words = [], ended = false, timer = null;

  function render() {
    el.textContent = words.slice(-8).map(function (t) { return t.text; }).join(" ");
    el.classList.add("is-on");
  }
  function fadeAfter(ms) {
    clearTimeout(timer);
    timer = setTimeout(function () { el.classList.remove("is-on"); words = []; }, ms);
  }

  return {
    attach: function (transcript) {
      el = SB.$("#captions");
      if (!el) return;
      var add = transcript.addToken, end = transcript.endUtterance;
      transcript.addToken = function (tok) {
        if (ended) { words = []; ended = false; }   /* new phrase starts a fresh caption */
        words.push(tok); render(); fadeAfter(6000);
        return add.apply(this, arguments);
      };
      transcript.endUtterance = function () {
        ended = true; fadeAfter(3500);
        return end.apply(this, arguments);
      };
    }
  };
})();
