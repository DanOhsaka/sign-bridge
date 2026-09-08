/* ============================================================
   SignBridge — MongoDB connection (singleton)
   One shared client for the whole process. getInstance() always
   returns the same Database; connect() is a no-op if already up.
   ============================================================ */

const mongoose = require("mongoose");

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
    if (!Database._instance) {
      Database._instance = new Database();
    }
    return Database._instance;
  }

  async connect(uri) {
    if (this._conn) return this._conn;
    if (this._connecting) return this._connecting;

    if (!uri) {
      throw new Error("MONGODB_URI is missing.");
    }

    this._connecting = mongoose.connect(uri).then(function (conn) {
      return conn;
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
