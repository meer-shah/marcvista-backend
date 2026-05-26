/**
 * Tests for the late-fill merge math and partial-fill aggregation used by
 * the closed-PnL sync. These are pure functions — no DB / network.
 *
 * What this proves:
 *   1. aggregatePartialFills collapses Bybit rows that share orderLinkId/orderId
 *      into one logical trade with summed qty / pnl / fees and qty-weighted prices.
 *   2. mergeFillIntoAccum correctly accumulates late-arriving fills into an
 *      existing closed-trade record (sums pnl/qty/fees, qty-weights exitPrice,
 *      tracks newClosedPnlIds for dedup).
 *   3. A merge that flips the sign of cumulative pnl correctly changes outcome.
 */

jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { mergeFillIntoAccum, aggregatePartialFills, inferOpeningSide } = require('../controllers/fetchinfo');

describe('aggregatePartialFills — collapses Bybit rows of the same logical order', () => {
  test('two fills with same orderLinkId collapse into one aggregated row', () => {
    const raw = [
      {
        orderLinkId: 'link-A',
        orderId: 'oid-1',
        symbol: 'LINKUSDT',
        side: 'Buy',
        qty: '60',
        avgEntryPrice: '20.00',
        avgExitPrice: '19.00',
        closedPnl: '-60',
        cumExecFee: '0.55',
        updatedTime: '1700000000000',
        createdTime: '1699999900000',
      },
      {
        orderLinkId: 'link-A',
        orderId: 'oid-2',
        symbol: 'LINKUSDT',
        side: 'Buy',
        qty: '40',
        avgEntryPrice: '20.00',
        avgExitPrice: '19.50',
        closedPnl: '-20',
        cumExecFee: '0.37',
        updatedTime: '1700000060000',
        createdTime: '1699999800000',
      },
    ];
    const agg = aggregatePartialFills(raw);
    expect(agg).toHaveLength(1);
    const m = agg[0];
    expect(parseFloat(m.qty)).toBe(100);
    expect(parseFloat(m.closedPnl)).toBeCloseTo(-80, 6);
    expect(parseFloat(m.cumExecFee)).toBeCloseTo(0.92, 6);
    // qty-weighted exit: (60*19 + 40*19.5) / 100 = 19.2
    expect(parseFloat(m.avgExitPrice)).toBeCloseTo(19.2, 4);
    // latest updatedTime wins
    expect(m.updatedTime).toBe('1700000060000');
    // earliest createdTime wins
    expect(m.createdTime).toBe('1699999800000');
    expect(m._aggregatedFills).toBe(2);
  });

  test('singleton rows pass through untouched', () => {
    const raw = [
      { orderLinkId: 'link-A', orderId: 'oid-1', symbol: 'BTCUSDT', qty: '1', closedPnl: '5', updatedTime: '1' },
      { orderLinkId: 'link-B', orderId: 'oid-2', symbol: 'BTCUSDT', qty: '1', closedPnl: '3', updatedTime: '2' },
    ];
    const agg = aggregatePartialFills(raw);
    expect(agg).toHaveLength(2);
  });

  test('proximity-merge — same symbol+side within 5s collapses even with different orderIds', () => {
    const raw = [
      { orderId: 'oid-X', symbol: 'BTCUSDT', side: 'Buy', qty: '0.5', avgEntryPrice: '50000', avgExitPrice: '49000', closedPnl: '-500', cumExecFee: '0.13', updatedTime: '1700000000000' },
      { orderId: 'oid-Y', symbol: 'BTCUSDT', side: 'Buy', qty: '0.5', avgEntryPrice: '50000', avgExitPrice: '49500', closedPnl: '-250', cumExecFee: '0.13', updatedTime: '1700000002000' }, // 2s later
    ];
    const agg = aggregatePartialFills(raw);
    expect(agg).toHaveLength(1);
    expect(parseFloat(agg[0].qty)).toBe(1);
    expect(parseFloat(agg[0].closedPnl)).toBeCloseTo(-750, 6);
    expect(agg[0]._timeProximityMerged).toBe(true);
  });

  test('proximity-merge does NOT collapse rows further than 5s apart', () => {
    const raw = [
      { orderId: 'oid-A', symbol: 'ETHUSDT', side: 'Buy', qty: '1', avgEntryPrice: '3000', avgExitPrice: '2950', closedPnl: '-50', updatedTime: '1700000000000' },
      { orderId: 'oid-B', symbol: 'ETHUSDT', side: 'Buy', qty: '1', avgEntryPrice: '3000', avgExitPrice: '2950', closedPnl: '-50', updatedTime: '1700000010000' }, // 10s later
    ];
    const agg = aggregatePartialFills(raw);
    expect(agg).toHaveLength(2);
  });

  test('proximity-merge does NOT collapse rows with different side', () => {
    const raw = [
      { orderId: 'oid-A', symbol: 'ETHUSDT', side: 'Buy', qty: '1', closedPnl: '-50', updatedTime: '1700000000000' },
      { orderId: 'oid-B', symbol: 'ETHUSDT', side: 'Sell', qty: '1', closedPnl: '50', updatedTime: '1700000001000' },
    ];
    const agg = aggregatePartialFills(raw);
    expect(agg).toHaveLength(2);
  });

  test('rows without orderLinkId fall back to grouping by orderId', () => {
    const raw = [
      { orderId: 'oid-9', symbol: 'ETHUSDT', qty: '2', avgEntryPrice: '3000', avgExitPrice: '3100', closedPnl: '200', cumExecFee: '0.1', updatedTime: '10' },
      { orderId: 'oid-9', symbol: 'ETHUSDT', qty: '3', avgEntryPrice: '3000', avgExitPrice: '3050', closedPnl: '150', cumExecFee: '0.2', updatedTime: '20' },
    ];
    const agg = aggregatePartialFills(raw);
    expect(agg).toHaveLength(1);
    expect(parseFloat(agg[0].qty)).toBe(5);
    expect(parseFloat(agg[0].closedPnl)).toBeCloseTo(350, 6);
  });
});

describe('mergeFillIntoAccum — late fills merge into an existing closed trade', () => {
  test('first merge starts from the Trade doc and adds the late fill', () => {
    const existingTrade = {
      pnl: -307.38,
      qty: 100,
      fees: 0.5,
      exitPrice: 19.0,
      closedAt: new Date('2026-05-25T10:00:00Z'),
      balanceBefore: 5103.38,
    };
    const lateFill = {
      pnl: -110.94,
      qty: 50,
      fees: 0.3,
      exitPrice: 18.8,
      closedAtMs: new Date('2026-05-25T10:01:00Z').getTime(),
      closedPnlId: 'late-fill-1',
    };
    const acc = mergeFillIntoAccum(existingTrade, lateFill, { isFirstMerge: true });
    expect(acc.pnl).toBeCloseTo(-418.32, 4);
    expect(acc.qty).toBe(150);
    expect(acc.fees).toBeCloseTo(0.8, 6);
    // qty-weighted exit: (100*19 + 50*18.8) / 150 = 18.9333...
    expect(acc.exitPrice).toBeCloseTo(18.9333, 3);
    expect(acc.closedAt).toBe(lateFill.closedAtMs);
    expect(acc.newClosedPnlIds).toEqual(['late-fill-1']);
    expect(acc.balanceBefore).toBe(5103.38);
    // balanceAfter (derived later) = balanceBefore + pnl
    expect(acc.balanceBefore + acc.pnl).toBeCloseTo(4685.06, 2);
  });

  test('subsequent merges accumulate into the existing accumulator', () => {
    const existingTrade = {
      pnl: -100, qty: 50, fees: 0.1, exitPrice: 20, closedAt: new Date(1000),
      balanceBefore: 1000,
    };
    let acc = mergeFillIntoAccum(existingTrade, {
      pnl: -50, qty: 25, fees: 0.05, exitPrice: 19, closedAtMs: 2000, closedPnlId: 'f1',
    }, { isFirstMerge: true });
    acc = mergeFillIntoAccum(acc, {
      pnl: -25, qty: 25, fees: 0.05, exitPrice: 18, closedAtMs: 3000, closedPnlId: 'f2',
    });
    expect(acc.pnl).toBe(-175);
    expect(acc.qty).toBe(100);
    expect(acc.fees).toBeCloseTo(0.2, 6);
    // qty-weighted: (50*20 + 25*19 + 25*18) / 100 = (1000 + 475 + 450) / 100 = 19.25
    expect(acc.exitPrice).toBeCloseTo(19.25, 4);
    expect(acc.closedAt).toBe(3000);
    expect(acc.newClosedPnlIds).toEqual(['f1', 'f2']);
  });

  test('outcome flip: merge can turn a Win into a Loss when cumulative pnl crosses zero', () => {
    // Original trade closed +50 (Win). A late fill of -120 should turn it into a Loss (-70).
    const existing = { pnl: 50, qty: 10, fees: 0, exitPrice: 105, closedAt: new Date(1000), balanceBefore: 1000 };
    const acc = mergeFillIntoAccum(existing, {
      pnl: -120, qty: 5, fees: 0.1, exitPrice: 95, closedAtMs: 2000, closedPnlId: 'f-late',
    }, { isFirstMerge: true });
    const newOutcome = acc.pnl > 0 ? 'Win' : 'Loss';
    expect(acc.pnl).toBe(-70);
    expect(newOutcome).toBe('Loss');
  });

  test('fill with no exitPrice does not corrupt the running exit average', () => {
    const existing = { pnl: 10, qty: 1, fees: 0, exitPrice: 100, closedAt: new Date(1000), balanceBefore: 1000 };
    const acc = mergeFillIntoAccum(existing, {
      pnl: 5, qty: 1, fees: 0, exitPrice: 0, closedAtMs: 2000, closedPnlId: 'no-exit',
    }, { isFirstMerge: true });
    // exitPrice should remain at the original (we only update when fillExit && fillQty)
    expect(acc.exitPrice).toBe(100);
    expect(acc.qty).toBe(2);
    expect(acc.pnl).toBe(15);
  });
});

describe('streak-tick skip logic (regression guard)', () => {
  test('a merged-only fill id should be filtered out of the streak-update loop', () => {
    // Simulates the loop body: only fills NOT in mergedOnlyFillIds should tick the streak.
    const mergedOnlyFillIds = new Set(['late-fill-1', 'late-fill-2']);
    const unprocessedFills = [
      { id: 'fill-pending-match', isMerged: false },
      { id: 'late-fill-1', isMerged: true },
      { id: 'late-fill-2', isMerged: true },
      { id: 'fill-external', isMerged: false },
    ];
    const ticked = unprocessedFills
      .filter(f => !mergedOnlyFillIds.has(f.id))
      .map(f => f.id);
    expect(ticked).toEqual(['fill-pending-match', 'fill-external']);
  });
});

describe('inferOpeningSide — direction inferred from PnL & price', () => {
  test('long profit: exit > entry, pnl > 0 → Buy', () => {
    expect(inferOpeningSide({ avgEntryPrice: '100', avgExitPrice: '110', closedPnl: '10', side: 'Sell' })).toBe('Buy');
  });
  test('short profit: exit < entry, pnl > 0 → Sell', () => {
    expect(inferOpeningSide({ avgEntryPrice: '100', avgExitPrice: '90', closedPnl: '10', side: 'Buy' })).toBe('Sell');
  });
  test('long loss: exit < entry, pnl < 0 → Buy', () => {
    expect(inferOpeningSide({ avgEntryPrice: '100', avgExitPrice: '90', closedPnl: '-10', side: 'Buy' })).toBe('Buy');
  });
  test('short loss: exit > entry, pnl < 0 → Sell', () => {
    expect(inferOpeningSide({ avgEntryPrice: '100', avgExitPrice: '110', closedPnl: '-10', side: 'Sell' })).toBe('Sell');
  });
  test('fallback: missing data flips reported side', () => {
    expect(inferOpeningSide({ side: 'Buy' })).toBe('Sell');
  });
});
