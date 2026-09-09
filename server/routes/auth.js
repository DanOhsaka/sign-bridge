const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function tokenFor(user) {
  return jwt.sign(
    { sub: String(user._id), email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
}

function fail(res, status, message, extra) {
  return res.status(status).json(Object.assign({ message: message }, extra || {}));
}

router.post("/register", async function (req, res) {
  try {
    var name = String((req.body && req.body.name) || "").trim();
    var email = String((req.body && req.body.email) || "").trim().toLowerCase();
    var password = String((req.body && req.body.password) || "");

    if (name.length < 2) {
      return fail(res, 400, "Name needs at least 2 characters.", { field: "name", code: "invalid" });
    }
    if (!EMAIL_RE.test(email)) {
      return fail(res, 400, "Enter a valid email address.", { field: "email", code: "invalid" });
    }
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      return fail(res, 400, "Use 8+ characters with a letter and a number.", { field: "password", code: "invalid" });
    }

    var existing = await User.findOne({ email: email });
    if (existing) {
      return fail(res, 409, "An account with that email already exists.", { field: "email", code: "exists" });
    }

    var user = await User.create({
      name: name,
      email: email,
      passwordHash: await bcrypt.hash(password, 12)
    });

    return res.status(201).json({
      user: user.toPublic(),
      token: tokenFor(user)
    });
  } catch (err) {
    if (err && err.code === 11000) {
      return fail(res, 409, "An account with that email already exists.", { field: "email", code: "exists" });
    }
    console.error(err);
    return fail(res, 500, "Could not create the account.");
  }
});

router.post("/login", async function (req, res) {
  try {
    var email = String((req.body && req.body.email) || "").trim().toLowerCase();
    var password = String((req.body && req.body.password) || "");

    if (!EMAIL_RE.test(email) || !password) {
      return fail(res, 400, "Email and password are required.", { code: "invalid" });
    }

    var user = await User.findOne({ email: email });
    if (!user) {
      return fail(res, 401, "No account found for that email.", { field: "email", code: "missing" });
    }

    var ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return fail(res, 401, "Email and password don't match.", { field: "password", code: "bad" });
    }

    return res.json({
      user: user.toPublic(),
      token: tokenFor(user)
    });
  } catch (err) {
    console.error(err);
    return fail(res, 500, "Could not sign in.");
  }
});

module.exports = router;
