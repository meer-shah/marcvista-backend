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
 * Get closed PnL (trade history) — also syncs trades to our DB in the background.
 *
 * Sync strategy (idempotent, runs after response is sent):
 *   1. Match by orderLinkId if Bybit returns it (app trade — exact match).
 *   2. Fall back to symbol+timing heuristic for app trades placed before this feature.
 *   3. No match → create an 'external' Trade record (placed directly on Bybit).
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

    // Honour user-initiated trade history clear: hide any trade closed at/before the cutoff.
    const clearedAtMs = req.user.tradeHistoryClearedAt
      ? new Date(req.user.tradeHistoryClearedAt).getTime()
      : 0;
    if (clearedAtMs > 0) {
      trades = trades.filter(t => {
        const closedTs = Number(t.updatedTime || t.closedAt || 0);
        return closedTs > clearedAtMs;
      });
    }

    // side is reversed: Bybit returns the closing side; we display the opening side.
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

    res.json({ trades, metrics, bestTrade, worstTrade, bestCoins, worstCoins });

    if (trades.length > 0) {
      setImmediate(async () => {
        try {
          const RiskProfileService = require('../services/RiskProfileService');
          const riskProfileService = new RiskProfileService();
          const RiskProfile = require('../models/riskprofilemodal');
          const Trade = require('../models/Trade');

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

          // Count existing trades once for tradeNumber assignment
          let externalTradeOffset = await Trade.countDocuments({
            user: req.user._id,
            riskProfile: activeProfile._id,
            placedAt: { $gte: activeProfile.activatedAt || activeProfile.createdAt },
          });

          const tradeBulkOps = [];

          // ── Batch pre-fetch to avoid N+1 queries ──
          const candidateIds = unprocessedTrades.map(t =>
            String(t.orderId || t.execId || `${t.symbol}-${t.updatedTime}`)
          );
          const candidateOrderLinkIds = unprocessedTrades
            .map(t => t.orderLinkId)
            .filter(Boolean);

          const [existingDocs, pendingByLinkDocs, pendingBySymbolDocs] = await Promise.all([
            Trade.find({ bybitClosedPnlId: { $in: candidateIds } })
              .select('bybitClosedPnlId')
              .lean(),
            candidateOrderLinkIds.length
              ? Trade.find({
                  user: req.user._id,
                  orderLinkId: { $in: candidateOrderLinkIds },
                  outcome: 'Pending',
                }).lean()
              : Promise.resolve([]),
            Trade.find({
              user: req.user._id,
              riskProfile: activeProfile._id,
              outcome: 'Pending',
            }).sort({ placedAt: 1 }).lean(),
          ]);

          const existingSet = new Set(existingDocs.map(d => d.bybitClosedPnlId));
          const pendingByLinkMap = new Map(
            pendingByLinkDocs.map(d => [d.orderLinkId, d])
          );
          // Group pending-by-symbol, preserving ascending placedAt order
          const pendingBySymbolMap = new Map();
          for (const d of pendingBySymbolDocs) {
            if (!pendingBySymbolMap.has(d.symbol)) pendingBySymbolMap.set(d.symbol, []);
            pendingBySymbolMap.get(d.symbol).push(d);
          }
          // Track which pending trades have been consumed by this sync pass
          const consumedPendingIds = new Set();

          for (const trade of unprocessedTrades) {
            const closedPnlId = String(trade.orderId || trade.execId || `${trade.symbol}-${trade.updatedTime}`);

            // Dedup: already synced
            if (existingSet.has(closedPnlId)) continue;

            const pnl = parseFloat(trade.closedPnl);
            if (isNaN(pnl)) {
              logger.warn('Skipping trade sync: invalid PnL', { tradeId: closedPnlId });
              continue;
            }

            const outcome = pnl > 0 ? 'Win' : 'Loss';
            const exitPrice = parseFloat(trade.avgExitPrice) || null;
            const closedTime = new Date(Number(trade.updatedTime || trade.updatedAt || trade.closedAt || Date.now()));

            // ── Step 1: match by orderLinkId (present in newer Bybit responses) ──
            let pendingTrade = null;
            if (trade.orderLinkId) {
              const byLink = pendingByLinkMap.get(trade.orderLinkId);
              if (byLink && !consumedPendingIds.has(String(byLink._id))) {
                pendingTrade = byLink;
              }
            }

            // ── Step 2: fallback to symbol + timing heuristic ──
            if (!pendingTrade) {
              const symbolBucket = pendingBySymbolMap.get(trade.symbol) || [];
              pendingTrade = symbolBucket.find(d =>
                !consumedPendingIds.has(String(d._id)) &&
                new Date(d.placedAt).getTime() <= closedTime.getTime()
              ) || null;
            }

            if (pendingTrade) {
              consumedPendingIds.add(String(pendingTrade._id));
            }

            if (pendingTrade) {
              // App trade found — update it
              const balanceAfter = (pendingTrade.balanceBefore || 0) + pnl;
              const duration = pendingTrade.placedAt
                ? closedTime.getTime() - new Date(pendingTrade.placedAt).getTime()
                : null;

              tradeBulkOps.push({
                updateOne: {
                  filter: { _id: pendingTrade._id },
                  update: {
                    $set: {
                      outcome,
                      pnl,
                      exitPrice,
                      closedAt: closedTime,
                      balanceAfter,
                      bybitClosedPnlId: closedPnlId,
                      fees: parseFloat(trade.cumExecFee || 0) || null,
                      duration,
                    },
                  },
                },
              });
            } else {
              // ── Step 3: no match → external trade ──
              externalTradeOffset++;
              const reversedSide = trade.side === 'Buy' ? 'Sell' : 'Buy';

              tradeBulkOps.push({
                insertOne: {
                  document: {
                    user: req.user._id,
                    riskProfile: activeProfile._id,
                    activatedAt: activeProfile.activatedAt || activeProfile.createdAt,
                    tradeNumber: externalTradeOffset,
                    symbol: trade.symbol,
                    side: reversedSide,
                    category: 'linear',
                    orderType: 'Market',
                    source: 'external',
                    entryPrice: parseFloat(trade.avgEntryPrice) || 0,
                    exitPrice,
                    qty: parseFloat(trade.qty) || 0,
                    pnl,
                    outcome,
                    bybitClosedPnlId: closedPnlId,
                    bybitOrderId: trade.orderId || null,
                    closedAt: closedTime,
                    placedAt: closedTime, // opening time unknown for external trades
                    fees: parseFloat(trade.cumExecFee || 0) || null,
                  },
                },
              });
            }
          }

          if (tradeBulkOps.length > 0) {
            try {
              await Trade.bulkWrite(tradeBulkOps, { ordered: false });
            } catch (e) {
              logger.error('Trade bulkWrite failed', e);
            }
          }

          // Update risk profile streak counters for unprocessed trades
          for (const trade of unprocessedTrades) {
            const pnl = parseFloat(trade.closedPnl);
            if (isNaN(pnl)) continue;
            const result = pnl > 0 ? 'Win' : 'Loss';
            const tradeId = trade.orderId || trade.execId || trade.closedAt || trade.updatedAt;
            if (!tradeId) continue;
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
      metrics: { totalTrades: 0, avgTradeOutput: 0, avgWinningTrade: 0, avgLosingTrade: 0, winRate: 0 },
      bestTrade: { closedPnl: 0 },
      worstTrade: { closedPnl: 0 },
      bestCoins: [],
      worstCoins: []
    });
  }
};

/**
 * Show USDT balance
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
 * Portfolio summary — live balance + positions from Bybit; historical metrics from Trade collection.
 */
const getPortfolioSummary = async (req, res) => {
  try {
    const PortfolioService = require('../services/portfolioService');
    const portfolioService = new PortfolioService();

    // Live data from Bybit
    const [balanceRes, positionsRes] = await Promise.all([
      http_request("/v5/account/wallet-balance", "GET", "accountType=UNIFIED", "Get Balance for Portfolio", req.user._id),
      http_request("/v5/position/list", "GET", "category=linear&settleCoin=USDT", "Get Positions for Portfolio", req.user._id),
    ]);

    const usdtBalance = getUsdtBalance(balanceRes);
    const positions = positionsRes?.result?.list || [];

    const totalUnrealizedPnl = positions.reduce(
      (sum, p) => sum + parseFloat(p.unrealisedPnl || p.unrealizedPnl || 0), 0
    );

    // Long/short distribution from open positions
    const longValue = positions.filter(p => p.side === 'Buy').reduce((s, p) => s + parseFloat(p.positionValue || 0), 0);
    const shortValue = positions.filter(p => p.side === 'Sell').reduce((s, p) => s + parseFloat(p.positionValue || 0), 0);
    const totalPos = longValue + shortValue;
    const longShortData = [
      { name: 'Long', value: totalPos > 0 ? (longValue / totalPos) * 100 : 0, fill: '#22c55e' },
      { name: 'Short', value: totalPos > 0 ? (shortValue / totalPos) * 100 : 0, fill: '#ef4444' },
    ];

    // Historical metrics from Trade collection (our canonical ledger).
    // Honour include/exclude external trades + clearedAt cutoff.
    const includeExternal = String(req.query.includeExternal ?? 'true') !== 'false';
    const clearedAt = req.user.tradeHistoryClearedAt || null;
    const historicalSummary = await portfolioService.getSummary(req.user._id, { clearedAt, includeExternal });

    res.json({
      balance: usdtBalance,
      totalRealizedPnl: historicalSummary.totalRealizedPnl,
      totalUnrealizedPnl,
      winRate: historicalSummary.winRate,
      totalTrades: historicalSummary.totalTrades,
      avgTradeProfit: historicalSummary.avgTradeProfit,
      bestTrade: historicalSummary.bestTrade,
      worstTrade: historicalSummary.worstTrade,
      bestCoins: historicalSummary.bestCoins,
      worstCoins: historicalSummary.worstCoins,
      tradingVolumePerCoin: historicalSummary.tradingVolumePerCoin,
      monthlyProfit: historicalSummary.monthlyProfit,
      longShortData,
      positions,
    });
  } catch (error) {
    logger.error('Error in getPortfolioSummary', error);
    res.status(500).json({ error: "Failed to get portfolio summary" });
  }
};

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
