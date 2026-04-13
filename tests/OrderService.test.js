/**
 * Unit tests for OrderService — verifies business logic without hitting
 * real Bybit APIs or MongoDB.
 *
 * Uses a mock broker that returns controlled responses.
 */

// ── Mock logger to prevent console noise during tests ───────────────────────
jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// ── Mock RiskProfile model ──────────────────────────────────────────────────
const mockRiskProfile = {
  user: 'user123',
  ison: true,
  minRiskRewardRatio: 1,
  consecutiveWins: 0,
  consecutiveLosses: 0,
  currentrisk: 0,
  previousrisk: 0,
  reset: 10000,
  save: jest.fn().mockResolvedValue(true),
};

jest.mock('../models/riskprofilemodal', () => ({
  findOne: jest.fn(),
}));

const RiskProfile = require('../models/riskprofilemodal');

// ── Mock broker (implements IBroker contract) ───────────────────────────────
class MockBroker {
  constructor() {
    this.placeOrder = jest.fn().mockResolvedValue({ retCode: 0, retMsg: 'OK' });
    this.cancelOrder = jest.fn().mockResolvedValue({ retCode: 0, retMsg: 'OK' });
    this.amendOrder = jest.fn().mockResolvedValue({ retCode: 0, retMsg: 'OK' });
    this.setLeverage = jest.fn().mockResolvedValue({ retCode: 0, retMsg: 'OK' });
    this.switchMarginMode = jest.fn().mockResolvedValue({ retCode: 0, retMsg: 'OK' });
    this.getBalance = jest.fn().mockResolvedValue({
      result: {
        list: [{
          coin: [{ coin: 'USDT', availableToWithdraw: '1000', walletBalance: '1000' }],
        }],
      },
    });
    this.getTicker = jest.fn().mockResolvedValue({ bid1Size: '0.01' });
  }
}

const OrderService = require('../services/OrderService');

describe('OrderService', () => {
  let service;
  let broker;

  beforeEach(() => {
    broker = new MockBroker();
    service = new OrderService(broker);
    jest.clearAllMocks();
  });

  // ────────────────────────────────────────────────────────────────────────────
  describe('simplePlaceOrder', () => {
    it('should place an order and return the result', async () => {
      const result = await service.simplePlaceOrder('user123', {
        symbol: 'BTCUSDT',
        side: 'Buy',
        category: 'linear',
        qty: '0.01',
        orderType: 'Limit',
        price: '50000',
      });

      expect(broker.placeOrder).toHaveBeenCalledTimes(1);
      expect(result.retCode).toBe(0);
    });

    it('should generate a unique orderLinkId', async () => {
      await service.simplePlaceOrder('user123', { symbol: 'BTCUSDT', side: 'Buy', category: 'linear', qty: '0.01', orderType: 'Limit', price: '50000' });
      const callArgs = broker.placeOrder.mock.calls[0][1];
      expect(callArgs.orderLinkId).toBeDefined();
      expect(callArgs.orderLinkId.length).toBe(32); // 16 bytes = 32 hex chars
    });

    it('should throw if Bybit returns non-zero retCode', async () => {
      broker.placeOrder.mockResolvedValue({ retCode: 10001, retMsg: 'Insufficient balance' });

      await expect(service.simplePlaceOrder('user123', {
        symbol: 'BTCUSDT', side: 'Buy', category: 'linear',
        qty: '0.01', orderType: 'Limit', price: '50000',
      })).rejects.toThrow('Failed to place order');
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  describe('placeOrderWithRiskProfile', () => {
    const validOrderData = {
      symbol: 'BTCUSDT',
      side: 'Buy',
      category: 'linear',
      orderType: 'Limit',
      price: 50000,
      takeProfit: 55000,
      stopLoss: 48000,
      adjustedRisk: 2,
      lastTradeResult: null,
    };

    beforeEach(() => {
      RiskProfile.findOne.mockResolvedValue({ ...mockRiskProfile, save: jest.fn().mockResolvedValue(true) });
    });

    it('should reject when no active risk profile exists', async () => {
      RiskProfile.findOne.mockResolvedValue(null);

      await expect(service.placeOrderWithRiskProfile('user123', validOrderData))
        .rejects.toThrow('No active risk profile found');
    });

    it('should reject when R:R ratio is below minimum', async () => {
      const badOrder = {
        ...validOrderData,
        takeProfit: 50100, // tiny profit
        stopLoss: 49000,   // large loss → bad R:R
      };

      // R:R = (50100 - 50000) / (50000 - 49000) = 0.1 < 1
      await expect(service.placeOrderWithRiskProfile('user123', badOrder))
        .rejects.toThrow('Risk-to-reward ratio');
    });

    it('should reject when adjustedRisk is not a number', async () => {
      const badOrder = { ...validOrderData, adjustedRisk: 'abc' };

      await expect(service.placeOrderWithRiskProfile('user123', badOrder))
        .rejects.toThrow('Invalid adjustedRisk');
    });

    it('should reject when USDT balance is zero', async () => {
      broker.getBalance.mockResolvedValue({
        result: { list: [{ coin: [{ coin: 'USDT', availableToWithdraw: '0', walletBalance: '0' }] }] },
      });

      await expect(service.placeOrderWithRiskProfile('user123', validOrderData))
        .rejects.toThrow('Insufficient USDT balance');
    });

    it('should calculate correct position size and place order', async () => {
      await service.placeOrderWithRiskProfile('user123', validOrderData);

      expect(broker.placeOrder).toHaveBeenCalledTimes(1);
      const orderPayload = broker.placeOrder.mock.calls[0][1];

      // riskPerUnit = |50000 - 48000| = 2000
      // riskAmount = (2 / 100) * 1000 = 20
      // qty = 20 / 2000 = 0.01
      expect(orderPayload.qty).toBe('0.01');
      expect(orderPayload.symbol).toBe('BTCUSDT');
      expect(orderPayload.timeInForce).toBe('GTC');
    });

    it('should reject invalid lastTradeResult', async () => {
      const badOrder = { ...validOrderData, lastTradeResult: 'Draw' };

      await expect(service.placeOrderWithRiskProfile('user123', badOrder))
        .rejects.toThrow('Invalid lastTradeResult');
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  describe('cancelOrder', () => {
    it('should cancel an order and roll back risk profile', async () => {
      const mockProfile = {
        currentrisk: 5,
        previousrisk: 3,
        consecutiveWins: 2,
        consecutiveLosses: 0,
        save: jest.fn().mockResolvedValue(true),
      };
      RiskProfile.findOne.mockResolvedValue(mockProfile);

      const result = await service.cancelOrder('user123', 'BTCUSDT', 'link123');
      expect(result.retCode).toBe(0);

      // Verify rollback was applied to the profile object
      expect(mockProfile.currentrisk).toBe(3);         // rolled back
      expect(mockProfile.consecutiveWins).toBe(1);     // decremented
      expect(mockProfile.save).toHaveBeenCalled();
    });

    it('should throw if Bybit cancel returns error', async () => {
      broker.cancelOrder.mockResolvedValue({ retCode: 10001, retMsg: 'Order not found' });

      await expect(service.cancelOrder('user123', 'BTCUSDT', 'link123'))
        .rejects.toThrow('Bybit cancel error');
    });
  });
});
