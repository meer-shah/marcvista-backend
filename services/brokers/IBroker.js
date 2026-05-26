/**
 * IBroker — the contract every exchange adapter must satisfy.
 *
 * Pure JSDoc (no runtime class) so each broker stays a plain class that
 * implements these methods. OrderService and the controllers depend on this
 * shape, never on a concrete broker.
 *
 * Symbol convention: methods accept and return CANONICAL symbols (e.g.
 * `BTCUSDT`). Each broker translates to/from the exchange-native format
 * (`BTC-USDT-SWAP` for OKX, `BTCUSDT_UMCBL` for Bitget legacy, etc.) via
 * `toExchangeSymbol(canonical)` and `toCanonicalSymbol(native)`.
 *
 * Money convention: prices and qty are strings (preserve precision); fee
 * amounts and PnL are numbers (USD).
 *
 * @typedef {Object} OrderRequest
 * @property {string} symbol            - canonical (e.g. 'BTCUSDT')
 * @property {'Buy'|'Sell'} side
 * @property {'linear'} category
 * @property {string|number} qty
 * @property {'Limit'|'Market'} orderType
 * @property {string|number} price
 * @property {string|number} [stopLoss]
 * @property {string|number} [takeProfit]
 * @property {string} [orderLinkId]
 * @property {'GTC'|'IOC'|'FOK'|'PostOnly'} [timeInForce]
 *
 * @typedef {Object} OrderResult
 * @property {number} retCode           - 0 for success
 * @property {string} retMsg
 * @property {{orderId?: string, orderLinkId?: string}} [result]
 *
 * @typedef {Object} Position
 * @property {string} symbol            - canonical
 * @property {string} size
 * @property {string} positionValue
 * @property {string} avgEntryPrice
 * @property {string} marketPrice
 * @property {string} unrealisedPnL
 * @property {string} [takeProfit]
 * @property {string} [stopLoss]
 * @property {'Buy'|'Sell'} side
 * @property {string} [leverage]
 *
 * @typedef {Object} PendingOrder
 * @property {string} _id               - orderId from exchange
 * @property {string} symbol            - canonical
 * @property {string} qty
 * @property {string} price
 * @property {string} [stopLoss]
 * @property {string} [takeProfit]
 * @property {'Buy'|'Sell'} side
 * @property {string} type              - 'Limit' | 'Market' | etc
 * @property {string} status
 * @property {number} createdAt         - ms epoch
 * @property {string} [orderLinkId]
 *
 * @typedef {Object} ClosedPnlRow
 * @property {string} orderId
 * @property {string} [orderLinkId]
 * @property {string} [execId]
 * @property {string} symbol            - canonical
 * @property {'Buy'|'Sell'} side        - CLOSING side as reported by exchange
 * @property {string} qty
 * @property {string} avgEntryPrice
 * @property {string} avgExitPrice
 * @property {string} closedPnl
 * @property {string} cumExecFee
 * @property {string} updatedTime       - ms epoch as string
 *
 * @typedef {Object} Ticker
 * @property {string} symbol            - canonical
 * @property {string} lastPrice
 * @property {string} bid1Size
 * @property {string} ask1Size
 *
 * @typedef {Object} InstrumentInfo
 * @property {string} symbol            - canonical
 * @property {string} qtyStep           - precision step for qty
 * @property {string} priceStep         - tick size
 * @property {string} minOrderQty
 * @property {{maxLeverage: string}} leverageFilter
 *
 * @typedef {Object} FeeRates
 * @property {number} maker             - decimal (0.0002 = 0.02%)
 * @property {number} taker             - decimal (0.00055 = 0.055%)
 *
 * @typedef {'demo'|'real'} ExchangeMode
 *
 * @typedef {Object} BrokerContext
 * @property {string} userId
 * @property {ExchangeMode} mode
 *
 * Implementations MUST provide every method below. Methods that an exchange
 * cannot meaningfully provide (e.g. setLeverage on a fixed-leverage venue)
 * should throw a clearly-worded Error rather than silently no-op.
 */
class IBroker {
  /** @returns {string} canonical id, e.g. 'bybit' / 'binance' */
  static get id() { throw new Error('Not implemented: static id'); }

  /** @returns {string} human label, e.g. 'Bybit' / 'Binance USDT-M Futures' */
  static get label() { throw new Error('Not implemented: static label'); }

  /** @returns {FeeRates} USDT linear-perp Maker/Taker rates at VIP-0 */
  static feeRates() { throw new Error('Not implemented: static feeRates'); }

  /**
   * Per-symbol fee rate for THIS user — accounts for VIP tier, symbol class
   * discounts (Bybit XAUUSDT is ~0.028% taker vs ~0.055% for crypto perps),
   * and account-level promotions. Falls back to static feeRates() if the
   * broker hasn't implemented it.
   * @param {string} symbol canonical
   * @returns {Promise<FeeRates|null>}
   */
  async getFeeRatesForSymbol(ctx, symbol) {
    return this.constructor.feeRates ? this.constructor.feeRates() : null;
  }

  /** @param {'BTCUSDT'} canonical @returns {string} exchange-native */
  static toExchangeSymbol(canonical) { throw new Error('Not implemented'); }

  /** @param {string} native @returns {'BTCUSDT'} canonical */
  static toCanonicalSymbol(native) { throw new Error('Not implemented'); }

  /** @param {OrderRequest} req @returns {Promise<OrderResult>} */
  async placeOrder(ctx, req) { throw new Error('Not implemented: placeOrder'); }

  /** @returns {Promise<OrderResult>} */
  async cancelOrder(ctx, { symbol, orderLinkId, orderId }) { throw new Error('Not implemented: cancelOrder'); }

  /** @returns {Promise<OrderResult>} */
  async amendOrder(ctx, req) { throw new Error('Not implemented: amendOrder'); }

  /** @returns {Promise<number>} USDT balance (or equivalent quote) */
  async getUsdtBalance(ctx) { throw new Error('Not implemented: getUsdtBalance'); }

  /** @returns {Promise<{balance: number, raw: any}>} full balance payload for UI */
  async getBalanceDetailed(ctx) { throw new Error('Not implemented: getBalanceDetailed'); }

  /** @param {string} [symbol] canonical @returns {Promise<Position[]>} */
  async getPositions(ctx, symbol) { throw new Error('Not implemented: getPositions'); }

  /** @returns {Promise<PendingOrder[]>} */
  async getPendingOrders(ctx) { throw new Error('Not implemented: getPendingOrders'); }

  /** @returns {Promise<ClosedPnlRow[]>} */
  async getClosedPnl(ctx) { throw new Error('Not implemented: getClosedPnl'); }

  /** @param {string} symbol canonical @returns {Promise<Ticker|null>} */
  async getTicker(ctx, symbol) { throw new Error('Not implemented: getTicker'); }

  /** @param {string} symbol canonical @returns {Promise<InstrumentInfo|null>} */
  async getInstrumentInfo(ctx, symbol) { throw new Error('Not implemented: getInstrumentInfo'); }

  /** @returns {Promise<string[]>} canonical symbol list supported on this venue */
  async listSymbols(ctx) { throw new Error('Not implemented: listSymbols'); }

  /** @returns {Promise<OrderResult>} */
  async setLeverage(ctx, { symbol, buyLeverage, sellLeverage }) { throw new Error('Not implemented: setLeverage'); }

  /**
   * Read the user's CURRENT leverage setting for a symbol — independent of
   * whether a position is open. Returns null if the exchange doesn't expose
   * this info or the broker hasn't implemented it.
   * @param {string} symbol canonical
   * @returns {Promise<number|null>}
   */
  async getLeverage(ctx, symbol) { return null; }

  /** @returns {Promise<OrderResult>} */
  async switchMarginMode(ctx, req) { throw new Error('Not implemented: switchMarginMode'); }

  /**
   * TradingView chart symbol prefix used by the frontend, e.g. 'BYBIT' →
   * frontend renders `BYBIT:BTCUSDT.P`. Allows the chart to be swapped
   * per-exchange without server-side WS plumbing.
   * @returns {string}
   */
  static get tvPrefix() { throw new Error('Not implemented: static tvPrefix'); }
}

module.exports = IBroker;
