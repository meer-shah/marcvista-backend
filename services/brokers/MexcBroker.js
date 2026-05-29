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
    // MEXC contract has no edit-in-place endpoint for limit orders — the
    // closest match is cancel + re-submit. (The previous `change_margin` call
    // here was wrong: that endpoint adjusts position margin, not order price
    // or quantity.) Read existing order to preserve fields the caller didn't
    // touch, cancel it, then submit a new one with the merged values.
    if (!req.orderId) throw new Error('MEXC amendOrder requires orderId');
    let original = null;
    try {
      const lookup = await this._signedRequest(
        ctx, 'GET', '/api/v1/private/order/get', 'Get Order',
        { order_id: Number(req.orderId) }
      );
      original = lookup?.data || null;
    } catch { /* not fatal — fall back to whatever the caller supplied */ }

    await this.cancelOrder(ctx, { orderId: req.orderId });

    const resubmit = await this.placeOrder(ctx, {
      symbol: req.symbol || (original ? MexcBroker.toCanonicalSymbol(original.symbol) : undefined),
      side: req.side || (original?.side === 1 || original?.side === 4 ? 'Buy' : 'Sell'),
      qty: req.qty != null ? req.qty : original?.vol,
      price: req.price != null ? req.price : original?.price,
      orderType: req.orderType || (original?.orderType === 5 ? 'Market' : 'Limit'),
      orderLinkId: req.orderLinkId || original?.externalOid,
      stopLoss: req.stopLoss ?? original?.stopLossPrice,
      takeProfit: req.takeProfit ?? original?.takeProfitPrice,
    });
    return { retCode: resubmit.retCode, retMsg: resubmit.retMsg, result: resubmit.result, _raw: resubmit._raw };
  }

  async setLeverage(ctx, { symbol, buyLeverage, sellLeverage }) {
    // MEXC contract requires `positionType` (1=long, 2=short) on the
    // change_leverage endpoint when no existing position is being amended.
    // It also sets leverage PER DIRECTION, so to mirror Bybit/Binance's
    // "one call sets both" semantics we fire one request per side.
    const native = MexcBroker.toExchangeSymbol(symbol);
    const longLev = Number(buyLeverage);
    const shortLev = Number(sellLeverage ?? buyLeverage);
    const call = (positionType, leverage) => this._signedRequest(
      ctx, 'POST', '/api/v1/private/position/change_leverage', 'Set Leverage',
      { symbol: native, leverage, openType: 2, positionType }
    );
    const results = await Promise.allSettled([call(1, longLev), call(2, shortLev)]);

    // Treat "already at this leverage" responses as success — MEXC returns
    // these on a no-op change rather than erroring.
    const ok = (r) => r.status === 'fulfilled' && (r.value?.code === 0 || r.value?.success === true);
    const longOk = ok(results[0]);
    const shortOk = ok(results[1]);

    if (longOk && shortOk) {
      return { retCode: 0, retMsg: 'OK', _raw: results.map(r => r.value || r.reason) };
    }
    // Partial-failure path: one side applied, the other didn't. Tell the
    // user precisely which side failed AND that the OTHER side already
    // mutated, so they understand the account is in a split-leverage state
    // (and a retry would re-apply the successful side as a no-op + retry
    // the failed side — safe).
    const sideLabel = (i) => (i === 0 ? 'Long' : 'Short');
    const failure = results.find(r => !ok(r));
    const failureIdx = results.indexOf(failure);
    const successSide = sideLabel(1 - failureIdx);
    const failureSide = sideLabel(failureIdx);
    const rawMsg = failure?.value?.message || failure?.value?.msg ||
                   failure?.reason?.message || 'MEXC leverage change rejected';
    const partial = longOk || shortOk;
    const retMsg = partial
      ? `${failureSide} leverage failed (${rawMsg}). ${successSide} leverage already updated — your account is now split-leverage. Retry to align both sides.`
      : `MEXC leverage change rejected: ${rawMsg}`;
    return { retCode: -1, retMsg, _raw: results.map(r => r.value || r.reason) };
  }

  /**
   * Per-symbol fee rate. MEXC publishes maker/taker on the public contract
   * detail endpoint — same number every user sees (volume tiers apply but
   * the per-contract rate is the baseline). Avoids burning the rate-limited
   * private "fee details" endpoint on what's effectively static data.
   */
  async getFeeRatesForSymbol(ctx, symbol) {
    try {
      const native = MexcBroker.toExchangeSymbol(symbol);
      const r = await this._publicGet(ctx.mode, '/api/v1/contract/detail', 'Get Fee Rate', { symbol: native });
      const it = r?.data;
      const maker = parseFloat(it?.makerFeeRate);
      const taker = parseFloat(it?.takerFeeRate);
      if (!Number.isFinite(maker) || !Number.isFinite(taker)) return MexcBroker.feeRates();
      return { maker, taker };
    } catch (err) {
      logger.warn('[MEXC] getFeeRatesForSymbol failed', { symbol, message: err?.message });
      return MexcBroker.feeRates();
    }
  }

  async getLeverage(ctx, symbol) {
    try {
      const native = MexcBroker.toExchangeSymbol(symbol);
      const r = await this._signedRequest(
        ctx, 'GET', '/api/v1/private/position/leverage', 'Get Leverage',
        { symbol: native }
      );
      // MEXC returns an array with one entry per positionType (long, short).
      // Each entry: { leverage, openType, positionType, ... }. Cross mode
      // shares leverage across sides, so picking the first non-zero value
      // matches what the MEXC UI displays as "current leverage".
      const rows = Array.isArray(r?.data) ? r.data : (r?.data ? [r.data] : []);
      const lev = rows.map(row => Number(row?.leverage)).find(n => Number.isFinite(n) && n > 0);
      return Number.isFinite(lev) && lev > 0 ? lev : null;
    } catch {
      return null;
    }
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

  /**
   * Historical klines via MEXC's public contract API. MEXC blocks browser
   * CORS on this endpoint, so the frontend chart proxies through the backend.
   * `interval` is passed through in MEXC notation (Min1/Min5/Hour4/Day1/...).
   */
  async getKlines(ctx, symbol, { interval, limit = 500 } = {}) {
    const native = MexcBroker.toExchangeSymbol(symbol);
    const sec = mexcIntervalSeconds(interval);
    if (!sec) throw new Error(`Unsupported interval "${interval}"`);
    const nowSec = Math.floor(Date.now() / 1000);
    const startSec = Math.max(0, nowSec - sec * limit);
    const r = await this._publicGet(
      ctx.mode,
      `/api/v1/contract/kline/${native}`,
      'Get Klines',
      { interval, start: startSec, end: nowSec },
    );
    const d = r?.data;
    if (!d?.time?.length) return [];
    const out = [];
    for (let i = 0; i < d.time.length; i++) {
      const t = Number(d.time[i]);
      if (!Number.isFinite(t)) continue;
      out.push({
        t: t * 1000,
        o: parseFloat(d.open[i]),
        h: parseFloat(d.high[i]),
        l: parseFloat(d.low[i]),
        c: parseFloat(d.close[i]),
        v: parseFloat((d.vol?.[i] ?? d.amount?.[i] ?? 0).toString()),
      });
    }
    return out;
  }
}

function mexcIntervalSeconds(label) {
  switch (label) {
    case 'Min1': return 60;
    case 'Min5': return 300;
    case 'Min15': return 900;
    case 'Min30': return 1800;
    case 'Min60': return 3600;
    case 'Hour4': return 14400;
    case 'Hour8': return 28800;
    case 'Day1': return 86400;
    case 'Week1': return 604800;
    case 'Month1': return 2592000;
    default: return null;
  }
}

module.exports = MexcBroker;
