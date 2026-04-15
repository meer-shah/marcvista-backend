const { http_request, clearCredentialCache } = require('../config/bybitConfig');
const logger = require('../utils/logger');
const {
  calculateTradeMetrics,
  findBestAndWorstTrade,
  analyzeCoinPerformance,
  getUsdtBalance
} = require('./calculations');

/**
 * Get pending orders (excluding conditional orders)
 */
const getOrderListf = async (req, res) => {
  try {
    const response = await http_request(
      "/v5/order/realtime",
      "GET",
      "category=linear&settleCoin=USDT&accountType=UNIFIED",
      "Get Order List (Realtime)",
      req.user._id
    );
    let orders = response?.result?.list || [];

    // Transform Bybit order fields to match frontend expectations
    orders = orders.map(order => ({
      _id: order.orderId,
      symbol: order.symbol,
      qty: order.qty,
      quantity: order.qty,
      price: order.price,
      stopLoss: order.stopLoss || '',
      takeProfit: order.takeProfit || '',
      side: order.side,
      type: order.orderType,
      status: order.orderStatus,
      createdAt: order.createdTime ? parseInt(order.createdTime) : null,
      createdTime: order.createdTime,
      ...order
    })).filter(order => !order.stopOrderType);

    logger.info('orders fetched', { count: orders.length });
    res.json(orders);
  } catch (error) {
    logger.error('Error in getOrderListf', error);
    res.json([]);
  }
};

/**
 * Get active positions
 */
const getPositionInfof = async (req, res) => {
  try {
    const symbol = req.query?.symbol;
    const query = `category=linear&settleCoin=USDT${symbol ? `&symbol=${symbol}` : ''}`;
    const response = await http_request(
      "/v5/position/list",
      "GET",
      query,
      "Get Position Info",
      req.user._id
    );
    let positions = response?.result?.list || [];

    // Transform positions to match frontend expectations
    positions = positions.map(pos => ({
      symbol: pos.symbol,
      size: pos.size,
      positionValue: pos.positionValue,
      avgEntryPrice: pos.avgPrice,
      marketPrice: pos.markPrice,
      unrealisedPnL: pos.unrealisedPnl,
      takeProfit: pos.takeProfit || '',
      stopLoss: pos.stopLoss || '',
      side: pos.side,
      ...pos
    }));

    res.json(positions);
  } catch (error) {
    logger.error('Error in getPositionInfof', error);
    res.json([]);
  }
};

// Whitelist of valid Bybit account types to prevent query string injection
const VALID_ACCOUNT_TYPES = ['UNIFIED', 'CONTRACT', 'SPOT'];

const sanitizeAccountType = (raw) => {
  const value = typeof raw === 'string' ? raw.toUpperCase() : 'UNIFIED';
  return VALID_ACCOUNT_TYPES.includes(value) ? value : 'UNIFIED';
};

/**
 * Get account balance (wallet balance)
 */
const getAccountBalance = async (req, res) => {
  try {
    const accountType = sanitizeAccountType(req.query?.accountType);
    const response = await http_request(
      "/v5/account/wallet-balance",
      "GET",
      `accountType=${accountType}`,
      "Get Account Balance",
      req.user._id
    );
    res.json(response);
  } catch (error) {
    logger.error('Error in getAccountBalance', error);
    res.status(500).json({ error: "Failed to get account balance" });
  }
};

/**
 * Get balance of all coins
 */
const getCoinBalance = async (req, res) => {
  try {
    const accountType = sanitizeAccountType(req.query?.accountType);
    const response = await http_request(
      "/v5/asset/transfer/query-account-coins-balance",
      "GET",
      `accountType=${accountType}`,
      "Get Coin Balance",
      req.user._id
    );
    res.json(response);
  } catch (error) {
    logger.error('Error in getCoinBalance', error);
    res.status(500).json({ error: "Failed to get coin balance" });
  }
};

/**
 * Get balance of a specific coin
 */
const getSingleCoinBalance = async (req, res) => {
  try {
    const { symbol } = req.params;
    const data = `accountType=UNIFIED&coin=${symbol}`;
    const response = await http_request(
      "/v5/asset/transfer/query-account-coins-balance",
      "GET",
      data,
      `Get ${symbol} Balance`,
      req.user._id
    );
    res.json(response);
  } catch (error) {
    logger.error('Error in getSingleCoinBalance', error);
    res.status(500).json({ error: "Failed to get coin balance" });
  }
};

/**
 * Get transaction log
 */
const gettransactionlog = async (req, res) => {
  try {
    const response = await http_request(
      "/v5/account/transaction-log",
      "GET",
      "category=linear&accountType=UNIFIED&baseCoin=USDT",
      "Get Transaction Log",
      req.user._id
    );
    res.json(response);
  } catch (error) {
    logger.error('Error in gettransactionlog', error);
    res.status(500).json({ error: "Failed to get transaction log" });
  }
};

/**
 * Get closed PnL (trade history)
 */
const getClosedPnlf = async (req, res) => {
  try {
    const response = await http_request(
      "/v5/position/closed-pnl",
      "GET",
      "category=linear",
      "Get Closed PnL",
      req.user._id
    );

    let trades = response?.result?.list || [];

    // Transform trades to match frontend expectations
    // side is reversed because Bybit returns the closing order's side;
    // we display the original (opening) order's side instead.
    // NOTE: side override must come AFTER ...trade so the spread doesn't overwrite it.
    trades = trades.map(trade => ({
      symbol: trade.symbol,
      size: trade.qty,
      quantity: trade.qty,
      entryPrice: trade.avgEntryPrice,
      exitPrice: trade.avgExitPrice,
      pnl: trade.closedPnl,
      profit: trade.closedPnl,
      closedAt: trade.updatedTime || trade.closedAt,
      updatedAt: trade.updatedTime,
      ...trade,
      side: trade.side === 'Buy' ? 'Sell' : 'Buy',
    }));

    const metrics = calculateTradeMetrics(trades);
    const { bestTrade, worstTrade } = findBestAndWorstTrade(trades);
    const { bestCoins, worstCoins } = analyzeCoinPerformance(trades);

    // Respond immediately — don't block on risk sync
    res.json({
      trades,
      metrics,
      bestTrade,
      worstTrade,
      bestCoins,
      worstCoins
    });

    // Sync risk profile counters in background after response is sent.
    // Bybit returns trades newest-first. We reverse to process oldest-first so streak
    // counters and the reset point fire in the correct sequence.
    // ONLY trades after the profile's activatedAt timestamp are counted.
    if (trades.length > 0) {
      setImmediate(async () => {
        try {
          const RiskProfileService = require('../services/RiskProfileService');
          const riskProfileService = new RiskProfileService();
          const RiskProfile = require('../models/riskprofilemodal');

          const activeProfile = await RiskProfile.findOne({ user: req.user._id, ison: true });
          if (!activeProfile) return;

          const activatedAt = (activeProfile.activatedAt ? new Date(activeProfile.activatedAt).getTime() : 0) - 5000;
          const tradesChronological = [...trades].reverse();

          const tradesAfterActivation = tradesChronological.filter(t => {
            const closedTime = Number(t.updatedTime || t.updatedAt || t.closedAt || 0);
            return closedTime >= activatedAt;
          });

          const lastProcessedIdx = activeProfile.lastProcessedTradeId
            ? tradesAfterActivation.findIndex(t => {
                const id = t.orderId || t.execId || t.closedAt || t.updatedAt;
                return String(id) === activeProfile.lastProcessedTradeId;
              })
            : -1;

          const unprocessedTrades = tradesAfterActivation.slice(lastProcessedIdx + 1);

          for (const trade of unprocessedTrades) {
            const pnl = parseFloat(trade.closedPnl);
            if (isNaN(pnl)) {
              logger.warn('Skipping trade sync: invalid PnL', { tradeId: trade.orderId || trade.execId });
              continue;
            }
            const result = pnl > 0 ? 'Win' : 'Loss';
            const tradeId = trade.orderId || trade.execId || trade.closedAt || trade.updatedAt;
            if (!tradeId) {
              logger.warn('Skipping trade sync: no valid tradeId');
              continue;
            }
            logger.info('Background syncing trade result', { tradeId, result });
            await riskProfileService.processNewTradeResult(req.user._id, result, String(tradeId));
          }
        } catch (syncError) {
          logger.error('Background risk sync error:', syncError);
        }
      });
    }
  } catch (error) {
    logger.error('Error in getClosedPnlf', error);
    res.json({
      trades: [],
      metrics: {
        totalTrades: 0,
        avgTradeOutput: 0,
        avgWinningTrade: 0,
        avgLosingTrade: 0,
        winRate: 0
      },
      bestTrade: { closedPnl: 0 },
      worstTrade: { closedPnl: 0 },
      bestCoins: [],
      worstCoins: []
    });
  }
};

/**
 * Show USDT balance (endpoint wrapper for frontend)
 */
const showusdtbalance = async (req, res) => {
  try {
    const response = await http_request(
      "/v5/account/wallet-balance",
      "GET",
      "accountType=UNIFIED",
      "Get Balance",
      req.user._id
    );
    const balance = getUsdtBalance(response);
    res.json({ balance });
  } catch (error) {
    logger.error('Error in showusdtbalance', error);
    res.status(500).json({ error: "Failed to get balance" });
  }
};

/**
 * Get portfolio summary with all metrics, volume per coin, and long/short distribution
 */
const getPortfolioSummary = async (req, res) => {
  try {
    // 1. Get balance
    const balanceRes = await http_request(
      "/v5/account/wallet-balance",
      "GET",
      "accountType=UNIFIED",
      "Get Balance for Portfolio",
      req.user._id
    );
    const usdtBalance = getUsdtBalance(balanceRes);

    // 2. Get positions
    const positionsRes = await http_request(
      "/v5/position/list",
      "GET",
      "category=linear&settleCoin=USDT",
      "Get Positions for Portfolio",
      req.user._id
    );
    const positions = positionsRes?.result?.list || [];

    // 3. Get closed PnL for trade metrics
    const pnlRes = await http_request(
      "/v5/position/closed-pnl",
      "GET",
      "category=linear",
      "Get Closed PnL for Portfolio",
      req.user._id
    );
    const trades = pnlRes?.result?.list || [];

    // Transform trades
    // side is reversed because Bybit returns the closing order's side;
    // we display the original (opening) order's side instead.
    // NOTE: side override must come AFTER ...trade so the spread doesn't overwrite it.
    const transformedTrades = trades.map(trade => ({
      symbol: trade.symbol,
      size: trade.qty,
      quantity: trade.qty,
      entryPrice: trade.avgEntryPrice,
      exitPrice: trade.avgExitPrice,
      pnl: trade.closedPnl,
      profit: trade.closedPnl,
      closedAt: trade.updatedTime || trade.closedAt,
      updatedAt: trade.updatedTime,
      ...trade,
      side: trade.side === 'Buy' ? 'Sell' : 'Buy',
    }));

    const metrics = calculateTradeMetrics(transformedTrades);
    const { bestTrade, worstTrade } = findBestAndWorstTrade(transformedTrades);

    // Compute totalRealizedPnl from closed trades
    const totalRealizedPnl = transformedTrades.reduce((sum, t) => sum + parseFloat(t.closedPnl || 0), 0);

    // Compute totalUnrealizedPnl from open positions
    const totalUnrealizedPnl = positions.reduce((sum, p) => sum + parseFloat(p.unrealisedPnl || p.unrealizedPnl || 0), 0);

    // 4. Trading volume per coin (from closed trades)
    const volumeMap = {};
    transformedTrades.forEach(t => {
      const symbol = t.symbol;
      const vol = parseFloat(t.cumExecValue || t.size || 0);
      volumeMap[symbol] = (volumeMap[symbol] || 0) + vol;
    });
    const totalVolume = Object.values(volumeMap).reduce((s, v) => s + v, 0);
    const tradingVolumePerCoin = Object.entries(volumeMap).map(([symbol, volume]) => ({
      symbol,
      volume,
      percentage: totalVolume > 0 ? (volume / totalVolume) * 100 : 0
    })).sort((a, b) => b.volume - a.volume);

    // 5. Calculate long/short distribution
    const longValue = positions.filter(p => p.side === 'Buy').reduce((s, p) => s + parseFloat(p.positionValue || 0), 0);
    const shortValue = positions.filter(p => p.side === 'Sell').reduce((s, p) => s + parseFloat(p.positionValue || 0), 0);
    const totalPos = longValue + shortValue;
    const longShortData = [
      { name: 'Long', value: totalPos > 0 ? (longValue / totalPos) * 100 : 0, fill: '#22c55e' },
      { name: 'Short', value: totalPos > 0 ? (shortValue / totalPos) * 100 : 0, fill: '#ef4444' }
    ];

    // 6. Monthly profit from closed trades
    const monthlyMap = {};
    transformedTrades.forEach(t => {
      const ts = Number(t.updatedAt || t.closedAt);
      if (!ts) return;
      const d = new Date(ts);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthlyMap[key] = (monthlyMap[key] || 0) + parseFloat(t.closedPnl || 0);
    });
    const monthlyProfit = Object.entries(monthlyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, profit]) => ({ month, profit }));

    // 7. Get best/worst coins
    const { bestCoins, worstCoins } = analyzeCoinPerformance(transformedTrades);

    res.json({
      // top-level fields matching frontend PortfolioSummary interface
      balance: usdtBalance,
      totalRealizedPnl,
      totalUnrealizedPnl,
      winRate: metrics.winRate,
      totalTrades: metrics.totalTrades,
      avgTradeProfit: metrics.avgTradeOutput,
      bestTrade: bestTrade && bestTrade.symbol ? { symbol: bestTrade.symbol, pnl: parseFloat(bestTrade.closedPnl || 0) } : null,
      worstTrade: worstTrade && worstTrade.symbol ? { symbol: worstTrade.symbol, pnl: parseFloat(worstTrade.closedPnl || 0) } : null,
      bestCoins: bestCoins.map(c => ({ symbol: c.symbol, pnl: c.totalPnL })),
      worstCoins: worstCoins.map(c => ({ symbol: c.symbol, pnl: c.totalPnL })),
      tradingVolumePerCoin,
      monthlyProfit,
      longShortData,
      // also include raw data for any other consumers
      positions,
      trades: transformedTrades,
    });
  } catch (error) {
    logger.error('Error in getPortfolioSummary', error);
    res.status(500).json({ error: "Failed to get portfolio summary" });
  }
};

/**
 * Get account balance (used internally by order controller)
 * This is the same as getAccountBalance but without res.json wrapper
 */
const getAccountBalanceFromHere = async (req, dataParam) => {
  try {
    const data = dataParam || "accountType=UNIFIED";
    const response = await http_request(
      "/v5/account/wallet-balance",
      "GET",
      data,
      "Get Account Balance",
      req.user._id
    );
    return response;
  } catch (error) {
    logger.error('Error in getAccountBalanceFromHere', error);
    throw error;
  }
};

module.exports = {
  getOrderListf,
  getPositionInfof,
  getAccountBalance,
  getCoinBalance,
  getSingleCoinBalance,
  gettransactionlog,
  getClosedPnlf,
  showusdtbalance,
  getPortfolioSummary,
  getAccountBalanceFromHere
};
