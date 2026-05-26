/**
 * Pure helpers for fee-inclusive position sizing.
 *
 * Bybit USDT linear perpetuals (VIP-0): Maker 0.02%, Taker 0.055%.
 * TP/SL exits trigger as conditional market orders → always Taker.
 *
 * Position-sizing principle: the *total* loss if SL hits — including the
 * entry and exit fees — must equal the stated risk in USD. Solving for qty:
 *
 *   total_loss = qty × |entry − SL| + qty × entry × feeEntry + qty × SL × feeExit
 *              = qty × (distance + entry × feeEntry + SL × feeExit)
 *
 *   qty = riskUSD / (distance + entry × feeEntry + SL × feeExit)
 */

const MAKER_FEE = 0.0002;
const TAKER_FEE = 0.00055;
const FILL_TYPE_TOLERANCE_PCT = 0.0002; // 0.02% — treat entry within this of live as Taker

/**
 * Per-exchange Maker/Taker rates at VIP-0 for USDT linear perpetuals.
 * Source of truth: the broker class's static `feeRates()`. This table is a
 * fallback when the broker can't be loaded (e.g. in pure unit tests).
 */
const EXCHANGE_FEES = {
  bybit:   { maker: 0.0002, taker: 0.00055 },
  binance: { maker: 0.0002, taker: 0.0005 },
  okx:     { maker: 0.0002, taker: 0.0005 },
  bitget:  { maker: 0.0002, taker: 0.0006 },
  mexc:    { maker: 0.0,    taker: 0.0001 },
};

/**
 * Resolve fee rates for an exchange. Prefers the broker class (single source
 * of truth); falls back to the table above if the broker can't be required
 * (mostly for tests).
 */
function feeRatesFor(exchange) {
  try {
    const { CLASSES } = require('../services/brokers');
    if (CLASSES && CLASSES[exchange]) return CLASSES[exchange].feeRates();
  } catch { /* swallow */ }
  return EXCHANGE_FEES[exchange] || EXCHANGE_FEES.bybit;
}

/**
 * Predict whether a Limit order will fill as Maker or Taker.
 * A Limit that crosses the live spread fills Taker; one that rests passively fills Maker.
 * Defaults to Taker when livePrice is unavailable or input is invalid (safer for sizing).
 *
 * @param {'Buy'|'Sell'} side
 * @param {number} orderPrice
 * @param {number} livePrice
 * @returns {'maker'|'taker'}
 */
function classifyFillType(side, orderPrice, livePrice) {
  if (!Number.isFinite(orderPrice) || !Number.isFinite(livePrice) || livePrice <= 0) {
    return 'taker';
  }
  const tol = livePrice * FILL_TYPE_TOLERANCE_PCT;
  if (side === 'Buy') {
    return orderPrice < livePrice - tol ? 'maker' : 'taker';
  }
  if (side === 'Sell') {
    return orderPrice > livePrice + tol ? 'maker' : 'taker';
  }
  return 'taker';
}

/**
 * Compute fee-inclusive position size such that the total loss at SL
 * (price-move loss + entry fee + SL exit fee) equals `riskUsd` exactly.
 *
 * @param {object} args
 * @param {number} args.riskUsd      - USD amount the user is willing to lose, fees inclusive
 * @param {number} args.entry        - entry price
 * @param {number} args.stopLoss     - stop-loss price
 * @param {number} args.feeEntry     - entry fee rate (e.g. 0.0002 maker, 0.00055 taker)
 * @param {number} [args.feeExit]    - exit fee rate, defaults to TAKER_FEE (0.00055)
 * @returns {number} qty (un-rounded; caller is responsible for precision/truncation)
 */
function computeFeeAwareQty({ riskUsd, entry, stopLoss, feeEntry, feeExit = TAKER_FEE }) {
  if (!Number.isFinite(riskUsd) || riskUsd <= 0) return 0;
  if (!Number.isFinite(entry) || !Number.isFinite(stopLoss)) return 0;
  const distance = Math.abs(entry - stopLoss);
  if (distance <= 0) return 0;
  const denom = distance + entry * feeEntry + stopLoss * feeExit;
  return denom > 0 ? riskUsd / denom : 0;
}

/**
 * Effective R:R after fees, given the fee-aware qty (so total loss == riskUsd by construction).
 *
 * @returns {number} R:R as a scalar (e.g. 1.85 means 1:1.85)
 */
function effectiveRR({ riskUsd, qty, entry, takeProfit, feeEntry, feeExit = TAKER_FEE }) {
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  if (!Number.isFinite(takeProfit) || takeProfit <= 0) return 0;
  const grossReward = Math.abs(takeProfit - entry) * qty;
  const entryFee = qty * entry * feeEntry;
  const tpExitFee = qty * takeProfit * feeExit;
  const netReward = grossReward - entryFee - tpExitFee;
  return riskUsd > 0 ? netReward / riskUsd : 0;
}

module.exports = {
  MAKER_FEE,
  TAKER_FEE,
  FILL_TYPE_TOLERANCE_PCT,
  EXCHANGE_FEES,
  feeRatesFor,
  classifyFillType,
  computeFeeAwareQty,
  effectiveRR,
};
