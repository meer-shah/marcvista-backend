/**
 * OrderService — business logic for order placement, cancellation, and related ops.
 *
 * All exchange calls are delegated to the injected broker (IBroker contract).
 * No Express req/res objects here — pure business logic, fully testable.
 *
 * IMPORTANT: This is a structural refactor of controllers/order.js.
 * All logic is preserved exactly as-is — no functional changes.
 */
const crypto = require('crypto');
const RiskProfile = require('../models/riskprofilemodal');
const User = require('../models/User');
const Trade = require('../models/Trade');
const { getUsdtBalance } = require('../controllers/calculations');
const { classifyFillType, computeFeeAwareQty, effectiveRR, feeRatesFor, TAKER_FEE } = require('../utils/feeMath');
const { getBroker, getBrokerContext } = require('./brokers');
const logger = require('../utils/logger');

// Legacy default broker sentinel — distinguishes "no broker injected, use
// factory" from "test passed in a mock broker, use that".
const LegacyBybitBroker = require('./BybitBroker');
const DEFAULT_BROKER = new LegacyBybitBroker();

class OrderService {
  /**
   * @param {object} [broker] — optional override (mainly for unit tests).
   *   When provided, every method uses this broker instead of the factory.
   */
  constructor(broker = DEFAULT_BROKER) {
    this.broker = broker;
    this._brokerInjected = broker !== DEFAULT_BROKER;
  }

  /**
   * Resolve which exchange to act on for this user.
   * Tolerant of bad user IDs / missing user docs — falls back to 'bybit'.
   */
  async _resolveExchange(userId, explicit) {
    if (explicit) return explicit;
    try {
      const user = await User.findById(userId).select('activeExchange').lean();
      return user?.activeExchange || 'bybit';
    } catch {
      return 'bybit';
    }
  }

  /**
   * Return { broker, ctx, exchange }.
   * If a mock broker was injected via the constructor, returns that with a
   * legacy-shaped ctx (userId only). Otherwise looks up the user's active
   * exchange and returns the corresponding broker from the factory.
   */
  async _getBroker(userId, exchange) {
    const ex = await this._resolveExchange(userId, exchange);
    if (this._brokerInjected) {
      // Test mode — caller injected a mock broker. Skip the credential
      // lookup (which would require a real DB) and synthesize a ctx.
      return { broker: this.broker, ctx: { userId, mode: 'demo' }, exchange: ex, legacy: true };
    }
    const broker = getBroker(ex);
    const ctx = await getBrokerContext(userId, ex);
    return { broker, ctx, exchange: ex, legacy: false };
  }

  // ─── Internal helpers ────────────────────────────────────────────────────────

  _throwError(message) {
    logger.warn(message);
    throw new Error(message);
  }

  // ─── Public methods ──────────────────────────────────────────────────────────

  /**
   * Place a simple order on the exchange (no risk profile logic).
   */
  async simplePlaceOrder(userId, data, exchange = null) {
    try {
      const orderLinkId = data.orderLinkId || crypto.randomBytes(16).toString('hex');
      const formatEnum = (str) => str ? str.charAt(0).toUpperCase() + str.slice(1).toLowerCase() : undefined;
      const { broker, ctx } = await this._getBroker(userId, exchange);

      const request = {
        symbol: data.symbol,
        side: formatEnum(data.side),
        category: data.category || 'linear',
        qty: String(data.qty),
        orderType: formatEnum(data.orderType),
        price: data.price,
        stopLoss: data.stopLoss,
        takeProfit: data.takeProfit,
        timeInForce: data.timeInForce || 'GTC',
        orderLinkId,
      };

      const result = await broker.placeOrder(ctx, request);
      if (result.retCode !== 0) {
        throw new Error(`Exchange API error: ${result.retMsg} (retCode: ${result.retCode})`);
      }
      return result;
    } catch (error) {
      logger.error('simplePlaceOrder failed', error);
      this._throwError(`Failed to place order: ${error.message}`);
    }
  }

  /**
   * Place an order with active risk profile calculations applied.
   * Validates R:R, calculates position size from USDT balance, updates risk state.
   */
  async placeOrderWithRiskProfile(userId, data, riskProfile = null, exchange = null) {
    try {
      // 0. Resolve exchange + broker + per-exchange runtime state
      const { broker, ctx, exchange: ex } = await this._getBroker(userId, exchange);
      const RiskProfileService = require('./RiskProfileService');
      const riskProfileService = new RiskProfileService();

      // 1. Use passed-in risk profile if available (avoids duplicate DB read from controller)
      if (!riskProfile) {
        riskProfile = await RiskProfile.findOne({ user: userId, ison: true });
      }
      if (!riskProfile) this._throwError('No active risk profile found.');

      // 1b. Get the per-exchange runtime state (currentrisk / streak / isFirstTrade).
      const { state } = await riskProfileService.getOrCreateState(userId, ex);
      if (!state) this._throwError('Could not initialize risk profile state for exchange.');

      // 2. Validate adjustedRisk and lastTradeResult
      if (typeof data.adjustedRisk !== 'number' || isNaN(data.adjustedRisk)) {
        this._throwError(`Invalid adjustedRisk: ${data.adjustedRisk} (type: ${typeof data.adjustedRisk})`);
      }
      if (!['Win', 'Loss', null].includes(data.lastTradeResult)) {
        this._throwError(`Invalid lastTradeResult: ${data.lastTradeResult}`);
      }

      // 3. Validate R:R (use absolute values so it works for both Long and Short)
      const { takeProfit, stopLoss, price } = data;
      if (!takeProfit || !stopLoss || !price) {
        this._throwError('Missing takeProfit, stopLoss, or price');
      }
      const reward = Math.abs(parseFloat(takeProfit) - parseFloat(price));
      const risk   = Math.abs(parseFloat(price) - parseFloat(stopLoss));
      const riskRewardRatio = risk > 0 ? reward / risk : 0;
      const minRiskRewardRatio = riskProfile.minRiskRewardRatio || 1;
      if (riskRewardRatio < minRiskRewardRatio) {
        this._throwError(`Risk-to-reward ratio ${riskRewardRatio.toFixed(2)} is less than minimum required ${minRiskRewardRatio}`);
      }

      // 4 & 5. Fetch USDT balance + ticker + qty step via the broker (exchange-agnostic).
      const [usdtBalance, tickerInfo, instrument] = await Promise.all([
        broker.getUsdtBalance(ctx),
        broker.getTicker(ctx, data.symbol),
        broker.getInstrumentInfo(ctx, data.symbol),
      ]);
      if (usdtBalance <= 0) this._throwError('Insufficient USDT balance.');
      if (!tickerInfo) this._throwError(`Ticker information not found for symbol ${data.symbol}`);
      if (!instrument) this._throwError(`Instrument info not found for symbol ${data.symbol}`);

      // Derive qty precision from the exchange's qtyStep (e.g. "0.001" → 3).
      const qtyStepStr = String(instrument.qtyStep || '1');
      const precision = (qtyStepStr.split('.')[1] || '').length;

      // 6. Update PER-EXCHANGE risk profile state for the user's last trade result.
      if (data.lastTradeResult && data.lastTradeId && !state.isFirstTrade) {
        logger.info('Processing last trade result before placement', { lastTradeResult: data.lastTradeResult, lastTradeId: data.lastTradeId, exchange: ex });
        await riskProfileService.processNewTradeResultForExchange(userId, ex, data.lastTradeResult, data.lastTradeId);
        const refreshed = await riskProfileService.getOrCreateState(userId, ex);
        if (refreshed?.state) {
          state.currentrisk = refreshed.state.currentrisk;
          state.consecutiveLosses = refreshed.state.consecutiveLosses;
          state.consecutiveWins = refreshed.state.consecutiveWins;
          state.isFirstTrade = refreshed.state.isFirstTrade;
          data.adjustedRisk = refreshed.state.currentrisk;
        }
      }

      // Mark first trade as consumed on this exchange — subsequent orders compound.
      if (state.isFirstTrade) {
        state.isFirstTrade = false;
        await state.save();
        // Mirror to the legacy RiskProfile field so the FRONTEND's adjusted-
        // risk formula (which still reads RiskProfile.isFirstTrade) flips
        // away from the initialRiskPerTrade fallback.
        if (riskProfile.isFirstTrade) {
          riskProfile.isFirstTrade = false;
          await riskProfile.save();
        }
        data.adjustedRisk = state.currentrisk || riskProfile.initialRiskPerTrade;
      }

      // 7. Calculate FEE-INCLUSIVE position size.
      // Total loss at SL (price-move loss + entry fee + SL exit fee) will equal
      // the stated risk amount exactly. Fee mode is predicted from side+entry+live:
      // a Limit that crosses the spread fills Taker, one priced passively fills Maker.
      const orderPrice = parseFloat(price);
      const stopLossPrice = parseFloat(stopLoss);
      const takeProfitPrice = parseFloat(takeProfit);
      const riskPerUnit = Math.abs(orderPrice - stopLossPrice);
      if (riskPerUnit <= 0) this._throwError('Stop loss must differ from entry price');

      const riskAmount = (data.adjustedRisk / 100) * usdtBalance;

      const livePrice = parseFloat(tickerInfo.lastPrice);
      const normalizedSide = data.side
        ? data.side.charAt(0).toUpperCase() + data.side.slice(1).toLowerCase()
        : 'Buy';
      const feeMode = classifyFillType(normalizedSide, orderPrice, livePrice);
      const exchangeFees = feeRatesFor(ex);
      const feeEntry = feeMode === 'maker' ? exchangeFees.maker : exchangeFees.taker;
      const feeExit = exchangeFees.taker; // TP/SL exits trigger as market

      const qtyRaw = computeFeeAwareQty({
        riskUsd: riskAmount,
        entry: orderPrice,
        stopLoss: stopLossPrice,
        feeEntry,
        feeExit,
      });
      const newQty = qtyRaw.toFixed(precision);
      if (parseFloat(newQty) <= 0) this._throwError('Calculated order quantity is zero or negative');

      // 7b. Enforce minimum R:R *after fees*. Since total_loss == riskAmount
      // by construction, the effective R:R is netGain / riskAmount.
      const effRR = effectiveRR({
        riskUsd: riskAmount,
        qty: parseFloat(newQty),
        entry: orderPrice,
        takeProfit: takeProfitPrice,
        feeEntry,
        feeExit,
      });
      if (effRR < minRiskRewardRatio) {
        this._throwError(
          `Effective R:R after fees ${effRR.toFixed(2)} is below the profile minimum ${minRiskRewardRatio}. Widen TP or tighten SL.`
        );
      }

      // Reserved fee budget — useful for the Trade record and debugging.
      const qtyNum = parseFloat(newQty);
      const feeReserveUsd = qtyNum * orderPrice * feeEntry + qtyNum * stopLossPrice * feeExit;

      // 8. Build an exchange-agnostic OrderRequest (broker translates to native).
      const formatEnum = (str) => str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
      const orderLinkId = crypto.randomBytes(16).toString('hex');
      const request = {
        symbol: data.symbol,
        side: data.side ? formatEnum(data.side) : undefined,
        category: data.category || 'linear',
        qty: newQty.toString(),
        orderType: data.orderType ? formatEnum(data.orderType) : 'Limit',
        price: data.price,
        stopLoss: data.stopLoss,
        takeProfit: data.takeProfit,
        timeInForce: 'GTC',
        orderLinkId,
      };
      const result = await broker.placeOrder(ctx, request);
      if (result.retCode !== 0) {
        throw new Error(`Exchange API error: ${result.retMsg} (retCode: ${result.retCode})`);
      }

      // 9. Persist Trade record SYNCHRONOUSLY — must complete before we return,
      // otherwise a race or silent error leaves no Pending row in our DB and
      // the closed-pnl sync labels the eventual SL/TP fill as "external".
      try {
        const tradeNumber = await Trade.countDocuments({
          user: userId,
          riskProfile: riskProfile._id,
          placedAt: { $gte: riskProfile.activatedAt || riskProfile.createdAt },
        }) + 1;

        await Trade.create({
          user: userId,
          riskProfile: riskProfile._id,
          activatedAt: riskProfile.activatedAt || riskProfile.createdAt,
          tradeNumber,
          exchange: ex,
          symbol: data.symbol,
          side: formatEnum(data.side),
          category: data.category || 'linear',
          orderType: data.orderType ? formatEnum(data.orderType) : 'Limit',
          entryPrice: orderPrice,
          stopLoss: stopLossPrice,
          takeProfit: parseFloat(takeProfit),
          qty: parseFloat(newQty),
          riskPercent: data.adjustedRisk,
          riskAmount,
          balanceBefore: usdtBalance,
          feeMode,
          feeReserveUsd,
          orderLinkId,
          bybitOrderId: result?.result?.orderId || null,
          outcome: 'Pending',
          placedAt: new Date(),
        });
      } catch (err) {
        // The order is already live on Bybit. Log loudly so we can investigate;
        // do NOT throw — we don't want the user to see a failure for an order
        // that actually went through. But this means the sync may label it
        // external if the SL/TP closes it.
        logger.error('Failed to persist Trade record (order is LIVE on Bybit but no Pending row in our DB)', {
          userId,
          symbol: data.symbol,
          orderLinkId,
          bybitOrderId: result?.result?.orderId,
          message: err?.message,
          stack: err?.stack,
        });
      }

      return result;

    } catch (error) {
      logger.error('placeOrderWithRiskProfile error', error);
      this._throwError(`Error in placeOrderWithRiskProfile: ${error.message}`);
    }
  }

  /**
   * Cancel an order.
   * Cancelling a pending order means NO trade was executed, so risk state must NOT change.
   * Exception: if this was the very first order (no wins/losses yet), reset isFirstTrade = true
   * so the user gets fresh-start behaviour on their next order attempt.
   */
  async cancelOrder(userId, symbol, orderLinkId, exchange = null) {
    const { broker, ctx, exchange: ex } = await this._getBroker(userId, exchange);
    const response = await broker.cancelOrder(ctx, { symbol, orderLinkId });

    if (response.retCode !== 0) {
      throw new Error(`Exchange cancel error: ${response.retMsg} (retCode: ${response.retCode})`);
    }

    // If no trades have been executed yet ON THIS EXCHANGE (first order was placed
    // but not filled), reset isFirstTrade so the next order placement uses initial risk.
    const RiskProfileService = require('./RiskProfileService');
    const riskProfileService = new RiskProfileService();
    const { state } = await riskProfileService.getOrCreateState(userId, ex);
    if (state && state.consecutiveWins === 0 && state.consecutiveLosses === 0) {
      state.isFirstTrade = true;
      await state.save();
    }

    setImmediate(async () => {
      try {
        await Trade.updateOne(
          { user: userId, orderLinkId, outcome: 'Pending' },
          { $set: { outcome: 'Cancelled', closedAt: new Date() } }
        );
      } catch (err) {
        logger.error('Failed to mark Trade as Cancelled', err);
      }
    });

    return response;
  }

  /**
   * Amend an existing open order on the user's active exchange.
   */
  async amendOrder(userId, data, exchange = null) {
    const { broker, ctx } = await this._getBroker(userId, exchange);
    return broker.amendOrder(ctx, data);
  }

  /**
   * Set leverage for a symbol on the user's active exchange.
   */
  async setLeverage(userId, symbol, buyLeverage, sellLeverage, exchange = null) {
    const { broker, ctx } = await this._getBroker(userId, exchange);
    const response = await broker.setLeverage(ctx, {
      symbol,
      buyLeverage,
      sellLeverage,
    });

    // 110043 = "leverage not modified" — requested leverage already in effect.
    if (response.retCode === 110043) {
      return { ...response, retCode: 0, retMsg: 'Leverage already set' };
    }
    if (response.retCode !== 0) {
      logger.error('Exchange setLeverage error', { symbol, buyLeverage, sellLeverage, response });
      const err = new Error(`Exchange API error: ${response.retMsg} (retCode: ${response.retCode})`);
      err.bybitRetCode = response.retCode;
      err.bybitRetMsg = response.retMsg;
      throw err;
    }
    return response;
  }

  /**
   * Switch margin mode on the user's active exchange.
   */
  async switchMarginMode(userId, data, exchange = null) {
    const { broker, ctx } = await this._getBroker(userId, exchange);
    return broker.switchMarginMode(ctx, data);
  }

  /**
   * Get USDT balance from the user's active exchange.
   */
  async getUsdtBalance(userId, exchange = null) {
    const { broker, ctx } = await this._getBroker(userId, exchange);
    return broker.getUsdtBalance(ctx);
  }
}

module.exports = OrderService;
