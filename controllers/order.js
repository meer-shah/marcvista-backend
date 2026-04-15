const RiskProfile = require('../models/riskprofilemodal');
const OrderService = require('../services/OrderService');
const { writeAuditLog } = require('../utils/audit');
const logger = require('../utils/logger');

const orderService = new OrderService();

// ─── Place order ──────────────────────────────────────────────────────────────

const placeOrder = async (req, res) => {
    try {
        const data = req.body;

        const requiredFields = ["symbol", "side", "category", "qty", "orderType", "price", "takeProfit", "stopLoss"];
        for (const field of requiredFields) {
            if (!data[field]) {
                return res.status(400).json({ error: `Missing ${field}` });
            }
        }

        // Check risk profile for this user
        const riskProfile = await RiskProfile.findOne({ user: req.user._id, ison: true });
        if (!riskProfile) {
            await orderService.simplePlaceOrder(req.user._id, data);
            writeAuditLog({ event: 'order.placed', userId: req.user._id, metadata: { symbol: data.symbol, side: data.side, type: 'simple' }, req });
            return res.status(200).json({ message: "Simple order placed" });
        } else {
            // Require adjustedRisk and lastTradeResult for risk profile orders
            if (typeof data.adjustedRisk !== 'number' || isNaN(data.adjustedRisk)) {
                return res.status(400).json({ error: 'adjustedRisk is required and must be a number' });
            }
            if (!['Win', 'Loss', null].includes(data.lastTradeResult)) {
                return res.status(400).json({ error: 'lastTradeResult must be Win, Loss, or null' });
            }
            await orderService.placeOrderWithRiskProfile(req.user._id, data, riskProfile);
            writeAuditLog({ event: 'order.placed', userId: req.user._id, metadata: { symbol: data.symbol, side: data.side, type: 'risk_profile' }, req });
            return res.status(200).json({ message: "Order placed with risk profile" });
        }
    } catch (error) {
        logger.error('Error in placeOrder', error);
        return res.status(500).json({ error: 'Failed to place order' });
    }
};

// ─── Cancel order ─────────────────────────────────────────────────────────────

const cancelOrder = async (req, res) => {
    try {
        const { orderLinkId, symbol } = req.body;
        if (!symbol) {
            throw new Error('Symbol is required for cancellation');
        }

        const response = await orderService.cancelOrder(req.user._id, symbol, orderLinkId);

        writeAuditLog({ event: 'order.cancelled', userId: req.user._id, metadata: { symbol, orderLinkId }, req });

        res.status(200).json(response);
    } catch (error) {
        logger.error('Error in cancelOrder', error);
        res.status(500).json({ error: 'Failed to cancel order' });
    }
};

// ─── Amend order ──────────────────────────────────────────────────────────────

const ammendOrder = async (req, res) => {
    try {
        const response = await orderService.amendOrder(req.user._id, req.body);
        writeAuditLog({ event: 'order.amended', userId: req.user._id, metadata: { symbol: req.body.symbol }, req });
        res.status(200).json(response);
    } catch (error) {
        logger.error('Error in ammendOrder', error);
        res.status(500).json({ error: "Failed to amend order" });
    }
};

// ─── Show USDT balance ────────────────────────────────────────────────────────

const showusdtbalance = async (req, res) => {
  try {
    const balance = await orderService.getUsdtBalance(req.user._id);
    res.json({ balance });
  } catch (error) {
    logger.error('Error in showusdtbalance', error);
    res.status(500).json({ error: "Failed to get balance" });
  }
};

// ─── Set leverage ─────────────────────────────────────────────────────────────

const setLeverage = async (req, res) => {
    try {
        const { symbol, buyLeverage, sellLeverage } = req.body;
        const response = await orderService.setLeverage(req.user._id, symbol, buyLeverage, sellLeverage);
        res.status(200).json(response);
    } catch (error) {
        logger.error('Error in setLeverage', error);
        res.status(500).json({ error: "Failed to set leverage" });
    }
};

// ─── Switch margin mode ───────────────────────────────────────────────────────

const switchMarginMode = async (req, res) => {
    try {
        const response = await orderService.switchMarginMode(req.user._id, req.body);
        res.status(200).json(response);
    } catch (error) {
        logger.error('Error in switchMarginMode', error);
        res.status(500).json({ error: "Failed to switch margin mode" });
    }
};

// ─── Internal balance helper (used by other modules) ─────────────────────────

const getAccountBalanceFromHere = async (userId, queryParams) => {
  const BybitBroker = require('../services/BybitBroker');
  const broker = new BybitBroker();
  try {
    return await broker.getBalance(userId, queryParams);
  } catch (error) {
    logger.error('Error in getAccountBalanceFromHere', error);
    throw error;
  }
};

module.exports = {
  placeOrder,
  cancelOrder,
  ammendOrder,
  setLeverage,
  switchMarginMode,
  showusdtbalance,
  getAccountBalanceFromHere,
  // Exported for tests / external use
  placeOrderWithRiskProfile: (userId, data) => orderService.placeOrderWithRiskProfile(userId, data),
};
