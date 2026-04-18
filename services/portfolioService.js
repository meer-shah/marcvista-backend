/**
 * portfolioService — portfolio-level aggregations from the Trade collection.
 *
 * Live balance and open positions always come from Bybit (accurate snapshot).
 * All historical metrics (win rate, PnL curves, per-coin stats) come from here.
 */
const Trade = require('../models/Trade');

// Short-lived in-memory cache for portfolio summaries. TTL is intentionally
// small — trade history changes on every new close, and the cache exists only
// to collapse duplicate requests within the same polling tick.
const SUMMARY_CACHE_TTL_MS = 15 * 1000;
const SUMMARY_CACHE_MAX_ENTRIES = 500;
const summaryCache = new Map(); // key -> { value, expiresAt }

function summaryCacheSet(key, value) {
  if (summaryCache.has(key)) summaryCache.delete(key);
  summaryCache.set(key, value);
  if (summaryCache.size > SUMMARY_CACHE_MAX_ENTRIES) {
    const oldest = summaryCache.keys().next().value;
    if (oldest !== undefined) summaryCache.delete(oldest);
  }
}

function invalidateSummaryCache(userId) {
  for (const key of summaryCache.keys()) {
    if (key.startsWith(`${userId}:`)) summaryCache.delete(key);
  }
}

class PortfolioService {
  /**
   * Return historical portfolio metrics for a user.
   * Options:
   *   - clearedAt: Date — exclude trades closed at/before this timestamp
   *   - includeExternal: boolean (default true) — include trades placed outside the app
   */
  async getSummary(userId, options = {}) {
    const { clearedAt = null, includeExternal = true } = options;

    const cacheKey = `${userId}:${clearedAt ? new Date(clearedAt).getTime() : 0}:${includeExternal ? 1 : 0}`;
    const now = Date.now();
    const cached = summaryCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const query = {
      user: userId,
      outcome: { $in: ['Win', 'Loss'] },
    };
    if (clearedAt) {
      query.closedAt = { $gt: new Date(clearedAt) };
    }
    if (!includeExternal) {
      query.source = 'app';
    }

    const trades = await Trade.find(query).sort({ closedAt: 1, placedAt: 1 }).lean();

    if (!trades.length) {
      const empty = {
        totalRealizedPnl: 0,
        winRate: 0,
        totalTrades: 0,
        avgTradeProfit: 0,
        bestTrade: null,
        worstTrade: null,
        bestCoins: [],
        worstCoins: [],
        tradingVolumePerCoin: [],
        monthlyProfit: [],
      };
      summaryCacheSet(cacheKey, { value: empty, expiresAt: now + SUMMARY_CACHE_TTL_MS });
      return empty;
    }

    let wins = 0;
    let totalPnl = 0;
    let bestTrade = null;
    let worstTrade = null;
    const coinPnlMap = {};
    const coinVolumeMap = {};
    const monthlyMap = {};

    for (const t of trades) {
      const pnl = t.pnl || 0;
      totalPnl += pnl;
      if (pnl > 0) wins++;

      if (!bestTrade || pnl > bestTrade.pnl) bestTrade = { symbol: t.symbol, pnl };
      if (!worstTrade || pnl < worstTrade.pnl) worstTrade = { symbol: t.symbol, pnl };

      coinPnlMap[t.symbol] = (coinPnlMap[t.symbol] || 0) + pnl;

      const volume = (t.qty || 0) * (t.entryPrice || 0);
      coinVolumeMap[t.symbol] = (coinVolumeMap[t.symbol] || 0) + volume;

      const ts = t.closedAt || t.placedAt;
      if (ts) {
        const d = new Date(ts);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        monthlyMap[key] = (monthlyMap[key] || 0) + pnl;
      }
    }

    const coinPnlList = Object.entries(coinPnlMap).map(([symbol, pnl]) => ({ symbol, pnl }));
    const totalVolume = Object.values(coinVolumeMap).reduce((s, v) => s + v, 0);

    const tradingVolumePerCoin = Object.entries(coinVolumeMap)
      .map(([symbol, volume]) => ({
        symbol,
        volume,
        percentage: totalVolume > 0 ? (volume / totalVolume) * 100 : 0,
      }))
      .sort((a, b) => b.volume - a.volume);

    const monthlyProfit = Object.entries(monthlyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, profit]) => ({ month, profit }));

    const result = {
      totalRealizedPnl: totalPnl,
      winRate: (wins / trades.length) * 100,
      totalTrades: trades.length,
      avgTradeProfit: totalPnl / trades.length,
      bestTrade,
      worstTrade,
      bestCoins: [...coinPnlList].sort((a, b) => b.pnl - a.pnl).filter(c => c.pnl > 0).slice(0, 5),
      worstCoins: [...coinPnlList].sort((a, b) => a.pnl - b.pnl).filter(c => c.pnl < 0).slice(0, 5),
      tradingVolumePerCoin,
      monthlyProfit,
    };
    summaryCacheSet(cacheKey, { value: result, expiresAt: now + SUMMARY_CACHE_TTL_MS });
    return result;
  }

  /**
   * Return closed trades from our DB for portfolio calculations.
   * Respects user.tradeHistoryClearedAt so cleared trades stay hidden even if re-synced.
   */
  async getMyTrades(userId, options = {}) {
    const { clearedAt = null } = options;
    const query = {
      user: userId,
      outcome: { $in: ['Win', 'Loss'] },
    };
    if (clearedAt) {
      query.closedAt = { $gt: new Date(clearedAt) };
    }
    return Trade.find(query)
      .sort({ closedAt: -1, placedAt: -1 })
      .populate('riskProfile', 'title')
      .lean();
  }

  /**
   * Delete all trades for a user and stamp the clear timestamp on the User doc.
   * Any Bybit-synced trades that close before this timestamp will be filtered out going forward.
   */
  async clearTradeHistory(userId) {
    const User = require('../models/User');
    const now = new Date();
    const deleted = await Trade.deleteMany({ user: userId });
    await User.updateOne({ _id: userId }, { $set: { tradeHistoryClearedAt: now } });
    invalidateSummaryCache(String(userId));
    return { clearedAt: now, deletedCount: deleted.deletedCount || 0 };
  }
}

module.exports = PortfolioService;
