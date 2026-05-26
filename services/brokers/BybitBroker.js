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

// Per-symbol fee overrides for cases where /v5/account/fee-rate doesn't
// return useful data — primarily Bybit demo (api-demo.bybit.com), which
// rejects the endpoint with retCode 10001 + empty retMsg. Values seeded from
// empirical paid-fee data on actual fills, not from documentation (Bybit's
// public fee table doesn't disclose the gold-specific rate).
//   - XAUUSDT taker = 0.028%  →  observed on 2026-05-26 XAUUSDT fills
//   - Crypto perps fall through to BybitBroker.feeRates() (maker 0.02% / taker 0.055%)
const BYBIT_SYMBOL_FEE_OVERRIDES = {
  XAUUSDT: { maker: 0.0001, taker: 0.00028 },
  XAGUSDT: { maker: 0.0001, taker: 0.00028 },
};

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
    // Accept payload as either a pre-formatted query string (legacy callers)
    // OR a plain object (preferred). Object → URLSearchParams. JavaScript
    // coercing an object straight into the signature string produced
    // "[object Object]" and Bybit rejected with retCode 10004 (signature
    // error). New callers should pass objects; old string callers still work.
    const toQs = (p) => {
      if (!p) return '';
      if (typeof p === 'string') return p;
      return new URLSearchParams(p).toString();
    };
    const queryString = isGet ? toQs(payload) : '';
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

  /**
   * Per-symbol fee rate for THIS user. Bybit returns different rates for
   * different symbol classes — XAUUSDT is roughly 0.028% taker vs 0.055%
   * for crypto perps — and the user's VIP tier discounts on top.
   * Single hardcoded constant in the sizer leaves money on the table on
   * tight-SL gold/forex-perp setups; this fetches the real rate.
   */
  async getFeeRatesForSymbol(ctx, symbol) {
    try {
      // Try with the symbol filter first. Some account configurations reject
      // the symbol param with retCode 10001 — in that case we retry with just
      // category=linear (returns the whole list, we pick our symbol).
      let r = await this._signedRequest(
        ctx, 'GET', '/v5/account/fee-rate', 'Get Fee Rate',
        { category: 'linear', symbol }
      ).catch(err => ({ _err: err }));
      if (r?._err || (r?.retCode && r.retCode !== 0)) {
        logger.info('[Bybit] fee-rate with symbol failed, retrying without symbol filter', {
          symbol, firstRetCode: r?.retCode, firstRetMsg: r?.retMsg,
        });
        r = await this._signedRequest(
          ctx, 'GET', '/v5/account/fee-rate', 'Get Fee Rate (all)',
          { category: 'linear' }
        );
      }
      // Loud log — full raw response. Demo (api-demo.bybit.com) may not
      // support /v5/account/fee-rate at all; main (api.bybit.com) should.
      logger.info('[Bybit] fee-rate response RAW', {
        symbol,
        mode: ctx.mode,
        baseUrl: this._baseUrl(ctx.mode),
        full: r,
      });
      const list = r?.result?.list || [];
      const row = list.find(x => x.symbol === symbol) || list[0];
      if (row) {
        const maker = parseFloat(row.makerFeeRate);
        const taker = parseFloat(row.takerFeeRate);
        if (Number.isFinite(maker) && Number.isFinite(taker)) {
          return { maker, taker, _debug: { source: 'bybit /v5/account/fee-rate', raw: row } };
        }
      }
      // API didn't return usable rates — fall through to override map.
      const override = BYBIT_SYMBOL_FEE_OVERRIDES[symbol];
      if (override) {
        return { ...override, _debug: { source: 'override map (demo /fee-rate unsupported)', raw: r } };
      }
      return { ...BybitBroker.feeRates(), _debug: { source: 'static defaults', raw: r } };
    } catch (err) {
      logger.warn('[Bybit] getFeeRatesForSymbol failed', { symbol, message: err?.message });
      const override = BYBIT_SYMBOL_FEE_OVERRIDES[symbol];
      if (override) return { ...override, _debug: { source: 'override map (request error)', message: err?.message } };
      return { ...BybitBroker.feeRates(), _debug: { reason: 'request error', message: err?.message } };
    }
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
