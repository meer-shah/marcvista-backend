/**
 * Tests for fee-inclusive position-sizing helpers.
 *
 * Core invariant: with the qty returned by computeFeeAwareQty, the total loss
 * if SL hits — including entry fee + SL exit fee — equals riskUsd exactly.
 */
const {
  MAKER_FEE,
  TAKER_FEE,
  classifyFillType,
  computeFeeAwareQty,
  effectiveRR,
} = require('../utils/feeMath');

describe('classifyFillType — Maker vs Taker prediction', () => {
  test('Buy below live → Maker (rests below ask)', () => {
    expect(classifyFillType('Buy', 99.5, 100)).toBe('maker');
  });
  test('Buy at live → Taker (crosses ask)', () => {
    expect(classifyFillType('Buy', 100, 100)).toBe('taker');
  });
  test('Buy above live → Taker', () => {
    expect(classifyFillType('Buy', 100.5, 100)).toBe('taker');
  });
  test('Sell above live → Maker (rests above bid)', () => {
    expect(classifyFillType('Sell', 100.5, 100)).toBe('maker');
  });
  test('Sell at live → Taker', () => {
    expect(classifyFillType('Sell', 100, 100)).toBe('taker');
  });
  test('Sell below live → Taker', () => {
    expect(classifyFillType('Sell', 99.5, 100)).toBe('taker');
  });
  test('Buy within 0.02% tolerance of live → Taker', () => {
    expect(classifyFillType('Buy', 99.99, 100)).toBe('taker'); // within tolerance
    expect(classifyFillType('Buy', 99.97, 100)).toBe('maker'); // outside tolerance
  });
  test('Missing or invalid live price → Taker (conservative default)', () => {
    expect(classifyFillType('Buy', 100, NaN)).toBe('taker');
    expect(classifyFillType('Buy', 100, 0)).toBe('taker');
    expect(classifyFillType('Buy', 100, undefined)).toBe('taker');
  });
  test('Unknown side → Taker', () => {
    expect(classifyFillType('Sideways', 100, 100)).toBe('taker');
  });
});

describe('computeFeeAwareQty — fee-inclusive sizing', () => {
  test('returned qty yields total_loss_at_SL exactly == riskUsd (Taker)', () => {
    const riskUsd = 2000;
    const entry = 50000;
    const stopLoss = 48000;
    const feeEntry = TAKER_FEE;
    const feeExit = TAKER_FEE;
    const qty = computeFeeAwareQty({ riskUsd, entry, stopLoss, feeEntry, feeExit });
    const distance = Math.abs(entry - stopLoss);
    const totalLoss = qty * distance + qty * entry * feeEntry + qty * stopLoss * feeExit;
    expect(totalLoss).toBeCloseTo(riskUsd, 6);
  });

  test('returned qty yields total_loss_at_SL exactly == riskUsd (Maker entry)', () => {
    const riskUsd = 2000;
    const entry = 50000;
    const stopLoss = 48000;
    const qty = computeFeeAwareQty({
      riskUsd, entry, stopLoss, feeEntry: MAKER_FEE,
    });
    const distance = Math.abs(entry - stopLoss);
    const totalLoss = qty * distance + qty * entry * MAKER_FEE + qty * stopLoss * TAKER_FEE;
    expect(totalLoss).toBeCloseTo(riskUsd, 6);
  });

  test('Maker qty > Taker qty for the same risk (lower fee → bigger position fits)', () => {
    const args = { riskUsd: 1000, entry: 50000, stopLoss: 49000 };
    const qtyMaker = computeFeeAwareQty({ ...args, feeEntry: MAKER_FEE });
    const qtyTaker = computeFeeAwareQty({ ...args, feeEntry: TAKER_FEE });
    expect(qtyMaker).toBeGreaterThan(qtyTaker);
  });

  test('zero distance returns 0 (no SL gap defined)', () => {
    expect(computeFeeAwareQty({
      riskUsd: 1000, entry: 50000, stopLoss: 50000, feeEntry: TAKER_FEE,
    })).toBe(0);
  });

  test('non-finite or non-positive inputs return 0', () => {
    expect(computeFeeAwareQty({ riskUsd: 0, entry: 1, stopLoss: 2, feeEntry: TAKER_FEE })).toBe(0);
    expect(computeFeeAwareQty({ riskUsd: 100, entry: NaN, stopLoss: 2, feeEntry: TAKER_FEE })).toBe(0);
    expect(computeFeeAwareQty({ riskUsd: -1, entry: 1, stopLoss: 2, feeEntry: TAKER_FEE })).toBe(0);
  });

  test('qty smaller than the naive (fee-naive) formula by exactly the fee cushion', () => {
    const riskUsd = 2000;
    const entry = 50000;
    const stopLoss = 48000;
    const distance = entry - stopLoss;
    const naiveQty = riskUsd / distance; // old behavior
    const feeAwareQty = computeFeeAwareQty({
      riskUsd, entry, stopLoss, feeEntry: TAKER_FEE,
    });
    expect(feeAwareQty).toBeLessThan(naiveQty);
    // Naive qty would have paid total_loss = riskUsd + entry_fee + sl_fee.
    // Fee-aware shrinks qty just enough so that those fees fit inside riskUsd.
    const overshoot = naiveQty * distance + naiveQty * entry * TAKER_FEE + naiveQty * stopLoss * TAKER_FEE;
    expect(overshoot).toBeGreaterThan(riskUsd);
  });
});

describe('effectiveRR — net reward / stated risk', () => {
  test('returns netReward / riskUsd given fee-aware qty', () => {
    const riskUsd = 1000;
    const entry = 100;
    const stopLoss = 95;
    const takeProfit = 110;
    const feeEntry = TAKER_FEE;
    const qty = computeFeeAwareQty({ riskUsd, entry, stopLoss, feeEntry });
    const rr = effectiveRR({ riskUsd, qty, entry, takeProfit, feeEntry });

    const grossReward = (takeProfit - entry) * qty;
    const entryFee = qty * entry * feeEntry;
    const tpFee = qty * takeProfit * TAKER_FEE;
    const expected = (grossReward - entryFee - tpFee) / riskUsd;
    expect(rr).toBeCloseTo(expected, 6);
  });

  test('rejects when TP set too close (effective R:R below profile min)', () => {
    const riskUsd = 1000;
    const entry = 100;
    const stopLoss = 95;
    const takeProfit = 100.05; // tiny reward
    const feeEntry = TAKER_FEE;
    const qty = computeFeeAwareQty({ riskUsd, entry, stopLoss, feeEntry });
    const rr = effectiveRR({ riskUsd, qty, entry, takeProfit, feeEntry });
    expect(rr).toBeLessThan(1);
  });

  test('zero qty or invalid TP returns 0', () => {
    expect(effectiveRR({ riskUsd: 1000, qty: 0, entry: 100, takeProfit: 110, feeEntry: TAKER_FEE })).toBe(0);
    expect(effectiveRR({ riskUsd: 1000, qty: 1, entry: 100, takeProfit: NaN, feeEntry: TAKER_FEE })).toBe(0);
  });
});

describe('Integration — fee-aware sizing keeps actual loss == stated risk', () => {
  test('user with $100K balance, 2% risk → total loss on SL is exactly $2000', () => {
    const balance = 100_000;
    const riskPct = 2;
    const riskUsd = (riskPct / 100) * balance;
    const entry = 50000;
    const stopLoss = 49500;

    const qty = computeFeeAwareQty({
      riskUsd, entry, stopLoss, feeEntry: TAKER_FEE,
    });

    const priceMoveLoss = qty * Math.abs(entry - stopLoss);
    const entryFee = qty * entry * TAKER_FEE;
    const slExitFee = qty * stopLoss * TAKER_FEE;
    const totalLoss = priceMoveLoss + entryFee + slExitFee;

    expect(totalLoss).toBeCloseTo(riskUsd, 4);
    expect(totalLoss).toBeCloseTo(2000, 4);
  });
});
