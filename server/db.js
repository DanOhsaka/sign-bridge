/* ============================================================
   SignBridge — MongoDB connection (singleton)
   One shared client for the whole process. getInstance() always
   returns the same Database; connect() is a no-op if already up.
   Stored on globalThis so Vercel warm invocations reuse it.
   ============================================================ */

const mongoose = require("mongoose");

const GLOBAL_KEY = "__signbridgeDb";

class Database {
  constructor() {
    if (globalThis[GLOBAL_KEY]) {
      return globalThis[GLOBAL_KEY];
    }

    this._conn = null;
    this._connecting = null;
    globalThis[GLOBAL_KEY] = this;
  }

  static getInstance() {
    if (!globalThis[GLOBAL_KEY]) {
      globalThis[GLOBAL_KEY] = new Database();
    }
    return globalThis[GLOBAL_KEY];
  }

  async connect(uri) {
    if (this._conn || mongoose.connection.readyState === 1) {
      this._conn = this._conn || mongoose.connection;
      return this._conn;
    }
    if (this._connecting) return this._connecting;

    if (!uri) {
      throw new Error("MONGODB_URI is missing.");
    }

    this._connecting = mongoose.connect(uri, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 10000
    });

    try {
      this._conn = await this._connecting;
      return this._conn;
    } finally {
      this._connecting = null;
    }
  }

  getConnection() {
    return this._conn;
  }

  isConnected() {
    return mongoose.connection.readyState === 1;
  }

  async disconnect() {
    if (!this._conn && mongoose.connection.readyState === 0) return;
    await mongoose.disconnect();
    this._conn = null;
  }
}

module.exports = Database;
