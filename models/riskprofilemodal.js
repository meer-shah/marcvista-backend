const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const riskProfileSchema = new Schema({
  title: { type: String, required: true },
  description: { type: String },
  previousrisk: { type: Number, default: 0 },
  currentrisk: { type: Number, default: 0 },
  consecutiveWins: { type: Number, default: 0 },
  consecutiveLosses: { type: Number, default: 0 },

  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

  SLallowedperday: { type: Number },
  initialRiskPerTrade: { type: Number, required: true },
  increaseOnWin: { type: Number },
  decreaseOnLoss: { type: Number },
  maxRisk: { type: Number },
  minRisk: { type: Number },
  reset: { type: Number },
  growthThreshold: { type: Number },
  payoutPercentage: { type: Number },
  noofactivetrades: { type: Number },
  minRiskRewardRatio: { type: Number },

  createdAt: {
    type: Date,
    default: Date.now,
  },
  default: {
    type: Boolean,
    default: false,
  },
  lastProcessedTradeId: {
    type: String, // Bybit trade/order ID
    default: null,
  },
  isFirstTrade: {
    type: Boolean,
    default: true, // True when profile is first activated; set to false after first order is placed
  },
  activatedAt: {
    type: Date,
    default: null, // Timestamp of last activation — only trades after this are counted
  }
});

// Indexes for hot query paths:
//  - all queries filter by user
//  - resetDefault / deleteRiskProfile / fallback active lookup: { user, default: true }
// Active-profile-per-exchange is resolved via User.activeRiskProfileByExchange
// then a primary-key lookup, so no `ison` index is needed.
riskProfileSchema.index({ user: 1 });
riskProfileSchema.index({ user: 1, default: 1 });

module.exports = mongoose.model('RiskProfile', riskProfileSchema);
