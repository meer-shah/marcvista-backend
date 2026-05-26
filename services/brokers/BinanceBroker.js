/**
 * BinanceBroker — IBroker for Binance USDT-M Futures (fapi).
 *
 * Endpoint reference: https://developers.binance.com/docs/derivatives/usds-margined-futures
 * Auth: HMAC-SHA256 of the URL-encoded params string. Header: X-MBX-APIKEY.
 *
 * Symbol format: native == canonical (e.g. BTCUSDT). No translation.
 *
 * Notes:
 * - Binance fapi takes order params as URL-encoded query, not JSON body.
 * - Stop loss / take profit are SEPARATE orders on Binance (no inline TP/SL
 *   on the entry). To match Bybit's "one entry with TP+SL" UX we place the
 *   entry then immediately submit a TAKE_PROFIT_MARKET and STOP_MARKET as
 *   `reduceOnly` triggers on the position. Same effect, three API calls.
 * - Demo: https://testnet.binancefuture.com (separate keys from production).
 */
const axios = require('axios');
const crypto = require('crypto');
const IBroker = require('./IBroker');
const { getExchangeCredentials } = require('../../config/credentials');
const logger = require('../../utils/logger');

const REAL_BASE = 'https://fapi.binance.com';
const DEMO_BASE = 'https://testnet.binancefuture.com';
const HTTP_TIMEOUT = 8000;
const RECV_WINDOW = 5000;

class BinanceBroker extends IBroker {
  static get id() { return 'binance'; }
  static get label() { return 'Binance USDT-M Futures'; }
  static get tvPrefix() { return 'BINANCE'; }
  // VIP-0 USDT-M fees: Maker 0.02% / Taker 0.05%. BNB discount -10%.
  static feeRates() { return { maker: 0.0002, taker: 0.0005 }; }
  static toExchangeSymbol(canonical) { return canonical; }
  static toCanonicalSymbol(native) { return native; }

  _baseUrl(mode) { return mode === 'real' ? REAL_BASE : DEMO_BASE; }

  _sign(params, secret) {
    const qs = new URLSearchParams(params).toString();
    const sig = crypto.createHmac('sha256', secret).update(qs).digest('hex');
    return `${qs}&signature=${sig}`;
  }

  async _signedRequest(ctx, method, path, info, params = {}) {
    const { apiKey, secret } = await getExchangeCredentials(ctx.userId, 'binance');
    const url = this._baseUrl(ctx.mode) + path;
    const allParams = { ...params, timestamp: Date.now(), recvWindow: RECV_WINDOW };
    const signed = this._sign(allParams, secret);
    try {
      const res = await axios({
        method,
        url: method === 'GET' || method === 'DELETE' ? `${url}?${signed}` : url,
        data: method === 'POST' || method === 'PUT' ? signed : undefined,
        timeout: HTTP_TIMEOUT,
        headers: {
          'X-MBX-APIKEY': apiKey,
          ...(method === 'POST' || method === 'PUT' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
      });
      logger.info('binance request succeeded', { info, method, path, status: res.status });
      return res.data;
    } catch (err) {
      const msg = err.response?.data?.msg || err.message;
      const code = err.response?.data?.code;
      logger.warn('[Binance] Request failed', { info, method, path, code, message: msg });
      const wrapped = new Error(msg || 'Request failed');
      wrapped.binanceCode = code;
      throw wrapped;
    }
  }

  async _publicGet(mode, path, params = {}, info) {
    const qs = new URLSearchParams(params).toString();
    const url = this._baseUrl(mode) + path + (qs ? `?${qs}` : '');
    try {
      const res = await axios.get(url, { timeout: HTTP_TIMEOUT });
      return res.data;
    } catch (err) {
      logger.warn('[Binance] Public request failed', { info, path, message: err.message });
      throw err;
    }
  }

  // ── IBroker ───────────────────────────────────────────────────────────────
  async placeOrder(ctx, req) {
    // 1) entry order
    const entryParams = {
      symbol: req.symbol,
      side: req.side === 'Buy' ? 'BUY' : 'SELL',
      type: req.orderType === 'Limit' ? 'LIMIT' : 'MARKET',
      quantity: String(req.qty),
      newClientOrderId: req.orderLinkId,
    };
    if (entryParams.type === 'LIMIT') {
      entryParams.price = String(req.price);
      entryParams.timeInForce = (req.timeInForce === 'PostOnly' ? 'GTX' : 'GTC');
    }
    const entry = await this._signedRequest(ctx, 'POST', '/fapi/v1/order', 'Create Order', entryParams);

    // Wrap into IBroker OrderResult shape similar to Bybit's
    const result = {
      retCode: 0,
      retMsg: 'OK',
      result: { orderId: String(entry.orderId), orderLinkId: entry.clientOrderId },
      _raw: entry,
    };

    // 2 & 3) Attach SL and TP as separate reduce-only triggers.
    //   Binance USDT-M doesn't store SL/TP inline on the entry — they're
    //   separate STOP_MARKET / TAKE_PROFIT_MARKET orders with closePosition.
    const closeSide = req.side === 'Buy' ? 'SELL' : 'BUY';
    const attachTrigger = async (label, type, price) => {
      try {
        await this._signedRequest(ctx, 'POST', '/fapi/v1/order', label, {
          symbol: req.symbol,
          side: closeSide,
          type,
          stopPrice: String(price),
          closePosition: 'true',
          workingType: 'MARK_PRICE',
          priceProtect: 'true',
        });
      } catch (err) {
        const msg = this._explainTriggerError(err);
        logger.warn(`[Binance] ${label} failed`, { message: msg, code: err.binanceCode });
        // Bubble up the actionable message — controller surfaces it to the
        // toast so the user knows they need to fix something on Binance.
        result._triggerWarning = (result._triggerWarning ? result._triggerWarning + ' | ' : '') + `${label}: ${msg}`;
      }
    };
    if (req.stopLoss != null) await attachTrigger('Create SL Trigger', 'STOP_MARKET', req.stopLoss);
    if (req.takeProfit != null) await attachTrigger('Create TP Trigger', 'TAKE_PROFIT_MARKET', req.takeProfit);
    return result;
  }

  _explainTriggerError(err) {
    const code = err?.binanceCode;
    if (code === -4120 || code === -4411) {
      return 'Binance testnet requires you to accept the TradFi-Perps agreement before SL/TP triggers can be placed. Log in to testnet.binancefuture.com, open a trade panel, accept the agreement, then re-place the order.';
    }
    if (code === -2019) return 'Insufficient margin for the SL/TP reserve. Fund your futures wallet or reduce size.';
    if (code === -2027) return 'Position would exceed max notional. Reduce size or leverage.';
    return err?.message || 'Trigger order failed.';
  }

  async cancelOrder(ctx, { symbol, orderLinkId, orderId }) {
    const params = { symbol };
    if (orderId) params.orderId = orderId;
    else if (orderLinkId) params.origClientOrderId = orderLinkId;
    else throw new Error('cancelOrder requires orderId or orderLinkId');
    const r = await this._signedRequest(ctx, 'DELETE', '/fapi/v1/order', 'Cancel Order', params);
    // Also cancel any orphan SL/TP triggers on this symbol that no longer
    // have an entry / position to close against. Cheap belt-and-braces:
    // fetch open orders for this symbol, drop any STOP_MARKET / TP_MARKET.
    try {
      const open = await this._signedRequest(ctx, 'GET', '/fapi/v1/openOrders', 'Get Open Orders (cleanup)', { symbol });
      const triggers = (open || []).filter(o =>
        o.type === 'STOP_MARKET' || o.type === 'TAKE_PROFIT_MARKET'
      );
      // Only drop triggers if no entry is left for this symbol — otherwise we'd
      // strip protection from a still-active leg.
      const stillHasEntry = (open || []).some(o =>
        o.type !== 'STOP_MARKET' && o.type !== 'TAKE_PROFIT_MARKET'
      );
      if (!stillHasEntry) {
        for (const t of triggers) {
          try {
            await this._signedRequest(ctx, 'DELETE', '/fapi/v1/order', 'Cancel Orphan Trigger', { symbol, orderId: t.orderId });
          } catch (err) {
            logger.warn('[Binance] Orphan trigger cancel failed', { orderId: t.orderId, message: err.message });
          }
        }
      }
    } catch { /* non-fatal */ }
    return { retCode: 0, retMsg: 'OK', _raw: r };
  }

  async amendOrder(ctx, req) {
    // Binance has /fapi/v1/order/modify but only for LIMIT orders' price/qty.
    const params = { symbol: req.symbol };
    if (req.orderId) params.orderId = req.orderId;
    else if (req.orderLinkId) params.origClientOrderId = req.orderLinkId;
    if (req.price != null) params.price = String(req.price);
    if (req.qty != null) params.quantity = String(req.qty);
    if (req.side) params.side = req.side === 'Buy' ? 'BUY' : 'SELL';
    const r = await this._signedRequest(ctx, 'PUT', '/fapi/v1/order', 'Amend Order', params);
    return { retCode: 0, retMsg: 'OK', _raw: r };
  }

  async setLeverage(ctx, { symbol, buyLeverage }) {
    const r = await this._signedRequest(ctx, 'POST', '/fapi/v1/leverage', 'Set Leverage', {
      symbol, leverage: Number(buyLeverage),
    });
    return { retCode: 0, retMsg: 'OK', _raw: r };
  }

  async switchMarginMode(ctx, { symbol, marginMode }) {
    const r = await this._signedRequest(ctx, 'POST', '/fapi/v1/marginType', 'Switch Margin Mode', {
      symbol, marginType: marginMode === 'isolated' ? 'ISOLATED' : 'CROSSED',
    });
    return { retCode: 0, retMsg: 'OK', _raw: r };
  }

  async getUsdtBalance(ctx) {
    const r = await this._signedRequest(ctx, 'GET', '/fapi/v2/balance', 'Get Balance');
    const usdt = (r || []).find(b => b.asset === 'USDT');
    return usdt ? parseFloat(usdt.availableBalance || usdt.balance || 0) || 0 : 0;
  }

  async getBalanceDetailed(ctx) {
    const raw = await this._signedRequest(ctx, 'GET', '/fapi/v2/balance', 'Get Balance');
    const balance = await this.getUsdtBalance(ctx);
    return { balance, raw };
  }

  async getPositions(ctx, symbol) {
    const params = symbol ? { symbol } : {};
    const r = await this._signedRequest(ctx, 'GET', '/fapi/v2/positionRisk', 'Get Positions', params);
    return (r || [])
      .filter(p => parseFloat(p.positionAmt) !== 0)
      .map(p => {
        const size = Math.abs(parseFloat(p.positionAmt));
        return {
          symbol: p.symbol,
          size: String(size),
          positionValue: String(size * parseFloat(p.entryPrice || 0)),
          avgEntryPrice: p.entryPrice,
          marketPrice: p.markPrice,
          unrealisedPnL: p.unRealizedProfit,
          side: parseFloat(p.positionAmt) > 0 ? 'Buy' : 'Sell',
          leverage: p.leverage,
          takeProfit: '',
          stopLoss: '',
          _raw: p,
        };
      });
  }

  async getPendingOrders(ctx) {
    const r = await this._signedRequest(ctx, 'GET', '/fapi/v1/openOrders', 'Get Pending Orders');
    const all = r || [];
    // Index SL/TP trigger orders by (symbol, opposite-side) so we can attach
    // their stopPrice onto the matching entry order's row. Binance keeps
    // these as separate orders; the UI wants them shown as inline SL/TP.
    const triggers = { stop: new Map(), tp: new Map() }; // key = "symbol|side"
    for (const o of all) {
      if (o.type === 'STOP_MARKET') {
        triggers.stop.set(`${o.symbol}|${o.side}`, o.stopPrice);
      } else if (o.type === 'TAKE_PROFIT_MARKET') {
        triggers.tp.set(`${o.symbol}|${o.side}`, o.stopPrice);
      }
    }
    return all
      .filter(o => !['STOP_MARKET', 'TAKE_PROFIT_MARKET', 'TRAILING_STOP_MARKET'].includes(o.type))
      .map(o => {
        const closeSide = o.side === 'BUY' ? 'SELL' : 'BUY';
        const key = `${o.symbol}|${closeSide}`;
        return {
          _id: String(o.orderId),
          symbol: o.symbol,
          qty: o.origQty,
          quantity: o.origQty,
          price: o.price,
          side: o.side === 'BUY' ? 'Buy' : 'Sell',
          type: o.type,
          status: o.status,
          stopLoss: triggers.stop.get(key) || '',
          takeProfit: triggers.tp.get(key) || '',
          createdAt: o.time,
          createdTime: String(o.time),
          orderLinkId: o.clientOrderId,
          _raw: o,
        };
      });
  }

  async getClosedPnl(ctx) {
    // Binance equivalent: GET /fapi/v1/userTrades (fill history) +
    // /fapi/v1/income (realized PnL ledger). For per-position closed PnL we
    // aggregate /fapi/v1/income with incomeType=REALIZED_PNL.
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7d window
    const r = await this._signedRequest(ctx, 'GET', '/fapi/v1/income', 'Get Closed PnL', {
      incomeType: 'REALIZED_PNL', limit: 1000, startTime: since,
    });
    // Map to IBroker ClosedPnlRow shape — best effort, the income endpoint
    // doesn't give us avgEntry/avgExit/qty directly, so those come back as ''.
    return (r || []).map(it => ({
      orderId: String(it.tradeId || it.tranId || ''),
      orderLinkId: '',
      execId: String(it.tradeId || ''),
      symbol: it.symbol,
      side: parseFloat(it.income) >= 0 ? 'Buy' : 'Sell', // unknown; inferOpeningSide on sync handles this
      qty: '',
      avgEntryPrice: '',
      avgExitPrice: '',
      closedPnl: String(it.income),
      cumExecFee: '0',
      updatedTime: String(it.time),
    }));
  }

  async getTicker(ctx, symbol) {
    const r = await this._publicGet(ctx.mode, '/fapi/v1/ticker/bookTicker', { symbol }, 'Get Ticker');
    if (!r) return null;
    return {
      symbol: r.symbol,
      lastPrice: r.bidPrice, // bookTicker doesn't have lastPrice; use bid as proxy
      bid1Size: r.bidQty,
      ask1Size: r.askQty,
    };
  }

  async getInstrumentInfo(ctx, symbol) {
    const r = await this._publicGet(ctx.mode, '/fapi/v1/exchangeInfo', {}, 'Get Instrument Info');
    const it = (r?.symbols || []).find(s => s.symbol === symbol);
    if (!it) return null;
    const lot = it.filters.find(f => f.filterType === 'LOT_SIZE');
    const price = it.filters.find(f => f.filterType === 'PRICE_FILTER');
    return {
      symbol: it.symbol,
      qtyStep: lot?.stepSize,
      priceStep: price?.tickSize,
      minOrderQty: lot?.minQty,
      // Binance leverage is set per-account, not on the symbol; surface a sane upper bound.
      leverageFilter: { maxLeverage: '125' },
      _raw: it,
    };
  }

  async listSymbols(ctx) {
    const r = await this._publicGet(ctx.mode, '/fapi/v1/exchangeInfo', {}, 'List Symbols');
    // Include BOTH crypto perpetuals AND Binance's TradFi-Perp listings
    // (XAUUSDT, XAGUSDT, TSLAUSDT, NVDAUSDT, etc.). Binance spells the
    // latter "TRADIFI_PERPETUAL" — note the typo, that's their actual value.
    // Excludes dated futures (CURRENT_QUARTER / NEXT_QUARTER) which we
    // don't trade.
    const acceptedTypes = new Set(['PERPETUAL', 'TRADIFI_PERPETUAL']);
    return (r?.symbols || [])
      .filter(s =>
        s.status === 'TRADING' &&
        s.quoteAsset === 'USDT' &&
        acceptedTypes.has(s.contractType)
      )
      .map(s => s.symbol);
  }
}

module.exports = BinanceBroker;
