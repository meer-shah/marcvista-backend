const axios = require('axios');
const { getBaseUrl } = require('../config/bybitConfig');
const logger = require('../utils/logger');

/**
 * Return every tradable linear (USDT-perpetual) symbol for the account.
 *
 * Bybit's V5 API unifies crypto derivatives and TradFi-backed perpetuals
 * (XAUUSDT, XAGUSDT, …) under `category=linear`, so this single call is
 * enough — we just surface whatever the exchange returns for this account.
 */
exports.getSymbols = async (req, res) => {
  try {
    const baseUrl = getBaseUrl();
    // Use the tickers endpoint as the source of truth for tradable linear
    // symbols: it consistently includes TradFi pairs (XAUUSDT, XAGUSDT,
    // XAUT…) that instruments-info sometimes omits by region.
    const response = await axios.get(`${baseUrl}/v5/market/tickers`, {
      params: { category: 'linear' },
      timeout: 10000,
    });

    if (response.data?.retCode !== 0 || !response.data?.result?.list) {
      throw new Error(`Invalid Bybit response: ${response.data?.retMsg || 'unknown'}`);
    }

    const symbols = response.data.result.list
      .filter(item => item.symbol && item.symbol.endsWith('USDT'))
      .map(item => item.symbol)
      .sort();

    res.status(200).json({
      success: true,
      data: symbols,
      count: symbols.length,
      source: 'bybit_api',
    });
  } catch (error) {
    logger.error('Error fetching symbols from Bybit', error);
    res.status(502).json({
      success: false,
      data: [],
      count: 0,
      error: 'Failed to fetch symbols from Bybit',
    });
  }
};
