/**
 * performanceService — compute performance metrics from any array of trades.
 *
 * Designed to be reusable: risk profile performance, symbol analysis,
 * tag-based filtering, strategy comparison, etc.
 */

/**
 * @param {Array} trades - sorted by placedAt ascending, outcome Win|Loss only
 * @returns {Object} metrics + balanceOverTrades[] + tradeDetails[]
 */
function computePerformance(trades) {
  if (!trades || trades.length === 0) {
    return {
      winRate: 0,
      totalProfit: 0,
      totalLoss: 0,
      netProfit: 0,
      wins: 0,
      losses: 0,
      finalBalance: 0,
      maxBalance: 0,
      minBalance: 0,
      maxDrawdown: 0,
      balanceOverTrades: [],
      tradeDetails: [],
    };
  }

  const startingBalance = trades[0].balanceBefore || 0;
  let running = startingBalance;
  let maxBalance = startingBalance;
  let minBalance = startingBalance;
  let peak = startingBalance;
  let maxDrawdown = 0;
  let wins = 0, losses = 0, totalProfit = 0, totalLoss = 0;

  const balanceOverTrades = [{ trade: 0, balance: startingBalance }];
  const tradeDetails = [];

  trades.forEach((t, i) => {
    const pnl = t.pnl || 0;
    running += pnl;

    if (pnl > 0) { wins++; totalProfit += pnl; }
    else { losses++; totalLoss += Math.abs(pnl); }

    if (running > maxBalance) maxBalance = running;
    if (running < minBalance) minBalance = running;
    if (running > peak) peak = running;
    const drawdown = peak > 0 ? ((peak - running) / peak) * 100 : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    balanceOverTrades.push({ trade: i + 1, balance: running });
    tradeDetails.push({
      tradeNumber: t.tradeNumber || i + 1,
      symbol: t.symbol,
      side: t.side,
      source: t.source || 'app',
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      qty: t.qty,
      pnl,
      outcome: t.outcome,
      placedAt: t.placedAt,
      closedAt: t.closedAt,
      balanceAfter: t.balanceAfter,
      fees: t.fees || null,
      duration: t.duration || null,
    });
  });

  const totalTrades = wins + losses;
  return {
    winRate: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
    totalProfit,
    totalLoss,
    netProfit: totalProfit - totalLoss,
    wins,
    losses,
    finalBalance: running,
    maxBalance,
    minBalance,
    maxDrawdown,
    balanceOverTrades,
    tradeDetails,
  };
}

module.exports = { computePerformance };
