/* ============================================================
   SignBridge — App bootstrap (app.js)
   ------------------------------------------------------------
   Boots the view controller for the current page. Pages declare
   their view via <body data-view="…">.
   ============================================================ */

window.SB = window.SB || {};

(function () {
  SB.initCommon();

  var view = document.body.getAttribute("data-view");
  var ctrl = null;

  switch (view) {
    case "translate":
      ctrl = SB.TranslateView();
      break;
    case "practice":
      ctrl = SB.PracticeView();
      break;
    case "learn":
      ctrl = SB.LearnView();
      break;
    case "login":
    case "register":
      ctrl = SB.AuthView();
      break;
  }

  if (ctrl) ctrl.init();

  if (view !== "login" && view !== "register") {
    var settings = SB.SettingsView();
    settings.bind();
  }
})();
