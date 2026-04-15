/**
 * BybitBroker — concrete implementation of IBroker for the Bybit V5 API.
 * See interfaces/IBroker.js for the full contract.
 *
 * All exchange I/O is isolated here. OrderService depends on this adapter
 * via constructor injection, making it easy to swap in a mock for tests.
 */
const axios = require('axios');
const { http_request, getBaseUrl } = require('../config/bybitConfig');

class BybitBroker {
  /**
   * Place a new order.
   * @param {string} userId
   * @param {object} orderData — Bybit-formatted order payload
   * @returns {Promise<object>} Bybit response
   */
  async placeOrder(userId, orderData) {
    return http_request('/v5/order/create', 'POST', orderData, 'Create Order', userId);
  }

  /**
   * Cancel an existing order.
   * @param {string} userId
   * @param {object} data — { category, symbol, orderLinkId }
   * @returns {Promise<object>} Bybit response
   */
  async cancelOrder(userId, data) {
    return http_request('/v5/order/cancel', 'POST', data, 'Cancel Order', userId);
  }

  /**
   * Amend an open order.
   * @param {string} userId
   * @param {object} data — Bybit amend payload
   * @returns {Promise<object>} Bybit response
   */
  async amendOrder(userId, data) {
    return http_request('/v5/order/amend', 'POST', data, 'Amend Order', userId);
  }

  /**
   * Set leverage for a symbol.
   * @param {string} userId
   * @param {object} data — { category, symbol, buyLeverage, sellLeverage }
   * @returns {Promise<object>} Bybit response
   */
  async setLeverage(userId, data) {
    return http_request('/v5/position/set-leverage', 'POST', data, 'Set Leverage', userId);
  }

  /**
   * Switch margin mode (isolated ↔ cross).
   * @param {string} userId
   * @param {object} data — Bybit switch-isolated payload
   * @returns {Promise<object>} Bybit response
   */
  async switchMarginMode(userId, data) {
    return http_request('/v5/position/switch-isolated', 'POST', data, 'Switch Margin Mode', userId);
  }

  /**
   * Fetch wallet balance.
   * @param {string} userId
   * @param {string} queryParams — e.g. "accountType=UNIFIED"
   * @returns {Promise<object>} Bybit response
   */
  async getBalance(userId, queryParams) {
    return http_request('/v5/account/wallet-balance', 'GET', queryParams, 'Get Balance', userId);
  }

  /**
   * Fetch public ticker info for a linear symbol (no auth needed).
   * @param {string} symbol
   * @returns {Promise<object|null>} ticker object or null if not found
   */
  async getTicker(symbol) {
    const baseUrl = getBaseUrl();
    const response = await axios.get(`${baseUrl}/v5/market/tickers?category=linear&symbol=${symbol}`, { timeout: 5000 });
    return response.data?.result?.list?.[0] || null;
  }
}

module.exports = BybitBroker;
