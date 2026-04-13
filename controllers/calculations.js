/**
 * Calculation utilities for trading metrics and risk management
 * These functions don't make API calls - they process data
 */

/**
 * Calculate trade metrics from trades array
 */
function calculateTradeMetrics(trades) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return {
      totalTrades: 0,
      avgTradeOutput: 0,
      avgWinningTrade: 0,
      avgLosingTrade: 0,
      winRate: 0
    };
  }
  let totalPnL = 0;
  let totalWinningPnL = 0;
  let totalLosingPnL = 0;
  let winCount = 0;
  let lossCount = 0;

  trades.forEach(trade => {
    const pnl = parseFloat(trade.closedPnl);
    totalPnL += pnl;

    if (pnl > 0) {
      totalWinningPnL += pnl;
      winCount++;
    } else if (pnl < 0) {
      totalLosingPnL += pnl;
      lossCount++;
    }
  });

  const totalTrades = trades.length;
  const avgTradeOutput = totalTrades > 0 ? totalPnL / totalTrades : 0;
  const avgWinningTrade = winCount > 0 ? totalWinningPnL / winCount : 0;
  const avgLosingTrade = lossCount > 0 ? totalLosingPnL / lossCount : 0;
  const winRate = totalTrades > 0 ? (winCount / totalTrades) * 100 : 0;

  return {
    totalTrades,
    avgTradeOutput,
    avgWinningTrade,
    avgLosingTrade,
    winRate,
  };
}

/**
 * Find best and worst trades from array
 */
function findBestAndWorstTrade(trades) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return {
      bestTrade: { closedPnl: 0 },
      worstTrade: { closedPnl: 0 }
    };
  }

  let bestTrade = trades[0];
  let worstTrade = trades[0];

  trades.forEach(trade => {
    const pnl = parseFloat(trade.closedPnl || 0);
    const bestPnl = parseFloat(bestTrade.closedPnl || 0);
    const worstPnl = parseFloat(worstTrade.closedPnl || 0);

    if (pnl > bestPnl) bestTrade = trade;
    if (pnl < worstPnl) worstTrade = trade;
  });

  return {
    bestTrade: { ...bestTrade, closedPnl: parseFloat(bestTrade.closedPnl || 0) },
    worstTrade: { ...worstTrade, closedPnl: parseFloat(worstTrade.closedPnl || 0) }
  };
}

/**
 * Analyze coin performance from trades
 */
function analyzeCoinPerformance(trades) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return { bestCoins: [], worstCoins: [] };
  }
  const coinPnL = {};

  trades.forEach(trade => {
    const symbol = trade.symbol;
    const pnl = parseFloat(trade.closedPnl);

    if (!coinPnL[symbol]) {
      coinPnL[symbol] = { totalPnL: 0, totalLoss: 0 };
    }

    coinPnL[symbol].totalPnL += pnl;

    if (pnl < 0) {
      coinPnL[symbol].totalLoss += pnl;
    }
  });

  const coinPnLArray = Object.keys(coinPnL).map(symbol => ({
    symbol,
    totalPnL: coinPnL[symbol].totalPnL,
    totalLoss: coinPnL[symbol].totalLoss,
  }));

  const bestCoins = [...coinPnLArray].sort((a, b) => b.totalPnL - a.totalPnL).slice(0, 5);
  const worstCoins = [...coinPnLArray].sort((a, b) => a.totalPnL - b.totalPnL).slice(0, 5);

  return { bestCoins, worstCoins };
}

/**
 * Extract USDT balance from wallet response
 */
function getUsdtBalance(response) {
  const account = response?.result?.list?.[0];
  if (!account) return 0;

  const usdtCoin = account.coin?.find(c => c.coin === 'USDT');
  if (!usdtCoin) return 0;

  return parseFloat(usdtCoin.availableToWithdraw) ||
         parseFloat(usdtCoin.walletBalance) || 0;
}

module.exports = {
  calculateTradeMetrics,
  findBestAndWorstTrade,
  analyzeCoinPerformance,
  getUsdtBalance
};
