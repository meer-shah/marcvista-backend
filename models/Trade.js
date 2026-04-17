const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const tradeSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  riskProfile: { type: Schema.Types.ObjectId, ref: 'RiskProfile', required: true },
  activatedAt: { type: Date, required: true },
  tradeNumber: { type: Number, required: true },

  symbol: { type: String, required: true },
  side: { type: String, enum: ['Buy', 'Sell'], required: true },
  category: { type: String, default: 'linear' },
  orderType: { type: String, default: 'Limit' },
  source: { type: String, enum: ['app', 'external'], default: 'app', index: true },

  entryPrice: { type: Number, required: true },
  exitPrice: { type: Number, default: null },
  stopLoss: { type: Number, default: null },
  takeProfit: { type: Number, default: null },
  qty: { type: Number, required: true },
  leverage: { type: Number, default: null },

  riskPercent: { type: Number, default: null },
  riskAmount: { type: Number, default: null },
  balanceBefore: { type: Number, default: null },
  balanceAfter: { type: Number, default: null },

  pnl: { type: Number, default: 0 },
  payout: { type: Number, default: 0 },
  fees: { type: Number, default: null },
  duration: { type: Number, default: null }, // milliseconds between place and close
  outcome: {
    type: String,
    enum: ['Pending', 'Win', 'Loss', 'Cancelled'],
    default: 'Pending',
    index: true,
  },

  tags: { type: [String], default: [] },
  notes: { type: String, default: null },
  metadata: { type: Schema.Types.Mixed, default: null },

  orderLinkId: { type: String, index: true },
  bybitOrderId: { type: String, default: null },
  bybitClosedPnlId: { type: String, default: null },

  placedAt: { type: Date, default: Date.now },
  closedAt: { type: Date, default: null },
});

tradeSchema.index({ user: 1, riskProfile: 1, placedAt: -1 });
tradeSchema.index({ user: 1, symbol: 1, outcome: 1 });
tradeSchema.index({ user: 1, source: 1, placedAt: -1 });
tradeSchema.index({ user: 1, tags: 1 });
tradeSchema.index({ bybitClosedPnlId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Trade', tradeSchema);
