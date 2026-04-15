const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const goalSchema = new Schema({
  goalType: {
    type: String,
    enum: ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Yearly'],
    required: true,
  },
  goalAmount: {
    type: Number,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now, // ✅ use "createdAt" instead of "setAt"
  }
}, { _id: true }); // allow goal to be individually deletable via goal._id

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

  goals: {
    type: [goalSchema],
    default: [],
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
  ison: {
    type: Boolean,
    default: false,
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
//  - getActive: { user, ison: true }
//  - resetDefault / deleteRiskProfile: { user, default: true }
riskProfileSchema.index({ user: 1 });
riskProfileSchema.index({ user: 1, ison: 1 });
riskProfileSchema.index({ user: 1, default: 1 });

module.exports = mongoose.model('RiskProfile', riskProfileSchema);
