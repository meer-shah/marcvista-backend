/**
 * RiskProfileState — per-(user, riskProfile, exchange) runtime counters.
 *
 * Separates the MUTABLE state (currentrisk, streak, lastProcessedTradeId,
 * isFirstTrade) from the IMMUTABLE config on RiskProfile (initialRiskPerTrade,
 * increaseOnWin, decreaseOnLoss, minRiskRewardRatio, etc.).
 *
 * Why: a single user can have credentials on multiple exchanges. Trades on
 * Bybit must NOT bleed into the streak / currentrisk used when sizing a
 * Binance order. With state split out per exchange, each venue evolves
 * independently from the same shared rule-set.
 *
 * Migration: existing RiskProfile docs carry these fields too; the migration
 * script copies them into a 'bybit' RiskProfileState on first run. The old
 * fields are NOT deleted from RiskProfile (back-compat reads keep working
 * until controllers are switched over in Phase 2).
 */
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const riskProfileStateSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    riskProfile: { type: Schema.Types.ObjectId, ref: 'RiskProfile', required: true, index: true },
    exchange: {
      type: String,
      enum: ['bybit', 'binance', 'okx', 'bitget', 'mexc'],
      required: true,
      index: true,
    },

    // Mutable streak / risk state — was previously on RiskProfile directly.
    currentrisk: { type: Number, default: 0 },
    previousrisk: { type: Number, default: 0 },
    consecutiveWins: { type: Number, default: 0 },
    consecutiveLosses: { type: Number, default: 0 },
    isFirstTrade: { type: Boolean, default: true },

    // Dedup guard for processNewTradeResult — last trade id whose
    // result has been folded into the streak.
    lastProcessedTradeId: { type: String, default: null },

    // When the user activated this profile on this exchange. Used by the
    // sync to ignore trades from before activation.
    activatedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true }
);

// One state document per (user, riskProfile, exchange).
riskProfileStateSchema.index(
  { user: 1, riskProfile: 1, exchange: 1 },
  { unique: true }
);

module.exports = mongoose.model('RiskProfileState', riskProfileStateSchema);
