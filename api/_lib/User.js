/* MIRROR of server/models/User.js — keep in sync.

   The only change is the export line: serverless runtimes can evaluate this
   module more than once in the same process, and mongoose.model() throws
   OverwriteModelError the second time. Reusing an already-registered model
   avoids that. */

const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    minlength: 2,
    maxlength: 48
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  passwordHash: {
    type: String,
    required: true
  }
}, { timestamps: true });

userSchema.methods.toPublic = function () {
  return { id: String(this._id), name: this.name, email: this.email };
};

module.exports = mongoose.models.User || mongoose.model("User", userSchema);
