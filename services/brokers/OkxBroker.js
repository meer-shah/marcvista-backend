/**
 * OkxBroker — IBroker for OKX USDT-margined perpetual swaps.
 *
 * Endpoint reference: https://www.okx.com/docs-v5
 * Auth: HMAC-SHA256(base64) of `timestamp + method + path + body` with
 *   secret. Headers: OK-ACCESS-KEY / OK-ACCESS-SIGN / OK-ACCESS-TIMESTAMP /
 *   OK-ACCESS-PASSPHRASE.
 *
 * Symbol format: native is e.g. `BTC-USDT-SWAP`; canonical is `BTCUSDT`.
 *
 * Demo trading: same base URL with header `x-simulated-trading: 1` and a
 * SEPARATE set of API keys generated under Demo Trading on OKX.
 */
const axios = require('axios');
const crypto = require('crypto');
const IBroker = require('./IBroker');
const { getExchangeCredentials } = require('../../config/credentials');
const logger = require('../../utils/logger');

const BASE = 'https://www.okx.com';
const HTTP_TIMEOUT = 8000;

class OkxBroker extends IBroker {
  static get id() { return 'okx'; }
  static get label() { return 'OKX Perpetual Swap'; }
  static get tvPrefix() { return 'OKX'; }
  // VIP-0 perpetual fees: Maker 0.02% / Taker 0.05%.
  static feeRates() { return { maker: 0.0002, taker: 0.0005 }; }
  static toExchangeSymbol(canonical) {
    if (canonical.includes('-')) return canonical;
    // Naive split — assumes USDT quote. Works for all linear USDT perps.
    return canonical.replace(/USDT$/, '-USDT-SWAP');
  }
  static toCanonicalSymbol(native) {
    return native.replace('-USDT-SWAP', 'USDT').replace('-USDT', 'USDT');
  }

  _sign(timestamp, method, path, body, secret) {
    return crypto
      .createHmac('sha256', secret)
      .update(timestamp + method + path + body)
      .digest('base64');
  }

  async _signedRequest(ctx, method, path, info, payload) {
    const { apiKey, secret, passphrase } = await getExchangeCredentials(ctx.userId, 'okx');
    if (!passphrase) throw new Error('OKX requires a passphrase — re-enter your credentials.');
    const timestamp = new Date().toISOString();
    const isGet = method === 'GET';
    const queryString = isGet && payload ? '?' + new URLSearchParams(payload).toString() : '';
    const body = !isGet && payload ? JSON.stringify(payload) : '';
    const fullPath = path + queryString;
    const sign = this._sign(timestamp, method, fullPath, body, secret);
    try {
      const res = await axios({
        method,
        url: BASE + fullPath,
        data: body || undefined,
        timeout: HTTP_TIMEOUT,
        headers: {
          'OK-ACCESS-KEY': apiKey,
          'OK-ACCESS-SIGN': sign,
          'OK-ACCESS-TIMESTAMP': timestamp,
          'OK-ACCESS-PASSPHRASE': passphrase,
          'Content-Type': 'application/json',
          ...(ctx.mode === 'demo' ? { 'x-simulated-trading': '1' } : {}),
        },
      });
      logger.info('okx request succeeded', { info, method, path: fullPath, code: res.data?.code });
      return res.data;
    } catch (err) {
      const msg = err.response?.data?.msg || err.message;
      const code = err.response?.data?.code;
      logger.warn('[OKX] Request failed', { info, method, path, code, message: msg });
      const wrapped = new Error(msg || 'Request failed');
      wrapped.okxCode = code;
      throw wrapped;
    }
  }

  async _publicGet(mode, path, info, params) {
    const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
    try {
      const res = await axios.get(BASE + path + queryString, {
        timeout: HTTP_TIMEOUT,
        headers: mode === 'demo' ? { 'x-simulated-trading': '1' } : {},
      });
      return res.data;
    } catch (err) {
      logger.warn('[OKX] Public request failed', { info, path, message: err.message });
      throw err;
    }
  }

  // ── IBroker ───────────────────────────────────────────────────────────────
  async placeOrder(ctx, req) {
    const instId = OkxBroker.toExchangeSymbol(req.symbol);
    const body = {
      instId,
      tdMode: 'cross',
      side: req.side === 'Buy' ? 'buy' : 'sell',
      ordType: req.orderType === 'Limit' ? 'limit' : 'market',
      sz: String(req.qty),
      px: req.orderType === 'Limit' ? String(req.price) : undefined,
      clOrdId: req.orderLinkId,
    };
    if (req.takeProfit != null) {
      body.tpTriggerPx = String(req.takeProfit);
      body.tpOrdPx = '-1'; // market
    }
    if (req.stopLoss != null) {
      body.slTriggerPx = String(req.stopLoss);
      body.slOrdPx = '-1';
    }
    const r = await this._signedRequest(ctx, 'POST', '/api/v5/trade/order', 'Create Order', body);
    const data0 = r?.data?.[0] || {};
    return {
      retCode: data0.sCode === '0' ? 0 : Number(data0.sCode) || -1,
      retMsg: data0.sMsg || r?.msg || 'OK',
      result: { orderId: data0.ordId, orderLinkId: data0.clOrdId },
      _raw: r,
    };
  }

  async cancelOrder(ctx, { symbol, orderLinkId, orderId }) {
    const body = { instId: OkxBroker.toExchangeSymbol(symbol) };
    if (orderId) body.ordId = orderId;
    else if (orderLinkId) body.clOrdId = orderLinkId;
    const r = await this._signedRequest(ctx, 'POST', '/api/v5/trade/cancel-order', 'Cancel Order', body);
    return { retCode: 0, retMsg: 'OK', _raw: r };
  }

  async amendOrder(ctx, req) {
    const body = {
      instId: OkxBroker.toExchangeSymbol(req.symbol),
      ordId: req.orderId,
      newSz: req.qty != null ? String(req.qty) : undefined,
      newPx: req.price != null ? String(req.price) : undefined,
    };
    const r = await this._signedRequest(ctx, 'POST', '/api/v5/trade/amend-order', 'Amend Order', body);
    return { retCode: 0, retMsg: 'OK', _raw: r };
  }

  async setLeverage(ctx, { symbol, buyLeverage }) {
    const r = await this._signedRequest(ctx, 'POST', '/api/v5/account/set-leverage', 'Set Leverage', {
      instId: OkxBroker.toExchangeSymbol(symbol),
      lever: String(buyLeverage),
      mgnMode: 'cross',
    });
    return { retCode: 0, retMsg: 'OK', _raw: r };
  }

  async switchMarginMode(ctx, { symbol, marginMode }) {
    // OKX doesn't have a per-symbol switch; mgnMode is set via set-leverage.
    return this.setLeverage(ctx, { symbol, buyLeverage: 1 });
  }

  async getUsdtBalance(ctx) {
    const r = await this._signedRequest(ctx, 'GET', '/api/v5/account/balance', 'Get Balance', { ccy: 'USDT' });
    const usdt = r?.data?.[0]?.details?.find(d => d.ccy === 'USDT');
    return usdt ? parseFloat(usdt.availBal || usdt.cashBal || 0) || 0 : 0;
  }

  async getBalanceDetailed(ctx) {
    const raw = await this._signedRequest(ctx, 'GET', '/api/v5/account/balance', 'Get Balance');
    const balance = await this.getUsdtBalance(ctx);
    return { balance, raw };
  }

  async getPositions(ctx, symbol) {
    const params = { instType: 'SWAP' };
    if (symbol) params.instId = OkxBroker.toExchangeSymbol(symbol);
    const r = await this._signedRequest(ctx, 'GET', '/api/v5/account/positions', 'Get Positions', params);
    return (r?.data || [])
      .filter(p => parseFloat(p.pos) !== 0)
      .map(p => ({
        symbol: OkxBroker.toCanonicalSymbol(p.instId),
        size: p.pos,
        positionValue: p.notionalUsd,
        avgEntryPrice: p.avgPx,
        marketPrice: p.markPx,
        unrealisedPnL: p.upl,
        takeProfit: '',
        stopLoss: '',
        side: parseFloat(p.pos) > 0 ? 'Buy' : 'Sell',
        leverage: p.lever,
        _raw: p,
      }));
  }

  async getPendingOrders(ctx) {
    const r = await this._signedRequest(ctx, 'GET', '/api/v5/trade/orders-pending', 'Get Pending Orders', { instType: 'SWAP' });
    return (r?.data || []).map(o => ({
      _id: o.ordId,
      symbol: OkxBroker.toCanonicalSymbol(o.instId),
      qty: o.sz,
      quantity: o.sz,
      price: o.px,
      side: o.side === 'buy' ? 'Buy' : 'Sell',
      type: o.ordType,
      status: o.state,
      stopLoss: o.slTriggerPx || '',
      takeProfit: o.tpTriggerPx || '',
      createdAt: parseInt(o.cTime, 10),
      createdTime: o.cTime,
      orderLinkId: o.clOrdId,
      _raw: o,
    }));
  }

  async getClosedPnl(ctx) {
    const r = await this._signedRequest(ctx, 'GET', '/api/v5/account/positions-history', 'Get Closed PnL', { instType: 'SWAP', limit: '100' });
    return (r?.data || []).map(p => ({
      orderId: p.posId,
      orderLinkId: '',
      execId: p.posId,
      symbol: OkxBroker.toCanonicalSymbol(p.instId),
      side: p.posSide === 'long' ? 'Sell' : 'Buy', // closing side
      qty: p.closeTotalPos,
      avgEntryPrice: p.openAvgPx,
      avgExitPrice: p.closeAvgPx,
      closedPnl: p.realizedPnl,
      cumExecFee: p.fee || '0',
      updatedTime: p.uTime,
    }));
  }

  async getTicker(ctx, symbol) {
    const instId = OkxBroker.toExchangeSymbol(symbol);
    const r = await this._publicGet(ctx.mode, '/api/v5/market/ticker', 'Get Ticker', { instId });
    const t = r?.data?.[0];
    if (!t) return null;
    return {
      symbol,
      lastPrice: t.last,
      bid1Size: t.bidSz,
      ask1Size: t.askSz,
    };
  }

  async getInstrumentInfo(ctx, symbol) {
    const instId = OkxBroker.toExchangeSymbol(symbol);
    const r = await this._publicGet(ctx.mode, '/api/v5/public/instruments', 'Get Instrument Info', { instType: 'SWAP', instId });
    const it = r?.data?.[0];
    if (!it) return null;
    return {
      symbol,
      qtyStep: it.lotSz,
      priceStep: it.tickSz,
      minOrderQty: it.minSz,
      leverageFilter: { maxLeverage: it.lever || '100' },
      _raw: it,
    };
  }

  async listSymbols(ctx) {
    const r = await this._publicGet(ctx.mode, '/api/v5/public/instruments', 'List Symbols', { instType: 'SWAP' });
    return (r?.data || [])
      .filter(it => it.settleCcy === 'USDT' && it.state === 'live')
      .map(it => OkxBroker.toCanonicalSymbol(it.instId));
  }
}

module.exports = OkxBroker;
