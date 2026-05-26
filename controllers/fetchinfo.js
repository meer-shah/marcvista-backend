const { http_request, clearCredentialCache } = require('../config/bybitConfig');
const logger = require('../utils/logger');
const {
  calculateTradeMetrics,
  findBestAndWorstTrade,
  analyzeCoinPerformance,
  getUsdtBalance
} = require('./calculations');

/**
 * Infer the OPENING side of a closed-PnL trade from its P&L sign and prices.
 *
 * Bybit's `/v5/position/closed-pnl` `side` field reports the side of the
 * *closing* order for TP/SL/auto-close, but when a user manually closes a
 * position on Bybit's UI the `side` reported there can be the *opening*
 * side instead — leading the old naive `flip(trade.side)` logic to display
 * the wrong direction for manually-closed trades.
 *
 * P&L arithmetic is direction-independent and reliable across every close
 * path (TP, SL, manual, liquidation):
 *   Long  profit ⇔ exit > entry   |   Long  loss  ⇔ exit < entry
 *   Short profit ⇔ exit < entry   |   Short loss  ⇔ exit > entry
 *
 * Fallback: if prices or PnL are missing/equal (shouldn't happen in
 * practice), we fall back to the old flip-the-reported-side behaviour so
 * the regression surface stays small.
 */
function inferOpeningSide(trade) {
  const entry = parseFloat(trade.avgEntryPrice);
  const exit = parseFloat(trade.avgExitPrice);
  const pnl = parseFloat(trade.closedPnl);

  if (Number.isFinite(entry) && Number.isFinite(exit) && Number.isFinite(pnl) && entry !== exit && pnl !== 0) {
    const priceWentUp = exit > entry;
    const profitable = pnl > 0;
    // Long iff (price up ∧ profit) OR (price down ∧ loss)
    return priceWentUp === profitable ? 'Buy' : 'Sell';
  }

  // Fallback: flip whatever Bybit reported (original behaviour)
  return trade.side === 'Buy' ? 'Sell' : 'Buy';
}

/**
 * Pure helper — accumulate a late partial-fill into an existing closed trade.
 * Returns the new accumulator state. Exported for unit testing.
 *
 * @param {object} prev - existing accumulator OR the original Trade doc on first merge
 * @param {object} fill - { pnl, qty, fees, exitPrice, closedAtMs, closedPnlId }
 * @param {object} [opts] - { isFirstMerge: boolean } — true when prev is the raw Trade doc
 */
function mergeFillIntoAccum(prev, fill, opts = {}) {
  const { isFirstMerge = false } = opts;
  const base = isFirstMerge
    ? {
        pnl: Number(prev.pnl) || 0,
        qty: Number(prev.qty) || 0,
        fees: Number(prev.fees) || 0,
        closedAt: prev.closedAt ? new Date(prev.closedAt).getTime() : 0,
        exitPrice: Number(prev.exitPrice) || 0,
        exitNotional: (Number(prev.exitPrice) || 0) * (Number(prev.qty) || 0),
        balanceBefore: Number(prev.balanceBefore) || 0,
        newClosedPnlIds: [],
      }
    : prev;

  const next = {
    ...base,
    pnl: base.pnl + (Number(fill.pnl) || 0),
    qty: base.qty + (Number(fill.qty) || 0),
    fees: base.fees + (Number(fill.fees) || 0),
    closedAt: Math.max(base.closedAt || 0, Number(fill.closedAtMs) || 0),
    newClosedPnlIds: [...base.newClosedPnlIds, fill.closedPnlId],
  };
  const fillQty = Number(fill.qty) || 0;
  const fillExit = Number(fill.exitPrice) || 0;
  if (fillExit && fillQty) {
    next.exitNotional = base.exitNotional + fillExit * fillQty;
    next.exitPrice = next.qty > 0 ? next.exitNotional / next.qty : fillExit;
  }
  return next;
}

/**
 * Collapse Bybit closed-PnL rows that belong to the same logical order.
 *
 * Bybit returns one row per partial fill. All partials from the same order
 * share the same `orderLinkId` (for app-placed orders) or the same `orderId`
 * (fallback for external orders). Treating each fill as a separate trade
 * inflates trade count and distorts win-rate / best-worst / streak logic.
 *
 * Rows without `orderLinkId` AND without `orderId` are left untouched.
 */
function aggregatePartialFills(rawTrades) {
  const groups = new Map();
  const singletons = [];

  for (const t of rawTrades) {
    const key = t.orderLinkId || t.orderId;
    if (!key) {
      singletons.push(t);
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const aggregated = [];
  for (const [, fills] of groups) {
    if (fills.length === 1) {
      aggregated.push(fills[0]);
      continue;
    }

    let totalQty = 0;
    let totalPnl = 0;
    let totalFees = 0;
    let entryNotional = 0;
    let exitNotional = 0;
    let latestTime = 0;
    let earliestCreated = Infinity;

    for (const f of fills) {
      const qty = parseFloat(f.qty) || 0;
      const entry = parseFloat(f.avgEntryPrice) || 0;
      const exit = parseFloat(f.avgExitPrice) || 0;
      totalQty += qty;
      totalPnl += parseFloat(f.closedPnl) || 0;
      totalFees += parseFloat(f.cumExecFee) || 0;
      entryNotional += qty * entry;
      exitNotional += qty * exit;
      const upd = Number(f.updatedTime || f.closedAt || 0);
      if (upd > latestTime) latestTime = upd;
      const created = Number(f.createdTime || 0);
      if (created && created < earliestCreated) earliestCreated = created;
    }

    const latest = fills.reduce((a, b) =>
      Number(a.updatedTime || 0) >= Number(b.updatedTime || 0) ? a : b
    );

    aggregated.push({
      ...latest,
      qty: totalQty.toString(),
      closedPnl: totalPnl.toString(),
      cumExecFee: totalFees.toString(),
      avgEntryPrice: totalQty > 0 ? (entryNotional / totalQty).toString() : latest.avgEntryPrice,
      avgExitPrice: totalQty > 0 ? (exitNotional / totalQty).toString() : latest.avgExitPrice,
      updatedTime: latestTime ? latestTime.toString() : latest.updatedTime,
      createdTime: Number.isFinite(earliestCreated) ? earliestCreated.toString() : latest.createdTime,
      _aggregatedFills: fills.length,
    });
  }

  // Second pass — collapse fills of the same symbol + side that closed within
  // PROXIMITY_MS of each other. Bybit sometimes splits a single TP/SL close
  // into multiple rows with *different* orderIds and no shared orderLinkId
  // (e.g. partial liquidations, multiple-tranche TP), which the primary
  // grouping above would treat as separate trades.
  const PROXIMITY_MS = 5000;
  const all = [...aggregated, ...singletons]
    .sort((a, b) => Number(a.updatedTime || 0) - Number(b.updatedTime || 0));
  const collapsed = [];
  for (const t of all) {
    const last = collapsed[collapsed.length - 1];
    if (
      last &&
      last.symbol === t.symbol &&
      last.side && t.side && last.side === t.side &&
      Math.abs(Number(t.updatedTime || 0) - Number(last.updatedTime || 0)) <= PROXIMITY_MS
    ) {
      const lastQty = parseFloat(last.qty) || 0;
      const tQty = parseFloat(t.qty) || 0;
      const totalQty = lastQty + tQty;
      const lastEntry = parseFloat(last.avgEntryPrice) || 0;
      const tEntry = parseFloat(t.avgEntryPrice) || 0;
      const lastExit = parseFloat(last.avgExitPrice) || 0;
      const tExit = parseFloat(t.avgExitPrice) || 0;
      const merged = {
        ...last,
        qty: totalQty.toString(),
        closedPnl: ((parseFloat(last.closedPnl) || 0) + (parseFloat(t.closedPnl) || 0)).toString(),
        cumExecFee: ((parseFloat(last.cumExecFee) || 0) + (parseFloat(t.cumExecFee) || 0)).toString(),
        avgEntryPrice: totalQty > 0 ? ((lastQty * lastEntry + tQty * tEntry) / totalQty).toString() : last.avgEntryPrice,
        avgExitPrice: totalQty > 0 ? ((lastQty * lastExit + tQty * tExit) / totalQty).toString() : last.avgExitPrice,
        updatedTime: Math.max(Number(last.updatedTime || 0), Number(t.updatedTime || 0)).toString(),
        _aggregatedFills: (last._aggregatedFills || 1) + (t._aggregatedFills || 1),
        _timeProximityMerged: true,
      };
      collapsed[collapsed.length - 1] = merged;
    } else {
      collapsed.push(t);
    }
  }
  return collapsed;
}

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

    // Collapse partial fills of the same order into one logical trade.
    // Bybit returns one row per fill; without this, a single order that fills
    // in 4 chunks would count as 4 wins/losses and distort metrics.
    trades = aggregatePartialFills(trades);

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

    // Display the OPENING side: inferred from PnL + price direction, which
    // is correct regardless of whether the trade closed via TP/SL, auto-close,
    // or manual-close on the Bybit UI (manual close sometimes reports the
    // opening side as `trade.side` rather than the closing side, so a naive
    // flip would invert direction only for manually-closed trades).
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
      side: inferOpeningSide(trade),
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
          // Sort EXPLICITLY by updatedTime ascending (oldest → newest). Do NOT
          // rely on Bybit's response order — aggregatePartialFills can reorder
          // rows during the proximity merge, and a naive .reverse() would flip
          // the wrong way and cause newer trades to be skipped by the
          // lastProcessedTradeId slice below.
          const tradesChronological = [...trades].sort((a, b) =>
            Number(a.updatedTime || a.closedAt || 0) - Number(b.updatedTime || b.closedAt || 0)
          );

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

          // Also look up already-CLOSED app trades by orderLinkId so a late-arriving
          // partial fill (e.g. TP closes a position in two chunks with the same
          // orderLinkId) is merged into the existing trade rather than written
          // as a duplicate "external" row.
          const recentWindowMs = 5 * 60 * 1000;
          const recentSinceDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
          const [existingDocs, mergedHistoryDocs, pendingByLinkDocs, pendingBySymbolDocs, closedByLinkDocs, recentClosedAppDocs] = await Promise.all([
            Trade.find({ bybitClosedPnlId: { $in: candidateIds } })
              .select('bybitClosedPnlId')
              .lean(),
            Trade.find({
              user: req.user._id,
              'metadata.mergedClosedPnlIds': { $in: candidateIds },
            }).select('metadata.mergedClosedPnlIds').lean(),
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
            candidateOrderLinkIds.length
              ? Trade.find({
                  user: req.user._id,
                  orderLinkId: { $in: candidateOrderLinkIds },
                  outcome: { $in: ['Win', 'Loss'] },
                  source: 'app',
                }).lean()
              : Promise.resolve([]),
            Trade.find({
              user: req.user._id,
              source: 'app',
              outcome: { $in: ['Win', 'Loss'] },
              closedAt: { $gte: recentSinceDate },
            }).sort({ closedAt: -1 }).lean(),
          ]);

          const closedByLinkMap = new Map(
            closedByLinkDocs.map(d => [d.orderLinkId, d])
          );
          // Group recently-closed app trades by symbol for time-proximity merge fallback
          const recentClosedBySymbol = new Map();
          for (const d of recentClosedAppDocs) {
            if (!recentClosedBySymbol.has(d.symbol)) recentClosedBySymbol.set(d.symbol, []);
            recentClosedBySymbol.get(d.symbol).push(d);
          }
          // Track in-memory merges so multiple fills in the same sync pass aggregate correctly
          const mergedAccum = new Map(); // _id -> { pnl, qty, fees, closedAt, exitPrice, balanceAfter }
          // Fills that were merged into an existing closed trade — they should NOT
          // tick the risk-profile streak again (the original close already did).
          const mergedOnlyFillIds = new Set();
          // Fills that became EXTERNAL trades (placed directly on Bybit, not via
          // the app). These must NOT adjust the risk-profile streak — risk math
          // is the single-source-of-truth from app trades only.
          const externalFillIds = new Set();

          const existingSet = new Set(existingDocs.map(d => d.bybitClosedPnlId));
          for (const d of mergedHistoryDocs) {
            const ids = (d.metadata && d.metadata.mergedClosedPnlIds) || [];
            for (const id of ids) existingSet.add(id);
          }
          const pendingByLinkMap = new Map(
            pendingByLinkDocs.map(d => [d.orderLinkId, d])
          );
          // Also index Pending trades by bybitOrderId — Bybit auto-generates a
          // *different* orderLinkId for the SL/TP-triggered closing order, so
          // the closed-pnl row often won't match the entry's orderLinkId.
          // The Bybit orderId of the entry, stored on the Pending row, is the
          // reliable link for app trades.
          const pendingByBybitOrderIdMap = new Map();
          for (const d of pendingBySymbolDocs) {
            if (d.bybitOrderId) pendingByBybitOrderIdMap.set(String(d.bybitOrderId), d);
          }
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

            // ── Step 1b: match by entry's Bybit orderId. SL/TP-triggered closes
            // have a different orderLinkId than the entry, but the closed-pnl
            // row still references the original entry orderId in many cases.
            if (!pendingTrade && trade.orderId) {
              const byBybitId = pendingByBybitOrderIdMap.get(String(trade.orderId));
              if (byBybitId && !consumedPendingIds.has(String(byBybitId._id))) {
                pendingTrade = byBybitId;
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

            // ── Step 2b: if no Pending match, look for an existing CLOSED app trade
            // to merge this late partial fill into (same orderLinkId, or same
            // symbol within 5 min of a prior close).
            let mergeTarget = null;
            if (!pendingTrade) {
              if (trade.orderLinkId && closedByLinkMap.has(trade.orderLinkId)) {
                mergeTarget = closedByLinkMap.get(trade.orderLinkId);
              } else {
                const bucket = recentClosedBySymbol.get(trade.symbol) || [];
                mergeTarget = bucket.find(d => {
                  const dt = new Date(d.closedAt).getTime();
                  return Math.abs(dt - closedTime.getTime()) <= recentWindowMs;
                }) || null;
              }
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
            } else if (mergeTarget) {
              // Merge this late fill into the existing closed app trade so the
              // user sees one logical trade (not an "Exchange" duplicate).
              // Defer the DB write until after the loop so multiple fills
              // against the same target produce a single, final update.
              const targetId = String(mergeTarget._id);
              const fillQty = parseFloat(trade.qty) || 0;
              const fillFee = parseFloat(trade.cumExecFee || 0) || 0;
              const accum = mergedAccum.get(targetId) || {
                _doc: mergeTarget,
                pnl: mergeTarget.pnl || 0,
                qty: mergeTarget.qty || 0,
                fees: mergeTarget.fees || 0,
                closedAt: new Date(mergeTarget.closedAt).getTime(),
                exitPrice: mergeTarget.exitPrice || 0,
                exitNotional: (mergeTarget.exitPrice || 0) * (mergeTarget.qty || 0),
                balanceBefore: mergeTarget.balanceBefore || 0,
                newClosedPnlIds: [],
              };
              accum.pnl += pnl;
              accum.qty += fillQty;
              accum.fees += fillFee;
              if (exitPrice && fillQty) {
                accum.exitNotional += exitPrice * fillQty;
                accum.exitPrice = accum.qty > 0 ? accum.exitNotional / accum.qty : exitPrice;
              }
              if (closedTime.getTime() > accum.closedAt) accum.closedAt = closedTime.getTime();
              accum.newClosedPnlIds.push(closedPnlId);
              mergedAccum.set(targetId, accum);
              existingSet.add(closedPnlId);
              mergedOnlyFillIds.add(closedPnlId);
            } else {
              // ── Step 3: no match → external trade ──
              // Diagnostic — if you see this for an order placed via the app,
              // the Pending Trade row was likely never persisted (Trade.create
              // failed during placement). Check the OrderService error logs.
              externalFillIds.add(closedPnlId);
              logger.warn('Closed-pnl row had no matching Pending app trade — labeling as external', {
                userId: String(req.user._id),
                symbol: trade.symbol,
                bybitOrderId: trade.orderId,
                bybitOrderLinkId: trade.orderLinkId,
                closedTime: closedTime.toISOString(),
                pendingCountForSymbol: (pendingBySymbolMap.get(trade.symbol) || []).length,
                pendingTotal: pendingBySymbolDocs.length,
              });
              externalTradeOffset++;
              const openingSide = inferOpeningSide(trade);

              tradeBulkOps.push({
                insertOne: {
                  document: {
                    user: req.user._id,
                    riskProfile: activeProfile._id,
                    activatedAt: activeProfile.activatedAt || activeProfile.createdAt,
                    tradeNumber: externalTradeOffset,
                    symbol: trade.symbol,
                    side: openingSide,
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
                    fees: (() => {
                      const f = parseFloat(trade.cumExecFee);
                      return Number.isFinite(f) ? f : null;
                    })(),
                  },
                },
              });
            }
          }

          // Flush merged-accum into a single update per target
          for (const [targetId, accum] of mergedAccum) {
            const newOutcome = accum.pnl > 0 ? 'Win' : 'Loss';
            tradeBulkOps.push({
              updateOne: {
                filter: { _id: targetId },
                update: {
                  $set: {
                    pnl: accum.pnl,
                    qty: accum.qty,
                    fees: accum.fees,
                    exitPrice: accum.exitPrice || accum._doc.exitPrice,
                    closedAt: new Date(accum.closedAt),
                    outcome: newOutcome,
                    balanceAfter: accum.balanceBefore + accum.pnl,
                  },
                  $addToSet: {
                    tags: 'merged-partial',
                    'metadata.mergedClosedPnlIds': { $each: accum.newClosedPnlIds },
                  },
                },
              },
            });
          }

          if (tradeBulkOps.length > 0) {
            try {
              await Trade.bulkWrite(tradeBulkOps, { ordered: false });
            } catch (e) {
              logger.error('Trade bulkWrite failed', e);
            }
          }

          // Update risk profile streak counters for unprocessed trades.
          // Skip:
          //   - merged-only fills (the original close already ticked the streak)
          //   - external fills (trades placed directly on Bybit, not via the app)
          // Risk math = single source of truth from APP trades only.
          for (const trade of unprocessedTrades) {
            const pnl = parseFloat(trade.closedPnl);
            if (isNaN(pnl)) continue;
            const closedPnlId = String(trade.orderId || trade.execId || `${trade.symbol}-${trade.updatedTime}`);
            if (mergedOnlyFillIds.has(closedPnlId)) continue;
            if (externalFillIds.has(closedPnlId)) continue;
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
  getAccountBalanceFromHere,
  // Exported for unit testing
  mergeFillIntoAccum,
  aggregatePartialFills,
  inferOpeningSide,
};
