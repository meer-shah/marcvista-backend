const RiskProfile = require('../models/riskprofilemodal');
const Trade = require('../models/Trade');
const OrderService = require('../services/OrderService');
const TradeQueryService = require('../services/tradeQueryService');
const { computePerformance } = require('../services/performanceService');
const PortfolioService = require('../services/portfolioService');
const { writeAuditLog } = require('../utils/audit');
const logger = require('../utils/logger');

const tradeQueryService = new TradeQueryService();
const portfolioService = new PortfolioService();

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
        logger.error('Error in placeOrder', {
            userId: req.user?._id,
            symbol: req.body?.symbol,
            side: req.body?.side,
            message: error?.message,
            bybitRetCode: error?.bybitRetCode,
            bybitRetMsg: error?.bybitRetMsg,
            stack: error?.stack,
        });
        return res.status(500).json({
            error: 'Failed to place order',
            detail: error?.bybitRetMsg || error?.message || 'Unknown error',
            bybitRetCode: error?.bybitRetCode,
        });
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
        logger.error('Error in setLeverage', {
            userId: req.user?._id,
            symbol: req.body?.symbol,
            message: error?.message,
            bybitRetCode: error?.bybitRetCode,
            bybitRetMsg: error?.bybitRetMsg,
        });
        // Bybit rejection (e.g. leverage out of range, wrong margin mode) → 400 with detail
        const status = error?.bybitRetCode ? 400 : 500;
        res.status(status).json({
            error: 'Failed to set leverage',
            detail: error?.bybitRetMsg || error?.message || 'Unknown error',
            bybitRetCode: error?.bybitRetCode,
        });
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

// ─── Real Performance (via service layer) ────────────────────────────────────

const getRealPerformance = async (req, res) => {
  try {
    const riskProfile = await RiskProfile.findOne({ user: req.user._id, ison: true });
    if (!riskProfile) {
      return res.status(200).json({ summary: null, message: 'No active risk profile' });
    }

    const activatedAt = riskProfile.activatedAt || riskProfile.createdAt;
    const trades = await tradeQueryService.getByActivationWindow(
      req.user._id,
      riskProfile._id,
      activatedAt
    );

    const perf = computePerformance(trades);

    return res.status(200).json({
      summary: {
        winRate: perf.winRate,
        totalProfit: perf.totalProfit,
        totalLoss: perf.totalLoss,
        netProfit: perf.netProfit,
        wins: perf.wins,
        losses: perf.losses,
        finalBalance: perf.finalBalance,
        maxBalance: perf.maxBalance,
        minBalance: perf.minBalance,
        maxDrawdown: perf.maxDrawdown,
      },
      balanceOverTrades: perf.balanceOverTrades,
      tradeDetails: perf.tradeDetails,
    });
  } catch (error) {
    logger.error('Error in getRealPerformance', error);
    return res.status(500).json({ error: 'Failed to fetch real performance' });
  }
};

// ─── My Trades (Trade collection — canonical ledger) ─────────────────────────

const getMyTrades = async (req, res) => {
  try {
    const clearedAt = req.user.tradeHistoryClearedAt || null;
    const trades = await portfolioService.getMyTrades(req.user._id, { clearedAt });

    // Normalize field names so the frontend can use the same patterns as Bybit data
    const normalized = trades.map(t => ({
      ...t,
      closedPnl: t.pnl,          // portfolio page reads closedPnl
      updatedAt: t.closedAt,      // some UI fields read updatedAt
      size: t.qty,
      avgEntryPrice: t.entryPrice,
      avgExitPrice: t.exitPrice,
      riskProfileName: t.riskProfile?.title || null,
      riskProfile: t.riskProfile?._id || t.riskProfile,
    }));

    res.json(normalized);
  } catch (error) {
    logger.error('Error in getMyTrades', error);
    res.status(500).json({ error: 'Failed to fetch trades' });
  }
};

// ─── Clear Trade History ─────────────────────────────────────────────────────

const clearTradeHistory = async (req, res) => {
  try {
    const result = await portfolioService.clearTradeHistory(req.user._id);
    writeAuditLog({ event: 'trades.cleared', userId: req.user._id, metadata: result, req });
    res.status(200).json({
      message: 'Trade history cleared',
      clearedAt: result.clearedAt,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    logger.error('Error in clearTradeHistory', error);
    res.status(500).json({ error: 'Failed to clear trade history' });
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
  getRealPerformance,
  getMyTrades,
  clearTradeHistory,
  // Exported for tests / external use
  placeOrderWithRiskProfile: (userId, data) => orderService.placeOrderWithRiskProfile(userId, data),
};
