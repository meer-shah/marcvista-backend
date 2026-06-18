const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const tradeSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  riskProfile: { type: Schema.Types.ObjectId, ref: 'RiskProfile', required: true },
  activatedAt: { type: Date, required: true },
  tradeNumber: { type: Number, required: true },

  // Which exchange this trade was placed on. Existing rows backfill to
  // 'bybit' so historical metrics remain attributable.
  exchange: {
    type: String,
    enum: ['bybit', 'binance', 'okx', 'bitget', 'mexc'],
    default: 'bybit',
    index: true,
  },
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
  feeMode: { type: String, enum: ['maker', 'taker'], default: null }, // predicted at order time
  feeReserveUsd: { type: Number, default: null }, // fee budget reserved at order time
  // Effective (fee-inclusive) reward:risk locked in at order time — net reward
  // after entry + exit fees over the staked risk, using the predicted fill
  // mode. Stored so the portfolio / breakdown tables read it directly instead
  // of re-deriving it client-side. Scalar, e.g. 1.85 means 1:1.85.
  effectiveRR: { type: Number, default: null },
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

  // True once this trade's Win/Loss has been folded into the per-exchange
  // RiskProfileState. The streak-tick path checks this BEFORE applying — so
  // re-running the closed-PnL sync (e.g. on every page reload) cannot
  // double-count the same trade, regardless of iteration order.
  riskApplied: { type: Boolean, default: false, index: true },

  orderLinkId: { type: String, index: true },
  bybitOrderId: { type: String, default: null },
  bybitClosedPnlId: { type: String, default: null },

  placedAt: { type: Date, default: Date.now },
  closedAt: { type: Date, default: null },
});

tradeSchema.index({ user: 1, riskProfile: 1, placedAt: -1 });
tradeSchema.index({ user: 1, symbol: 1, outcome: 1 });
// Aligns with portfolioService.getMyTrades sort { outcome:1, closedAt:-1, placedAt:-1 }
// so Mongo serves it from the index instead of an in-memory blocking sort.
tradeSchema.index({ user: 1, outcome: 1, closedAt: -1, placedAt: -1 });
tradeSchema.index({ user: 1, source: 1, placedAt: -1 });
tradeSchema.index({ user: 1, exchange: 1, placedAt: -1 });
tradeSchema.index({ user: 1, exchange: 1, outcome: 1 });
tradeSchema.index({ user: 1, tags: 1 });
// Unique only for REAL closed-pnl ids (dedup the sync). A plain `sparse`
// unique index still indexes docs whose field is present-but-null — and
// `bybitClosedPnlId` defaults to null, so every Pending/Cancelled trade would
// collide on the null key (E11000) and fail to persist. A partialFilterExpression
// scoped to string values indexes only closed trades, leaving nulls unconstrained.
tradeSchema.index(
  { bybitClosedPnlId: 1 },
  { unique: true, partialFilterExpression: { bybitClosedPnlId: { $type: 'string' } } }
);

module.exports = mongoose.model('Trade', tradeSchema);
