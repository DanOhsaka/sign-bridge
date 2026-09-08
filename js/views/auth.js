/* ============================================================
   SignBridge — Auth UI (auth.js)
   ------------------------------------------------------------
   Login + registration views. Validation and session chrome
   live here. Account create/login POST to /api/auth/* so a
   Node + Mongo backend can drop in without touching the HTML.
   ============================================================ */

window.SB = window.SB || {};

SB.API_BASE = "";

SB.Auth = {
  current: function () {
    var session = SB.store.get("session", null);
    if (session && session.email) return session;
    try {
      var raw = sessionStorage.getItem("sb.session");
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  },

  setSession: function (payload, remember) {
    var session = {
      name: payload.name || payload.user && payload.user.name,
      email: payload.email || payload.user && payload.user.email,
      token: payload.token || null,
      at: Date.now()
    };
    if (remember) {
      SB.store.set("session", session);
      try { sessionStorage.removeItem("sb.session"); } catch (e) {}
    } else {
      SB.store.set("session", null);
      try { sessionStorage.setItem("sb.session", JSON.stringify(session)); } catch (e) {}
    }
  },

  logout: function () {
    SB.store.set("session", null);
    try { sessionStorage.removeItem("sb.session"); } catch (e) {}
  },

  request: function (path, body) {
    return fetch(SB.API_BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.message || data.error || "Request failed.");
          err.code = data.code || String(res.status);
          err.field = data.field || null;
          throw err;
        }
        return data;
      });
    }).catch(function (err) {
      if (err.code) throw err;
      var offline = new Error("Account server isn’t connected yet.");
      offline.code = "offline";
      throw offline;
    });
  },

  register: function (name, email, password) {
    var self = this;
    return this.request("/api/auth/register", {
      name: String(name || "").trim(),
      email: String(email || "").trim().toLowerCase(),
      password: password
    }).then(function (data) {
      self.setSession(data.user || data, true);
      return data.user || data;
    });
  },

  login: function (email, password, remember) {
    var self = this;
    return this.request("/api/auth/login", {
      email: String(email || "").trim().toLowerCase(),
      password: password
    }).then(function (data) {
      self.setSession(data.user || data, remember !== false);
      return data.user || data;
    });
  }
};

SB.paintAuthSlot = function () {
  var slot = SB.$("#authSlot");
  if (!slot) return;
  var user = SB.Auth.current();
  var view = document.body.getAttribute("data-view");

  if (user) {
    slot.innerHTML =
      '<span class="engine-pill is-live auth-user-pill" title="' + SB.escHtml(user.email) + '">' +
        '<span class="dot"></span><span class="pill-text">' + SB.escHtml(user.name) + "</span>" +
      "</span>" +
      '<button type="button" class="chip" id="logoutBtn">Log out</button>';
    var btn = SB.$("#logoutBtn");
    if (btn) {
      btn.addEventListener("click", function () {
        SB.Auth.logout();
        SB.toast("Signed out", "ok");
        if (view === "login" || view === "register") location.href = "login.html";
        else SB.paintAuthSlot();
      });
    }
    return;
  }

  if (view === "login") {
    slot.innerHTML = '<a class="chip" href="register.html">Create account</a>';
  } else if (view === "register") {
    slot.innerHTML = '<a class="chip" href="login.html">Log in</a>';
  } else {
    slot.innerHTML = '<a class="chip" href="login.html">Log in</a>';
  }
};

SB.AuthView = function () {
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function init() {
    var view = document.body.getAttribute("data-view");
    bindToggles();
    if (view === "login") bindLogin();
    if (view === "register") bindRegister();
    maybeWelcomeBack();
  }

  function bindToggles() {
    SB.$$("[data-toggle-pass]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var input = SB.$("#" + btn.getAttribute("data-toggle-pass"));
        if (!input) return;
        var hide = input.type === "password";
        input.type = hide ? "text" : "password";
        btn.textContent = hide ? "🙈" : "👁";
        btn.setAttribute("aria-label", hide ? "Hide password" : "Show password");
      });
    });
  }

  function bindLogin() {
    var form = SB.$("#loginForm");
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      clearErrors(form);
      var email = SB.$("#loginEmail").value;
      var password = SB.$("#loginPassword").value;
      var remember = SB.$("#loginRemember").classList.contains("is-on");
      var ok = true;

      if (!EMAIL_RE.test(String(email).trim())) {
        setError("loginEmail", "Enter a valid email address.");
        ok = false;
      }
      if (!password) {
        setError("loginPassword", "Enter your password.");
        ok = false;
      }
      if (!ok) {
        shake(form);
        return;
      }

      setBusy(form, true);
      SB.Auth.login(email, password, remember).then(function (user) {
        SB.toast("Welcome back, " + (user.name || ""), "ok");
        setTimeout(function () { location.href = "index.html"; }, 450);
      }).catch(function (err) {
        setBusy(form, false);
        shake(form);
        if (err.code === "missing" || err.field === "email") setError("loginEmail", err.message);
        else if (err.code !== "offline") setError("loginPassword", err.message);
        SB.toast(err.message, "error");
      });
    });

    var remember = SB.$("#loginRemember");
    if (remember) {
      remember.classList.add("is-on");
      remember.setAttribute("aria-checked", "true");
      remember.addEventListener("click", function () {
        remember.classList.toggle("is-on");
        remember.setAttribute("aria-checked", remember.classList.contains("is-on") ? "true" : "false");
      });
    }
  }

  function bindRegister() {
    var form = SB.$("#registerForm");
    if (!form) return;

    var pw = SB.$("#regPassword");
    if (pw) pw.addEventListener("input", function () { paintStrength(pw.value); });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      clearErrors(form);
      var name = SB.$("#regName").value;
      var email = SB.$("#regEmail").value;
      var password = SB.$("#regPassword").value;
      var confirm = SB.$("#regConfirm").value;
      var ok = true;

      if (String(name).trim().length < 2) {
        setError("regName", "Name needs at least 2 characters.");
        ok = false;
      }
      if (!EMAIL_RE.test(String(email).trim())) {
        setError("regEmail", "Enter a valid email address.");
        ok = false;
      }
      if (!strongEnough(password)) {
        setError("regPassword", "Use 8+ characters with a letter and a number.");
        ok = false;
      }
      if (password !== confirm) {
        setError("regConfirm", "Passwords don't match.");
        ok = false;
      }
      if (!ok) {
        shake(form);
        return;
      }

      setBusy(form, true);
      SB.Auth.register(name, email, password).then(function (user) {
        SB.toast("Account created — hi, " + (user.name || ""), "ok");
        setTimeout(function () { location.href = "index.html"; }, 450);
      }).catch(function (err) {
        setBusy(form, false);
        shake(form);
        if (err.code !== "offline") setError(err.field === "password" ? "regPassword" : "regEmail", err.message);
        SB.toast(err.message, "error");
      });
    });
  }

  function maybeWelcomeBack() {
    var user = SB.Auth.current();
    var banner = SB.$("#authSignedIn");
    if (!banner) return;
    if (!user) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    var nameEl = SB.$("#authSignedInName", banner);
    if (nameEl) nameEl.textContent = user.name;
  }

  function strongEnough(pw) {
    return String(pw).length >= 8 && /[A-Za-z]/.test(pw) && /\d/.test(pw);
  }

  function paintStrength(pw) {
    var fill = SB.$("#pwFill");
    var hint = SB.$("#pwHint");
    if (!fill) return;
    var score = 0;
    if (pw.length) score = 1;
    if (pw.length >= 8) score = 2;
    if (strongEnough(pw)) score = 3;
    if (strongEnough(pw) && pw.length >= 12) score = 4;
    var pct = [0, 28, 52, 78, 100][score];
    fill.style.width = pct + "%";
    fill.classList.toggle("is-low", score > 0 && score < 3);
    if (hint) {
      hint.textContent = [
        "At least 8 characters, with a letter and a number.",
        "Keep going — add length, a letter, and a number.",
        "Almost — add a letter and a number.",
        "Looks good.",
        "Nice — long and mixed."
      ][score];
    }
  }

  function setError(id, msg) {
    var input = SB.$("#" + id);
    var field = input && input.closest(".field");
    if (input) input.classList.add("is-error");
    if (field) {
      var hint = field.querySelector(".field-msg");
      if (hint) {
        hint.textContent = msg;
        hint.classList.add("is-error");
      }
    }
  }

  function clearErrors(form) {
    SB.$$(".input.is-error", form).forEach(function (el) { el.classList.remove("is-error"); });
    SB.$$(".field-msg", form).forEach(function (el) {
      el.textContent = el.getAttribute("data-default") || "";
      el.classList.remove("is-error");
    });
  }

  function shake(form) {
    var card = form.closest(".card");
    if (!card) return;
    card.classList.remove("anim-shake");
    void card.offsetWidth;
    card.classList.add("anim-shake");
  }

  function setBusy(form, busy) {
    var btn = form.querySelector('button[type="submit"]');
    if (btn) {
      btn.disabled = busy;
      if (busy) btn.setAttribute("data-label", btn.textContent);
      btn.textContent = busy ? "Working…" : (btn.getAttribute("data-label") || btn.textContent);
    }
    SB.$$("input, button", form).forEach(function (el) {
      if (el !== btn) el.disabled = busy;
    });
  }

  return { init: init };
};
