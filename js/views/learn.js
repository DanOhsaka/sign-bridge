/* ============================================================
   SignBridge — Learn view (learn.js)
   ASL communication quick guide + informative resources.
   Sign practice grid lives on Practice.
   ============================================================ */

window.SB = window.SB || {};

SB.LearnView = function () {

  function init() {
    renderEtiquette();
    renderFacts();
    renderResources();
  }

  function renderEtiquette() {
    var list = SB.$("#etiquetteList");
    if (!list) return;
    list.innerHTML = "";
    (SB.ETIQUETTE || []).forEach(function (tip) {
      var li = document.createElement("li");
      li.innerHTML = "<div><strong>" + tip.title + ".</strong> " + tip.text + "</div>";
      list.appendChild(li);
    });
  }

  function renderFacts() {
    var wrap = SB.$("#factCards");
    if (!wrap) return;
    wrap.innerHTML = "";
    (SB.ASL_FACTS || []).forEach(function (f) {
      var card = document.createElement("div");
      card.className = "card fact-card";
      card.innerHTML = '<span class="fc-ico">' + f.ico + "</span><p>" + f.text + "</p>";
      wrap.appendChild(card);
    });
  }

  function renderResources() {
    var wrap = SB.$("#resourceCards");
    if (!wrap) return;
    wrap.innerHTML = "";
    (SB.LEARN_RESOURCES || []).forEach(function (r) {
      var card = document.createElement("article");
      card.className = "resource-card card";
      card.innerHTML =
        '<div class="rc-tag">' + SB.escHtml(r.tag) + "</div>" +
        "<h3>" + SB.escHtml(r.title) + "</h3>" +
        "<p>" + SB.escHtml(r.blurb) + "</p>" +
        '<a class="rc-link" href="' + SB.escHtml(r.url) +
        '" target="_blank" rel="noopener noreferrer">' +
        SB.escHtml(r.label || "Open resource") +
        ' <span aria-hidden="true">↗</span></a>';
      wrap.appendChild(card);
    });
  }

  return { init: init };
};
