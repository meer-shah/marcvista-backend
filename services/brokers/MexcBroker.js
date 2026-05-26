/**
 * MexcBroker — IBroker for MEXC contract (USDT-margined perpetual swap).
 *
 * Endpoint reference: https://mexcdevelop.github.io/apidocs/contract_v1_en/
 * Auth: signature = HMAC-SHA256(apiKey + timestamp + paramsString) with secret.
 *   Header `Signature`, `ApiKey`, `Request-Time`.
 *
 * Symbol format: native is e.g. `BTC_USDT`; canonical is `BTCUSDT`.
 *
 * Demo: contract sandbox at https://contract.mexc.com (some endpoints have a
 * `https://contract-testnet.mexc.com` mirror; KYC restrictions apply). We
 * route demo traffic to the testnet host when available.
 *
 * Caveat: MEXC contract requires a SEPARATE API key from spot, generated
 * at https://contract.mexc.com/account/api .
 */
const axios = require('axios');
const crypto = require('crypto');
const IBroker = require('./IBroker');
const { getExchangeCredentials } = require('../../config/credentials');
const logger = require('../../utils/logger');

const REAL_BASE = 'https://contract.mexc.com';
const DEMO_BASE = 'https://contract-testnet.mexc.com';
const HTTP_TIMEOUT = 8000;

class MexcBroker extends IBroker {
  static get id() { return 'mexc'; }
  static get label() { return 'MEXC Contract'; }
  static get tvPrefix() { return 'MEXC'; }
  // MEXC perpetual rates: Maker 0.00% / Taker 0.01% (promotional, but
  // standard for years now).
  static feeRates() { return { maker: 0.0, taker: 0.0001 }; }
  static toExchangeSymbol(canonical) {
    if (canonical.includes('_')) return canonical;
    return canonical.replace(/USDT$/, '_USDT');
  }
  static toCanonicalSymbol(native) { return native.replace('_', ''); }

  _baseUrl(mode) { return mode === 'real' ? REAL_BASE : DEMO_BASE; }

  _sign(apiKey, timestamp, paramsString, secret) {
    return crypto
      .createHmac('sha256', secret)
      .update(apiKey + timestamp + paramsString)
      .digest('hex');
  }

  async _signedRequest(ctx, method, path, info, payload) {
    const { apiKey, secret } = await getExchangeCredentials(ctx.userId, 'mexc');
    const timestamp = Date.now().toString();
    const isGet = method === 'GET';
    let paramsString = '';
    let url = this._baseUrl(ctx.mode) + path;
    let body;
    if (isGet) {
      paramsString = payload ? new URLSearchParams(payload).toString() : '';
      if (paramsString) url += '?' + paramsString;
    } else {
      paramsString = payload ? JSON.stringify(payload) : '';
      body = paramsString;
    }
    const sign = this._sign(apiKey, timestamp, paramsString, secret);
    try {
      const res = await axios({
        method, url, data: body, timeout: HTTP_TIMEOUT,
        headers: {
          ApiKey: apiKey,
          'Request-Time': timestamp,
          Signature: sign,
          'Content-Type': 'application/json',
        },
      });
      logger.info('mexc request succeeded', { info, method, path, code: res.data?.code });
      return res.data;
    } catch (err) {
      const msg = err.response?.data?.msg || err.message;
      const code = err.response?.data?.code;
      logger.warn('[MEXC] Request failed', { info, method, path, code, message: msg });
      const wrapped = new Error(msg || 'Request failed');
      wrapped.mexcCode = code;
      throw wrapped;
    }
  }

  async _publicGet(mode, path, info, params) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    try {
      const res = await axios.get(this._baseUrl(mode) + path + qs, { timeout: HTTP_TIMEOUT });
      return res.data;
    } catch (err) {
      logger.warn('[MEXC] Public request failed', { info, path, message: err.message });
      throw err;
    }
  }

  // ── IBroker ───────────────────────────────────────────────────────────────
  async placeOrder(ctx, req) {
    const symbol = MexcBroker.toExchangeSymbol(req.symbol);
    // MEXC contract order types: 1=limit, 5=market.
    // openType: 1=isolated, 2=cross. side: 1=open long, 2=close short, 3=open short, 4=close long.
    const side = req.side === 'Buy' ? 1 : 3;
    const body = {
      symbol,
      price: req.orderType === 'Limit' ? Number(req.price) : 0,
      vol: Number(req.qty),
      side,
      type: req.orderType === 'Limit' ? 1 : 5,
      openType: 2, // cross
      externalOid: req.orderLinkId,
      stopLossPrice: req.stopLoss != null ? Number(req.stopLoss) : undefined,
      takeProfitPrice: req.takeProfit != null ? Number(req.takeProfit) : undefined,
    };
    const r = await this._signedRequest(ctx, 'POST', '/api/v1/private/order/submit', 'Create Order', body);
    return {
      retCode: r?.code === 0 ? 0 : Number(r?.code) || -1,
      retMsg: r?.msg || 'OK',
      result: { orderId: String(r?.data || ''), orderLinkId: req.orderLinkId },
      _raw: r,
    };
  }

  async cancelOrder(ctx, { orderId }) {
    if (!orderId) throw new Error('MEXC cancel requires orderId');
    const r = await this._signedRequest(ctx, 'POST', '/api/v1/private/order/cancel', 'Cancel Order', [Number(orderId)]);
    return { retCode: r?.code === 0 ? 0 : -1, retMsg: r?.msg || 'OK', _raw: r };
  }

  async amendOrder(ctx, req) {
    const body = {
      orderId: Number(req.orderId),
      price: req.price != null ? Number(req.price) : undefined,
      vol: req.qty != null ? Number(req.qty) : undefined,
    };
    const r = await this._signedRequest(ctx, 'POST', '/api/v1/private/order/change_margin', 'Amend Order', body);
    return { retCode: 0, retMsg: 'OK', _raw: r };
  }

  async setLeverage(ctx, { symbol, buyLeverage }) {
    const body = {
      symbol: MexcBroker.toExchangeSymbol(symbol),
      leverage: Number(buyLeverage),
      openType: 2, // cross
    };
    const r = await this._signedRequest(ctx, 'POST', '/api/v1/private/position/change_leverage', 'Set Leverage', body);
    return { retCode: r?.code === 0 ? 0 : -1, retMsg: r?.msg || 'OK', _raw: r };
  }

  async switchMarginMode() {
    throw new Error('MEXC: margin mode is set on each order via openType (1 isolated / 2 cross).');
  }

  async getUsdtBalance(ctx) {
    const r = await this._signedRequest(ctx, 'GET', '/api/v1/private/account/asset/USDT', 'Get Balance');
    const d = r?.data;
    return d ? parseFloat(d.availableBalance || d.equity || 0) || 0 : 0;
  }

  async getBalanceDetailed(ctx) {
    const raw = await this._signedRequest(ctx, 'GET', '/api/v1/private/account/assets', 'Get Balance');
    const balance = await this.getUsdtBalance(ctx);
    return { balance, raw };
  }

  async getPositions(ctx, symbol) {
    const params = symbol ? { symbol: MexcBroker.toExchangeSymbol(symbol) } : undefined;
    const r = await this._signedRequest(ctx, 'GET', '/api/v1/private/position/open_positions', 'Get Positions', params);
    return (r?.data || [])
      .filter(p => parseFloat(p.holdVol) > 0)
      .map(p => ({
        symbol: MexcBroker.toCanonicalSymbol(p.symbol),
        size: String(p.holdVol),
        positionValue: String(parseFloat(p.holdVol) * parseFloat(p.holdAvgPrice || 0)),
        avgEntryPrice: String(p.holdAvgPrice),
        marketPrice: String(p.fairPrice || p.holdAvgPrice),
        unrealisedPnL: String(p.realisedProfit || 0),
        takeProfit: '',
        stopLoss: '',
        side: p.positionType === 1 ? 'Buy' : 'Sell',
        leverage: String(p.leverage),
        _raw: p,
      }));
  }

  async getPendingOrders(ctx) {
    const r = await this._signedRequest(ctx, 'GET', '/api/v1/private/order/list/open_orders', 'Get Pending Orders');
    return (r?.data || []).map(o => ({
      _id: String(o.orderId),
      symbol: MexcBroker.toCanonicalSymbol(o.symbol),
      qty: String(o.vol),
      quantity: String(o.vol),
      price: String(o.price),
      side: o.side === 1 || o.side === 4 ? 'Buy' : 'Sell',
      type: o.orderType === 1 ? 'Limit' : 'Market',
      status: String(o.state),
      stopLoss: '',
      takeProfit: '',
      createdAt: o.createTime,
      createdTime: String(o.createTime),
      orderLinkId: o.externalOid,
      _raw: o,
    }));
  }

  async getClosedPnl(ctx) {
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const r = await this._signedRequest(ctx, 'GET', '/api/v1/private/position/list/history_positions', 'Get Closed PnL', {
      start_time: since, page_num: 1, page_size: 100,
    });
    return (r?.data || []).map(p => ({
      orderId: String(p.positionId),
      orderLinkId: '',
      execId: String(p.positionId),
      symbol: MexcBroker.toCanonicalSymbol(p.symbol),
      side: p.positionType === 1 ? 'Sell' : 'Buy', // closing side
      qty: String(p.closeVol),
      avgEntryPrice: String(p.holdAvgPrice),
      avgExitPrice: String(p.closeAvgPrice),
      closedPnl: String(p.realised),
      cumExecFee: String((parseFloat(p.openFee || 0)) + (parseFloat(p.closeFee || 0))),
      updatedTime: String(p.updateTime),
    }));
  }

  async getTicker(ctx, symbol) {
    const native = MexcBroker.toExchangeSymbol(symbol);
    const r = await this._publicGet(ctx.mode, '/api/v1/contract/ticker', 'Get Ticker', { symbol: native });
    const t = r?.data;
    if (!t) return null;
    return { symbol, lastPrice: String(t.lastPrice), bid1Size: String(t.bid1Vol || ''), ask1Size: String(t.ask1Vol || '') };
  }

  async getInstrumentInfo(ctx, symbol) {
    const native = MexcBroker.toExchangeSymbol(symbol);
    const r = await this._publicGet(ctx.mode, '/api/v1/contract/detail', 'Get Instrument Info', { symbol: native });
    const it = r?.data;
    if (!it) return null;
    return {
      symbol,
      qtyStep: String(it.volUnit || it.minVol || 1),
      priceStep: String(it.priceUnit || 0.01),
      minOrderQty: String(it.minVol || 1),
      leverageFilter: { maxLeverage: String(it.maxLeverage || 100) },
      _raw: it,
    };
  }

  async listSymbols(ctx) {
    const r = await this._publicGet(ctx.mode, '/api/v1/contract/detail', 'List Symbols');
    return (r?.data || [])
      .filter(it => it.state === 0 && it.quoteCoin === 'USDT')
      .map(it => MexcBroker.toCanonicalSymbol(it.symbol));
  }
}

module.exports = MexcBroker;
