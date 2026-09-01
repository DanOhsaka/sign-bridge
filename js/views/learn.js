/* ============================================================
   SignBridge — Learn view (learn.js)
   ------------------------------------------------------------
   A searchable sign dictionary + the communication guide.

   "Show me" streams the sign through the recognizer into a
   mini transcript — so learners map NAME ↔ RECOGNIZED OUTPUT
   without leaving the page. The same cards will later hold
   video of the sign; the data model (SB.PHRASES) already has
   the slot for it.
   ============================================================ */

window.SB = window.SB || {};

SB.LearnView = function () {
  var filter = { q: "", cat: "All" };

  function init() {
    buildCategories();
    renderGrid();
    bindSearch();
    renderEtiquette();
    renderFacts();
  }

  function buildCategories() {
    var cats = ["All"];
    SB.PHRASES.forEach(function (p) { if (cats.indexOf(p.cat) === -1) cats.push(p.cat); });

    var wrap = SB.$("#catChips");
    wrap.innerHTML = "";
    cats.forEach(function (c) {
      var chip = document.createElement("button");
      chip.className = "chip" + (c === "All" ? " is-on" : "");
      chip.dataset.cat = c;
      chip.textContent = c;
      chip.addEventListener("click", function () {
        SB.$$("#catChips .chip").forEach(function (x) { x.classList.remove("is-on"); });
        chip.classList.add("is-on");
        filter.cat = c;
        renderGrid();
      });
      wrap.appendChild(chip);
    });
  }

  function bindSearch() {
    var input = SB.$("#learnSearch");
    input.addEventListener("input", function () {
      filter.q = input.value.trim().toLowerCase();
      renderGrid();
    });
  }

  function renderGrid() {
    var grid = SB.$("#signGrid");
    grid.innerHTML = "";

    var items = SB.PHRASES.filter(function (p) {
      var catOk = filter.cat === "All" || p.cat === filter.cat;
      var qOk = !filter.q || p.name.toLowerCase().indexOf(filter.q) !== -1 ||
                p.desc.toLowerCase().indexOf(filter.q) !== -1 ||
                p.cat.toLowerCase().indexOf(filter.q) !== -1;
      return catOk && qOk;
    });

    if (!items.length) {
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><div class="empty-icon">🔍</div>No signs match — try a different word.</div>';
      return;
    }

    items.forEach(function (p) {
      var card = document.createElement("div");
      card.className = "sign-card anim-rise";
      card.innerHTML =
        '<div class="sc-top"><span class="sc-glyph">' + p.emoji + "</span><h4>" + p.name + "</h4>" +
        '<span class="badge badge-violet sc-cat">' + p.cat + "</span></div>" +
        '<p class="sc-desc">' + p.desc + "</p>" +
        '<div class="sc-actions"><button class="btn btn-soft btn-sm" data-show>🤟 Show me</button></div>';
      card.querySelector("[data-show]").addEventListener("click", function () {
        var box = SB.$("#tryTranscript");
        box.classList.add("is-show");
        box.innerHTML = "";
        SB.Engine.signPhrase(p.id, function (tok) {
          var w = document.createElement("span");
          w.className = "word " + SB.confClass(tok.conf);
          w.textContent = tok.glyph ? tok.glyph + " " : "" + tok.text;
          box.appendChild(w);
        }).then(function () {
          /* end of utterance: leave the words visible */
        });
      });
      grid.appendChild(card);
    });
  }

  function renderEtiquette() {
    var list = SB.$("#etiquetteList");
    list.innerHTML = "";
    SB.ETIQUETTE.forEach(function (tip) {
      var li = document.createElement("li");
      li.innerHTML = "<div><strong>" + tip.title + ".</strong> " + tip.text + "</div>";
      list.appendChild(li);
    });
  }

  function renderFacts() {
    var wrap = SB.$("#factCards");
    wrap.innerHTML = "";
    SB.ASL_FACTS.forEach(function (f) {
      var card = document.createElement("div");
      card.className = "card fact-card";
      card.innerHTML = '<span class="fc-ico">' + f.ico + "</span><p>" + f.text + "</p>";
      wrap.appendChild(card);
    });
  }

  return { init: init };
};
