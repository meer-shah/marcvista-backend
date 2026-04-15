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
const { getUsdtBalance } = require('../controllers/calculations');
const logger = require('../utils/logger');

// Default broker — BybitBroker singleton used by the controller.
// Tests can inject a different broker via the constructor.
const BybitBroker = require('./BybitBroker');
const defaultBroker = new BybitBroker();

class OrderService {
  constructor(broker = defaultBroker) {
    this.broker = broker;
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
  async simplePlaceOrder(userId, data) {
    try {
      const orderLinkId = crypto.randomBytes(16).toString('hex');
      
      const formatEnum = (str) => str ? str.charAt(0).toUpperCase() + str.slice(1).toLowerCase() : undefined;
      
      const formattedData = {
        ...data,
        orderLinkId,
        side: formatEnum(data.side),
        orderType: formatEnum(data.orderType),
      };
      
      const result = await this.broker.placeOrder(userId, formattedData);
      if (result.retCode !== 0) {
        throw new Error(`Bybit API error: ${result.retMsg} (retCode: ${result.retCode})`);
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
  async placeOrderWithRiskProfile(userId, data, riskProfile = null) {
    try {
      // 1. Use passed-in risk profile if available (avoids duplicate DB read from controller)
      if (!riskProfile) {
        riskProfile = await RiskProfile.findOne({ user: userId, ison: true });
      }
      if (!riskProfile) this._throwError('No active risk profile found.');

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

      // 4 & 5. Fetch USDT balance and ticker precision in parallel (independent calls)
      const [accountBalanceResponse, tickerInfo] = await Promise.all([
        this.broker.getBalance(userId, 'accountType=UNIFIED'),
        this.broker.getTicker(data.symbol),
      ]);
      const usdtBalance = getUsdtBalance(accountBalanceResponse);
      if (usdtBalance <= 0) this._throwError('Insufficient USDT balance.');
      if (!tickerInfo) this._throwError(`Ticker information not found for symbol ${data.symbol}`);
      const bid1Size = parseFloat(tickerInfo.bid1Size);
      if (isNaN(bid1Size)) this._throwError(`Invalid bid1Size for symbol ${data.symbol}: ${bid1Size}`);
      const precision = (bid1Size.toString().split('.')[1] || '').length;

      // 6. Update risk profile state using centralized service logic
      // This handles streak tracking, reset logic, and double-counting prevention (via lastTradeId)
      const RiskProfileService = require('./RiskProfileService');
      const riskProfileService = new RiskProfileService();
      
      if (data.lastTradeResult && data.lastTradeId && !riskProfile.isFirstTrade) {
        logger.info('Processing last trade result before placement', { lastTradeResult: data.lastTradeResult, lastTradeId: data.lastTradeId });
        await riskProfileService.processNewTradeResult(userId, data.lastTradeResult, data.lastTradeId);
        
        // Re-fetch the risk profile to get updated values for position sizing
        const updatedProfile = await RiskProfile.findOne({ user: userId, ison: true });
        if (updatedProfile) {
          logger.info('Risk profile updated after results processing', { 
            currentRisk: updatedProfile.currentrisk, 
            losses: updatedProfile.consecutiveLosses,
            isFirstTrade: updatedProfile.isFirstTrade
          });
          riskProfile = updatedProfile;
          // Important: We use the UPDATED risk profile values for the quantity calculation
          data.adjustedRisk = riskProfile.currentrisk;
        }
      }

      // Mark first trade as consumed — subsequent orders will use compounding logic
      if (riskProfile.isFirstTrade) {
        riskProfile.isFirstTrade = false;
        await riskProfile.save();
        // Use the initial risk for position sizing on first trade
        data.adjustedRisk = riskProfile.currentrisk;
      }

      // 7. Calculate position size using final adjustedRisk
      const orderPrice = parseFloat(price);
      const stopLossPrice = parseFloat(stopLoss);
      const riskPerUnit = Math.abs(orderPrice - stopLossPrice);
      if (riskPerUnit <= 0) this._throwError('Stop loss must differ from entry price');
      
      const riskAmount = (data.adjustedRisk / 100) * usdtBalance;
      const newQty = (riskAmount / riskPerUnit).toFixed(precision);
      if (parseFloat(newQty) <= 0) this._throwError('Calculated order quantity is zero or negative');

      // 8. Prepare clean order data for Bybit
      const formatEnum = (str) => str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
      
      const bybitOrder = {
        symbol: data.symbol,
        side: data.side ? formatEnum(data.side) : undefined,
        category: data.category,
        qty: newQty.toString(),
        orderType: data.orderType ? formatEnum(data.orderType) : undefined,
        price: data.price.toString(),
        stopLoss: data.stopLoss.toString(),
        takeProfit: data.takeProfit.toString(),
        timeInForce: 'GTC',
        positionIdx: 0,
      };
      return await this.simplePlaceOrder(userId, bybitOrder);

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
  async cancelOrder(userId, symbol, orderLinkId) {
    const data = {
      category: 'linear',
      symbol,
      orderLinkId,
    };

    const response = await this.broker.cancelOrder(userId, data);

    if (response.retCode !== 0) {
      throw new Error(`Bybit cancel error: ${response.retMsg} (retCode: ${response.retCode})`);
    }

    // If no trades have been executed yet (first order was placed but not filled),
    // reset isFirstTrade so the next order placement still uses the initial risk.
    const riskProfile = await RiskProfile.findOne({ user: userId, ison: true });
    if (riskProfile && riskProfile.consecutiveWins === 0 && riskProfile.consecutiveLosses === 0) {
      riskProfile.isFirstTrade = true;
      await riskProfile.save();
    }

    return response;
  }

  /**
   * Amend an existing open order.
   */
  async amendOrder(userId, data) {
    return this.broker.amendOrder(userId, data);
  }

  /**
   * Set leverage for a symbol.
   */
  async setLeverage(userId, symbol, buyLeverage, sellLeverage) {
    const response = await this.broker.setLeverage(userId, {
      category: 'linear',
      symbol,
      buyLeverage: buyLeverage.toString(),
      sellLeverage: sellLeverage.toString(),
    });

    if (response.retCode !== 0) {
      logger.error('Bybit setLeverage error', { symbol, buyLeverage, sellLeverage, response });
      throw new Error(`Bybit API error: ${response.retMsg} (retCode: ${response.retCode})`);
    }

    return response;
  }

  /**
   * Switch margin mode.
   */
  async switchMarginMode(userId, data) {
    return this.broker.switchMarginMode(userId, data);
  }

  /**
   * Get USDT balance.
   */
  async getUsdtBalance(userId) {
    const response = await this.broker.getBalance(userId, 'accountType=UNIFIED');
    return getUsdtBalance(response);
  }
}

module.exports = OrderService;
