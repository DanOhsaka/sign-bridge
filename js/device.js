/* ============================================================
   SignBridge — device gate: senses the device, then sends you to
   the desktop set of pages (root) or the phone set (/m/).
   ------------------------------------------------------------
   Loaded FIRST in <head> of EVERY page (both sets) so the redirect
   happens before anything paints.

   Phone pages if ANY of these is true (checked in this order):
     1. ?view= / "Use desktop site" override (this tab only)
     2. real phone: phone user-agent, UA-Client-Hints "mobile",
        or a touch-only screen whose short side is <= 600px
     3. pixels: the window is <= 640px wide
   Desktop pages otherwise. While the page is open, resizing the
   window across the line re-routes (<= 640 -> phone, >= 900 ->
   desktop; the gap stops flip-flopping). Real phones never
   re-route, and neither does an override.

   Overrides:  ?view=mobile | ?view=desktop | ?view=auto
   (kept in sessionStorage — they end when the tab closes)
   ============================================================ */
(function () {
  var SB = (window.SB = window.SB || {});
  var KEY = "sb.viewMode";
  var PHONE_MAX = 640, DESKTOP_MIN = 900;
  var onMobileSite = document.documentElement.getAttribute("data-site") === "mobile";

  function save(v) { try { if (v) sessionStorage.setItem(KEY, v); else sessionStorage.removeItem(KEY); } catch (e) {} }
  function saved() { try { return sessionStorage.getItem(KEY); } catch (e) { return null; } }

  var ua = navigator.userAgent || "";
  var uad = navigator.userAgentData;
  var uaPhone = !!((uad && uad.mobile === true) || /iPhone|iPod|Android.+Mobile|Windows Phone/i.test(ua));
  var touchOnly = matchMedia("(pointer: coarse)").matches && matchMedia("(hover: none)").matches;
  var shortSide = Math.min(screen.width, screen.height);
  var realPhone = uaPhone || (touchOnly && shortSide <= 600);

  var params = new URLSearchParams(location.search);
  var forced = params.get("view");
  if (forced === "mobile" || forced === "desktop") save(forced);
  else if (forced === "auto") save(null);
  var pref = saved();

  var wantMobile = pref ? pref === "mobile" : (realPhone || innerWidth <= PHONE_MAX);

  function go(toMobile) {
    params.delete("view");
    var page = location.pathname.split("/").pop() || "index.html";
    var to = new URL((toMobile ? "m/" : "../") + page, location.href);
    to.search = params.toString() ? "?" + params.toString() : "";
    to.hash = location.hash;
    location.replace(to.href);
  }

  try {
    console.info("[SignBridge device]", {
      showing: onMobileSite ? "phone pages" : "desktop pages",
      decision: wantMobile ? "phone pages" : "desktop pages",
      override: pref, realPhone: realPhone, uaPhone: uaPhone, touchOnly: touchOnly,
      screenShortSide: shortSide, windowWidth: innerWidth
    });
  } catch (e) {}

  if (wantMobile !== onMobileSite) { go(wantMobile); return; }

  if (!pref && !realPhone) {
    var timer;
    addEventListener("resize", function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (onMobileSite ? innerWidth >= DESKTOP_MIN : innerWidth <= PHONE_MAX) go(!onMobileSite);
      }, 250);
    });
  }

  SB.root = onMobileSite ? "../" : "";            /* prefix for resource URLs that are relative to the site root */
  SB.Device = {
    isMobile: onMobileSite,                     /* which set of pages is showing */
    realPhone: realPhone,
    override: pref,
    cameraConstraints: function () {            /* light, portrait, front camera */
      return { video: { facingMode: "user", width: { ideal: 480 }, height: { ideal: 640 }, frameRate: { ideal: 30 } }, audio: false };
    }
  };
  document.documentElement.classList.add(onMobileSite ? "is-mobile" : "is-desktop");
})();
