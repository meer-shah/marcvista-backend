/**
 * BybitBroker — IBroker implementation for Bybit V5 (USDT linear perpetuals).
 *
 * Endpoint reference: https://bybit-exchange.github.io/docs/v5
 *
 * Auth: HMAC-SHA256 of `timestamp + apiKey + recvWindow + queryString + body`
 * with the secret. Signature in `X-BAPI-SIGN`.
 *
 * Symbol format: native == canonical (`BTCUSDT`). No translation needed.
 *
 * This file does NOT use the existing `bybitConfig.http_request` helper —
 * that helper assumes a single (user → Bybit-only) credential row keyed by
 * `user`. Multi-exchange requires lookups by `(user, exchange='bybit')`, so
 * we inline a small auth helper here that uses the new credentials path.
 */
const axios = require('axios');
const crypto = require('crypto');
const IBroker = require('./IBroker');
const { getExchangeCredentials } = require('../../config/credentials');
const logger = require('../../utils/logger');

const REAL_BASE = 'https://api.bybit.com';
const DEMO_BASE = 'https://api-demo.bybit.com';
const RECV_WINDOW = '5000';
const HTTP_TIMEOUT = 8000;

class BybitBroker extends IBroker {
  static get id() { return 'bybit'; }
  static get label() { return 'Bybit'; }
  static get tvPrefix() { return 'BYBIT'; }
  static feeRates() { return { maker: 0.0002, taker: 0.00055 }; }
  static toExchangeSymbol(canonical) { return canonical; }
  static toCanonicalSymbol(native) { return native; }

  // ── HTTP helpers ──────────────────────────────────────────────────────────
  _baseUrl(mode) { return mode === 'real' ? REAL_BASE : DEMO_BASE; }

  async _signedRequest(ctx, method, endpoint, info, payload) {
    const { apiKey, secret } = await getExchangeCredentials(ctx.userId, 'bybit');
    const baseUrl = this._baseUrl(ctx.mode);
    const timestamp = Date.now().toString();
    const isGet = method === 'GET';
    const queryString = isGet ? (payload || '') : '';
    const body = isGet ? '' : JSON.stringify(payload || {});
    const sign = crypto
      .createHmac('sha256', secret)
      .update(timestamp + apiKey + RECV_WINDOW + queryString + body)
      .digest('hex');
    const url = baseUrl + endpoint + (queryString ? `?${queryString}` : '');
    try {
      const res = await axios({
        method, url, timeout: HTTP_TIMEOUT, data: body,
        headers: {
          'X-BAPI-SIGN': sign,
          'X-BAPI-API-KEY': apiKey,
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-RECV-WINDOW': RECV_WINDOW,
          ...(isGet ? {} : { 'Content-Type': 'application/json' }),
        },
      });
      logger.info('bybit request succeeded', { info, method, endpoint, status: res.status, retCode: res.data?.retCode });
      return res.data;
    } catch (err) {
      const raw = err.response?.data || err.message;
      const msg = typeof raw === 'string' ? raw : raw?.retMsg || 'Request failed';
      logger.warn('[Bybit] Request failed', { info, method, endpoint, status: err.response?.status, retCode: err.response?.data?.retCode, message: msg });
      const wrapped = new Error(msg);
      wrapped.bybitRetCode = err.response?.data?.retCode;
      throw wrapped;
    }
  }

  async _publicGet(mode, endpoint, queryString, info) {
    const url = this._baseUrl(mode) + endpoint + (queryString ? `?${queryString}` : '');
    try {
      const res = await axios.get(url, { timeout: HTTP_TIMEOUT });
      return res.data;
    } catch (err) {
      logger.warn('[Bybit] Public request failed', { info, endpoint, message: err.message });
      throw err;
    }
  }

  // ── IBroker implementation ────────────────────────────────────────────────
  async placeOrder(ctx, req) {
    const body = {
      symbol: req.symbol,
      side: req.side,
      category: req.category || 'linear',
      qty: String(req.qty),
      orderType: req.orderType,
      price: req.price != null ? String(req.price) : undefined,
      stopLoss: req.stopLoss != null ? String(req.stopLoss) : undefined,
      takeProfit: req.takeProfit != null ? String(req.takeProfit) : undefined,
      timeInForce: req.timeInForce || 'GTC',
      positionIdx: 0,
      orderLinkId: req.orderLinkId,
    };
    return this._signedRequest(ctx, 'POST', '/v5/order/create', 'Create Order', body);
  }

  async cancelOrder(ctx, { symbol, orderLinkId, orderId }) {
    return this._signedRequest(ctx, 'POST', '/v5/order/cancel', 'Cancel Order', {
      category: 'linear', symbol, orderLinkId, orderId,
    });
  }

  async amendOrder(ctx, req) {
    return this._signedRequest(ctx, 'POST', '/v5/order/amend', 'Amend Order', req);
  }

  async setLeverage(ctx, { symbol, buyLeverage, sellLeverage }) {
    return this._signedRequest(ctx, 'POST', '/v5/position/set-leverage', 'Set Leverage', {
      category: 'linear',
      symbol,
      buyLeverage: String(buyLeverage),
      sellLeverage: String(sellLeverage ?? buyLeverage),
    });
  }

  async switchMarginMode(ctx, req) {
    return this._signedRequest(ctx, 'POST', '/v5/position/switch-isolated', 'Switch Margin Mode', req);
  }

  async getUsdtBalance(ctx) {
    const r = await this._signedRequest(ctx, 'GET', '/v5/account/wallet-balance', 'Get Balance', 'accountType=UNIFIED');
    const list = r?.result?.list || [];
    let total = 0;
    for (const account of list) {
      for (const coin of account.coin || []) {
        if (coin.coin === 'USDT') {
          total += parseFloat(coin.availableToWithdraw || coin.walletBalance || 0) || 0;
        }
      }
    }
    return total;
  }

  async getBalanceDetailed(ctx) {
    const raw = await this._signedRequest(ctx, 'GET', '/v5/account/wallet-balance', 'Get Balance', 'accountType=UNIFIED');
    const balance = await this.getUsdtBalance(ctx);
    return { balance, raw };
  }

  async getPositions(ctx, symbol) {
    const q = `category=linear&settleCoin=USDT${symbol ? `&symbol=${symbol}` : ''}`;
    const r = await this._signedRequest(ctx, 'GET', '/v5/position/list', 'Get Positions', q);
    return (r?.result?.list || []).map(p => ({
      symbol: p.symbol,
      size: p.size,
      positionValue: p.positionValue,
      avgEntryPrice: p.avgPrice,
      marketPrice: p.markPrice,
      unrealisedPnL: p.unrealisedPnl,
      takeProfit: p.takeProfit || '',
      stopLoss: p.stopLoss || '',
      side: p.side,
      leverage: p.leverage,
      _raw: p,
    }));
  }

  async getPendingOrders(ctx) {
    const r = await this._signedRequest(
      ctx, 'GET', '/v5/order/realtime', 'Get Pending Orders',
      'category=linear&settleCoin=USDT&accountType=UNIFIED'
    );
    return (r?.result?.list || [])
      .filter(o => !o.stopOrderType) // exclude conditional / TP-SL records
      .map(o => ({
        _id: o.orderId,
        symbol: o.symbol,
        qty: o.qty,
        quantity: o.qty,
        price: o.price,
        stopLoss: o.stopLoss || '',
        takeProfit: o.takeProfit || '',
        side: o.side,
        type: o.orderType,
        status: o.orderStatus,
        createdAt: o.createdTime ? parseInt(o.createdTime, 10) : null,
        createdTime: o.createdTime,
        orderLinkId: o.orderLinkId,
        _raw: o,
      }));
  }

  async getClosedPnl(ctx) {
    const r = await this._signedRequest(ctx, 'GET', '/v5/position/closed-pnl', 'Get Closed PnL', 'category=linear');
    return r?.result?.list || [];
  }

  async getTicker(ctx, symbol) {
    const r = await this._publicGet(ctx.mode, '/v5/market/tickers', `category=linear&symbol=${symbol}`, 'Get Ticker');
    return r?.result?.list?.[0] || null;
  }

  async getInstrumentInfo(ctx, symbol) {
    const r = await this._publicGet(ctx.mode, '/v5/market/instruments-info', `category=linear&symbol=${symbol}`, 'Get Instrument Info');
    const it = r?.result?.list?.[0];
    if (!it) return null;
    return {
      symbol: it.symbol,
      qtyStep: it.lotSizeFilter?.qtyStep,
      priceStep: it.priceFilter?.tickSize,
      minOrderQty: it.lotSizeFilter?.minOrderQty,
      leverageFilter: { maxLeverage: it.leverageFilter?.maxLeverage },
      _raw: it,
    };
  }

  async listSymbols(ctx) {
    const r = await this._publicGet(ctx.mode, '/v5/market/instruments-info', 'category=linear&limit=1000', 'List Symbols');
    return (r?.result?.list || [])
      .filter(it => it.status === 'Trading' && it.quoteCoin === 'USDT')
      .map(it => it.symbol);
  }
}

module.exports = BybitBroker;
