/**
 * IBroker — broker abstraction interface (dependency inversion for exchange layer).
 *
 * Any exchange adapter must implement all methods below.
 * Concrete implementation: services/BybitBroker.js
 *
 * All methods are async and resolve to the raw exchange response object,
 * or throw on failure.
 */

/**
 * @typedef {object} IBroker
 *
 * @property {(userId: string, orderData: object) => Promise<object>} placeOrder
 *   Place a new order on the exchange.
 *
 * @property {(userId: string, data: object) => Promise<object>} cancelOrder
 *   Cancel an existing order by orderLinkId / orderId.
 *
 * @property {(userId: string, data: object) => Promise<object>} amendOrder
 *   Amend an existing open order.
 *
 * @property {(userId: string, data: object) => Promise<object>} setLeverage
 *   Set buy/sell leverage for a symbol.
 *
 * @property {(userId: string, data: object) => Promise<object>} switchMarginMode
 *   Switch between isolated and cross margin mode.
 *
 * @property {(userId: string, queryParams: string) => Promise<object>} getBalance
 *   Fetch wallet balance. queryParams is a query string, e.g. "accountType=UNIFIED".
 *
 * @property {(symbol: string) => Promise<object>} getTicker
 *   Fetch linear ticker info for a symbol (public endpoint, no auth).
 */

module.exports = {}; // No runtime code — interface definition only
