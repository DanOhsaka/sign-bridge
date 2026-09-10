/* ============================================================
   SignBridge — MongoDB connection (singleton)

   MIRROR of server/db.js — keep in sync.

   Differences from server/db.js, both deliberate and both required
   by the serverless runtime:
     - The singleton is cached on globalThis, so it survives module
       re-evaluation. A class-static alone can end up duplicated if a
       bundler inlines this module twice, which would open two pools.
     - mongoose.connect() is given explicit options, so a bad
       connection fails in 5s instead of the 30s default. Vercel
       functions are billed and time-limited; hanging is worse than
       failing.
   ============================================================ */

const mongoose = require("mongoose");

const CACHE_KEY = "__signbridge_db__";

class Database {
  constructor() {
    if (Database._instance) {
      return Database._instance;
    }

    this._conn = null;
    this._connecting = null;
    Database._instance = this;
  }

  static getInstance() {
    if (Database._instance) {
      return Database._instance;
    }
    if (globalThis[CACHE_KEY]) {
      Database._instance = globalThis[CACHE_KEY];
      return Database._instance;
    }

    Database._instance = new Database();
    globalThis[CACHE_KEY] = Database._instance;
    return Database._instance;
  }

  async connect(uri) {
    if (this._conn) return this._conn;
    if (this._connecting) return this._connecting;

    if (!uri) {
      throw new Error("MONGODB_URI is missing.");
    }

    this._connecting = mongoose
      .connect(uri, {
        serverSelectionTimeoutMS: 5000,
        maxPoolSize: 5,
        bufferCommands: false
      })
      .then(function (conn) {
        return conn;
      })
      .catch(function (err) {
        // Clear the in-flight promise so the next request retries instead of
        // inheriting a permanently rejected one.
        Database.getInstance()._connecting = null;
        throw err;
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
    if (!this._conn) return;
    await mongoose.disconnect();
    this._conn = null;
  }
}

module.exports = Database;
