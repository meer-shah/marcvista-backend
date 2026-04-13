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
  async placeOrderWithRiskProfile(userId, data) {
    try {
      // 1. Fetch active risk profile for this user
      const riskProfile = await RiskProfile.findOne({ user: userId, ison: true });
      if (!riskProfile) this._throwError('No active risk profile found.');

      // 2. Validate adjustedRisk and lastTradeResult
      if (typeof data.adjustedRisk !== 'number' || isNaN(data.adjustedRisk)) {
        this._throwError(`Invalid adjustedRisk: ${data.adjustedRisk} (type: ${typeof data.adjustedRisk})`);
      }
      if (!['Win', 'Loss', null].includes(data.lastTradeResult)) {
        this._throwError(`Invalid lastTradeResult: ${data.lastTradeResult}`);
      }

      // 3. Validate R:R
      const { takeProfit, stopLoss, price } = data;
      if (!takeProfit || !stopLoss || !price) {
        this._throwError('Missing takeProfit, stopLoss, or price');
      }
      const riskRewardRatio = (takeProfit - price) / (price - stopLoss);
      const minRiskRewardRatio = riskProfile.minRiskRewardRatio || 1;
      if (riskRewardRatio < minRiskRewardRatio) {
        this._throwError(`Risk-to-reward ratio ${riskRewardRatio.toFixed(2)} is less than minimum required ${minRiskRewardRatio}`);
      }

      // 4. Fetch USDT balance
      const accountBalanceResponse = await this.broker.getBalance(userId, 'accountType=UNIFIED');
      const usdtBalance = getUsdtBalance(accountBalanceResponse);
      if (usdtBalance <= 0) this._throwError('Insufficient USDT balance.');

      // 5. Get ticker precision
      const tickerInfo = await this.broker.getTicker(data.symbol);
      if (!tickerInfo) this._throwError(`Ticker information not found for symbol ${data.symbol}`);
      const bid1Size = parseFloat(tickerInfo.bid1Size);
      if (isNaN(bid1Size)) this._throwError(`Invalid bid1Size for symbol ${data.symbol}: ${bid1Size}`);
      const precision = (bid1Size.toString().split('.')[1] || '').length;

      // 6. Calculate position size
      const orderPrice = parseFloat(price);
      const stopLossPrice = parseFloat(stopLoss);
      const riskPerUnit = Math.abs(orderPrice - stopLossPrice);
      if (riskPerUnit <= 0) this._throwError('Stop loss must differ from entry price');
      const riskAmount = (data.adjustedRisk / 100) * usdtBalance;
      const newQty = (riskAmount / riskPerUnit).toFixed(precision);
      if (parseFloat(newQty) <= 0) this._throwError('Calculated order quantity is zero or negative');

      // 7. Update risk profile state
      const originalCurrentRisk = riskProfile.currentrisk || 0;
      const reset = riskProfile.reset || 10000;
      if ((riskProfile.consecutiveWins || 0) >= reset || (riskProfile.consecutiveLosses || 0) >= reset) {
        riskProfile.consecutiveWins = 0;
        riskProfile.consecutiveLosses = 0;
      }
      const isFirstTrade = (riskProfile.consecutiveWins === 0 && riskProfile.consecutiveLosses === 0);

      riskProfile.previousrisk = originalCurrentRisk;
      riskProfile.currentrisk = data.adjustedRisk;

      if (!isFirstTrade && data.lastTradeResult) {
        if (data.lastTradeResult === 'Win') {
          riskProfile.consecutiveWins = (riskProfile.consecutiveWins || 0) + 1;
          riskProfile.consecutiveLosses = 0;
        } else if (data.lastTradeResult === 'Loss') {
          riskProfile.consecutiveLosses = (riskProfile.consecutiveLosses || 0) + 1;
          riskProfile.consecutiveWins = 0;
        }
      }
      await riskProfile.save();

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
   * Cancel an order and roll back risk profile state.
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

    // Roll back risk profile for this user
    const riskProfile = await RiskProfile.findOne({ user: userId, ison: true });
    if (riskProfile) {
      riskProfile.currentrisk = riskProfile.previousrisk;
      if (riskProfile.consecutiveWins > 0) riskProfile.consecutiveWins--;
      if (riskProfile.consecutiveLosses > 0) riskProfile.consecutiveLosses--;
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
