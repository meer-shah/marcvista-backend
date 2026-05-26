const mongoose = require('mongoose');
const { encrypt } = require('../config/encryption');

const ApiConnectionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      // unique enforced via compound (user, exchange) index below — a user can
      // have one credential row per exchange.
    },
    // Which exchange these credentials are for. Existing rows backfill to
    // 'bybit' so old single-exchange users are not disrupted.
    exchange: {
      type: String,
      enum: ['bybit', 'binance', 'okx', 'bitget', 'mexc'],
      default: 'bybit',
      required: true,
      index: true,
    },
    apiKey: {
      type: String,
      required: true,
      trim: true,
    },
    secretKey: {
      type: String,
      required: true,
      trim: true,
    },
    // Some exchanges (OKX, Bitget) require an additional passphrase alongside
    // the API key / secret. Optional — Bybit/Binance/MEXC ignore it.
    passphrase: {
      type: String,
      default: null,
      trim: true,
    },
    // 'demo' = exchange's testnet / paper-trading environment.
    // 'real' = production / live trading.
    // Backwards-compat note: the old 'accountType' enum used 'live' for
    // production. We keep 'real' here for clarity and the migration script
    // translates 'live' → 'real'.
    mode: {
      type: String,
      enum: ['demo', 'real'],
      default: 'demo',
      index: true,
    },
    // Deprecated — kept for back-compat reads only; new code reads `mode`.
    accountType: {
      type: String,
      enum: ['demo', 'live'],
      default: 'demo',
    },
  },
  { timestamps: true }
);

// One credential row per (user, exchange) — replaces the old single-row-per-user
// unique constraint, which prevented multi-exchange.
ApiConnectionSchema.index({ user: 1, exchange: 1 }, { unique: true });

// Encrypt API keys before persisting to the database
ApiConnectionSchema.pre('save', function (next) {
  if (this.isModified('apiKey')) {
    this.apiKey = encrypt(this.apiKey);
  }
  if (this.isModified('secretKey')) {
    this.secretKey = encrypt(this.secretKey);
  }
  if (this.isModified('passphrase') && this.passphrase) {
    this.passphrase = encrypt(this.passphrase);
  }
  next();
});

module.exports = mongoose.model('ApiConnection', ApiConnectionSchema);
