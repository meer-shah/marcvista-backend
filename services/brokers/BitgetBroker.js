/**
 * BitgetBroker — IBroker for Bitget v2 USDT-margined futures.
 *
 * Endpoint reference: https://www.bitget.com/api-doc/contract/intro
 * Auth: HMAC-SHA256(base64) of `timestamp + method + requestPath + body` with
 *   secret. Headers: ACCESS-KEY / ACCESS-SIGN / ACCESS-TIMESTAMP / ACCESS-PASSPHRASE.
 *
 * Symbol format: native is e.g. `BTCUSDT` (v2). productType = USDT-FUTURES.
 *
 * Demo: pass `paptrading: 1` header — sandbox is server-side, same URL.
 * Requires a separate set of "paper trading" API keys generated in Bitget.
 */
const axios = require('axios');
const crypto = require('crypto');
const IBroker = require('./IBroker');
const { getExchangeCredentials } = require('../../config/credentials');
const logger = require('../../utils/logger');

const BASE = 'https://api.bitget.com';
const PRODUCT_TYPE = 'USDT-FUTURES';
const MARGIN_COIN = 'USDT';
const HTTP_TIMEOUT = 8000;

class BitgetBroker extends IBroker {
  static get id() { return 'bitget'; }
  static get label() { return 'Bitget USDT-M Futures'; }
  static get tvPrefix() { return 'BITGET'; }
  // VIP-0 futures fees: Maker 0.02% / Taker 0.06%.
  static feeRates() { return { maker: 0.0002, taker: 0.0006 }; }
  static toExchangeSymbol(canonical) { return canonical; }
  static toCanonicalSymbol(native) { return native; }

  _sign(timestamp, method, path, body, secret) {
    return crypto
      .createHmac('sha256', secret)
      .update(timestamp + method + path + body)
      .digest('base64');
  }

  async _signedRequest(ctx, method, path, info, payload) {
    const { apiKey, secret, passphrase } = await getExchangeCredentials(ctx.userId, 'bitget');
    if (!passphrase) throw new Error('Bitget requires a passphrase — re-enter your credentials.');
    const timestamp = Date.now().toString();
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
          'ACCESS-KEY': apiKey,
          'ACCESS-SIGN': sign,
          'ACCESS-TIMESTAMP': timestamp,
          'ACCESS-PASSPHRASE': passphrase,
          'Content-Type': 'application/json',
          'locale': 'en-US',
          ...(ctx.mode === 'demo' ? { paptrading: '1' } : {}),
        },
      });
      logger.info('bitget request succeeded', { info, method, path: fullPath, code: res.data?.code });
      return res.data;
    } catch (err) {
      const msg = err.response?.data?.msg || err.message;
      const code = err.response?.data?.code;
      logger.warn('[Bitget] Request failed', { info, method, path, code, message: msg });
      const wrapped = new Error(msg || 'Request failed');
      wrapped.bitgetCode = code;
      throw wrapped;
    }
  }

  async _publicGet(mode, path, info, params) {
    const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
    try {
      const res = await axios.get(BASE + path + queryString, {
        timeout: HTTP_TIMEOUT,
        headers: mode === 'demo' ? { paptrading: '1' } : {},
      });
      return res.data;
    } catch (err) {
      logger.warn('[Bitget] Public request failed', { info, path, message: err.message });
      throw err;
    }
  }

  // ── IBroker ───────────────────────────────────────────────────────────────
  async placeOrder(ctx, req) {
    const body = {
      symbol: req.symbol,
      productType: PRODUCT_TYPE,
      marginMode: 'crossed',
      marginCoin: MARGIN_COIN,
      size: String(req.qty),
      price: req.orderType === 'Limit' ? String(req.price) : undefined,
      side: req.side === 'Buy' ? 'buy' : 'sell',
      tradeSide: 'open',
      orderType: req.orderType === 'Limit' ? 'limit' : 'market',
      force: req.timeInForce === 'PostOnly' ? 'post_only' : 'gtc',
      clientOid: req.orderLinkId,
      presetStopSurplusPrice: req.takeProfit != null ? String(req.takeProfit) : undefined,
      presetStopLossPrice: req.stopLoss != null ? String(req.stopLoss) : undefined,
    };
    const r = await this._signedRequest(ctx, 'POST', '/api/v2/mix/order/place-order', 'Create Order', body);
    return {
      retCode: r?.code === '00000' ? 0 : Number(r?.code) || -1,
      retMsg: r?.msg || 'OK',
      result: { orderId: r?.data?.orderId, orderLinkId: r?.data?.clientOid },
      _raw: r,
    };
  }

  async cancelOrder(ctx, { symbol, orderLinkId, orderId }) {
    const body = { symbol, productType: PRODUCT_TYPE, marginCoin: MARGIN_COIN };
    if (orderId) body.orderId = orderId;
    else if (orderLinkId) body.clientOid = orderLinkId;
    const r = await this._signedRequest(ctx, 'POST', '/api/v2/mix/order/cancel-order', 'Cancel Order', body);
    return { retCode: r?.code === '00000' ? 0 : -1, retMsg: r?.msg || 'OK', _raw: r };
  }

  async amendOrder(ctx, req) {
    const body = {
      symbol: req.symbol,
      productType: PRODUCT_TYPE,
      orderId: req.orderId,
      newClientOid: req.orderLinkId,
      newPrice: req.price != null ? String(req.price) : undefined,
      newSize: req.qty != null ? String(req.qty) : undefined,
    };
    const r = await this._signedRequest(ctx, 'POST', '/api/v2/mix/order/modify-order', 'Amend Order', body);
    return { retCode: r?.code === '00000' ? 0 : -1, retMsg: r?.msg || 'OK', _raw: r };
  }

  async setLeverage(ctx, { symbol, buyLeverage }) {
    const body = {
      symbol, productType: PRODUCT_TYPE, marginCoin: MARGIN_COIN,
      leverage: String(buyLeverage),
    };
    const r = await this._signedRequest(ctx, 'POST', '/api/v2/mix/account/set-leverage', 'Set Leverage', body);
    return { retCode: r?.code === '00000' ? 0 : -1, retMsg: r?.msg || 'OK', _raw: r };
  }

  async switchMarginMode(ctx, { symbol, marginMode }) {
    const body = {
      symbol, productType: PRODUCT_TYPE, marginCoin: MARGIN_COIN,
      marginMode: marginMode === 'isolated' ? 'isolated' : 'crossed',
    };
    const r = await this._signedRequest(ctx, 'POST', '/api/v2/mix/account/set-margin-mode', 'Switch Margin Mode', body);
    return { retCode: r?.code === '00000' ? 0 : -1, retMsg: r?.msg || 'OK', _raw: r };
  }

  async getUsdtBalance(ctx) {
    const r = await this._signedRequest(ctx, 'GET', '/api/v2/mix/account/account', 'Get Balance', {
      symbol: 'BTCUSDT', productType: PRODUCT_TYPE, marginCoin: MARGIN_COIN,
    });
    const d = r?.data;
    return d ? parseFloat(d.available || d.equity || 0) || 0 : 0;
  }

  async getBalanceDetailed(ctx) {
    const raw = await this._signedRequest(ctx, 'GET', '/api/v2/mix/account/accounts', 'Get Balance', { productType: PRODUCT_TYPE });
    const balance = await this.getUsdtBalance(ctx);
    return { balance, raw };
  }

  async getPositions(ctx, symbol) {
    const params = { productType: PRODUCT_TYPE, marginCoin: MARGIN_COIN };
    if (symbol) params.symbol = symbol;
    const r = await this._signedRequest(ctx, 'GET', '/api/v2/mix/position/all-position', 'Get Positions', params);
    return (r?.data || [])
      .filter(p => parseFloat(p.total) > 0)
      .map(p => ({
        symbol: p.symbol,
        size: p.total,
        positionValue: String(parseFloat(p.total || 0) * parseFloat(p.openPriceAvg || 0)),
        avgEntryPrice: p.openPriceAvg,
        marketPrice: p.markPrice,
        unrealisedPnL: p.unrealizedPL,
        takeProfit: '',
        stopLoss: '',
        side: p.holdSide === 'long' ? 'Buy' : 'Sell',
        leverage: p.leverage,
        _raw: p,
      }));
  }

  async getPendingOrders(ctx) {
    const r = await this._signedRequest(ctx, 'GET', '/api/v2/mix/order/orders-pending', 'Get Pending Orders', { productType: PRODUCT_TYPE });
    return (r?.data?.entrustedList || []).map(o => ({
      _id: o.orderId,
      symbol: o.symbol,
      qty: o.size,
      quantity: o.size,
      price: o.price,
      side: o.side === 'buy' ? 'Buy' : 'Sell',
      type: o.orderType,
      status: o.state,
      stopLoss: o.presetStopLossPrice || '',
      takeProfit: o.presetStopSurplusPrice || '',
      createdAt: parseInt(o.cTime, 10),
      createdTime: o.cTime,
      orderLinkId: o.clientOid,
      _raw: o,
    }));
  }

  async getClosedPnl(ctx) {
    const r = await this._signedRequest(ctx, 'GET', '/api/v2/mix/position/history-position', 'Get Closed PnL', { productType: PRODUCT_TYPE });
    return (r?.data?.list || []).map(p => ({
      orderId: p.positionId,
      orderLinkId: '',
      execId: p.positionId,
      symbol: p.symbol,
      side: p.holdSide === 'long' ? 'Sell' : 'Buy', // closing side
      qty: p.closeTotalSize,
      avgEntryPrice: p.openAvgPrice,
      avgExitPrice: p.closeAvgPrice,
      closedPnl: p.pnl,
      cumExecFee: p.openFee && p.closeFee
        ? String(Math.abs(parseFloat(p.openFee)) + Math.abs(parseFloat(p.closeFee)))
        : '0',
      updatedTime: p.utime,
    }));
  }

  async getTicker(ctx, symbol) {
    const r = await this._publicGet(ctx.mode, '/api/v2/mix/market/ticker', 'Get Ticker', { productType: PRODUCT_TYPE, symbol });
    const t = r?.data?.[0];
    if (!t) return null;
    return { symbol, lastPrice: t.lastPr, bid1Size: t.bidSz, ask1Size: t.askSz };
  }

  async getInstrumentInfo(ctx, symbol) {
    const r = await this._publicGet(ctx.mode, '/api/v2/mix/market/contracts', 'Get Instrument Info', { productType: PRODUCT_TYPE, symbol });
    const it = r?.data?.[0];
    if (!it) return null;
    return {
      symbol,
      qtyStep: it.sizeMultiplier,
      priceStep: it.priceEndStep,
      minOrderQty: it.minTradeNum,
      leverageFilter: { maxLeverage: it.maxLever || '125' },
      _raw: it,
    };
  }

  async listSymbols(ctx) {
    const r = await this._publicGet(ctx.mode, '/api/v2/mix/market/contracts', 'List Symbols', { productType: PRODUCT_TYPE });
    return (r?.data || [])
      .filter(it => it.symbolStatus === 'normal' && it.quoteCoin === 'USDT')
      .map(it => it.symbol);
  }
}

module.exports = BitgetBroker;
