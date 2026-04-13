const axios = require('axios');
const { getBaseUrl } = require('../config/bybitConfig');
const logger = require('../utils/logger');

exports.getSymbols = async (req, res) => {
  try {
    // Fetch all linear (USDT) trading pairs from Bybit
    const baseUrl = getBaseUrl();
    const response = await axios.get(`${baseUrl}/v5/market/instruments-info`, {
      params: {
        category: 'linear',  // USDT futures
      }
    });

    if (response.data?.retCode === 0 && response.data?.result?.list) {
      // Extract only USDT symbols
      const usdtSymbols = response.data.result.list
        .filter(item => item.symbol && item.symbol.endsWith('USDT'))
        .map(item => item.symbol)
        .sort(); // Sort alphabetically

      res.status(200).json({
        success: true,
        data: usdtSymbols,
        count: usdtSymbols.length,
        source: 'bybit_api'
      });
    } else {
      throw new Error('Invalid response from Bybit API');
    }
  } catch (error) {
    logger.error('Error fetching symbols from Bybit', error);
    // Fallback to static list if API fails
    const fallbackSymbols = [
      "BTCUSDT", "ETHUSDT", "BNBUSDT", "ADAUSDT", "DOTUSDT", "XRPUSDT", "SOLUSDT",
      "AVAXUSDT", "MATICUSDT", "LINKUSDT", "UNIUSDT", "DOGEUSDT", "SHIBUSDT",
      "LTCUSDT", "ATOMUSDT", "ETCUSDT", "XLMUSDT", "VETUSDT", "FILUSDT", "THETAUSDT",
      "XMRUSDT", "TRXUSDT", "XEMUSDT", "EOSUSDT", "BCHUSDT", "NEARUSDT", "APTUSDT",
      "ARBUSDT", "OPUSDT", "SUIUSDT", "PEPEUSDT", "FLOKIUSDT", "GMXUSDT", "GALAUSDT",
      "RUNEUSDT", "CVXUSDT", "1INCHUSDT", "BALUSDT", "ENJUSDT", "CHZUSDT", "MANAUSDT",
      "SANDUSDT", "AXSUSDT", "HIVEUSDT", "STEPUSDT", "BNTUSDT", "CRVUSDT", "EGLDUSDT",
      "KAVYUSDT", "KSMUSDT", "ZILUSDT", "ALGOUSDT", "ICXUSDT", "WAVESUSDT", "KNCUSDT",
      "FETUSDT", "OCEANUSDT", "RENUSDT", "SRMUSDT", "STMXUSDT", "ANTUSDT", "GTCUSDT",
    ];
    res.status(200).json({
      success: true,
      data: fallbackSymbols,
      count: fallbackSymbols.length,
      source: 'fallback',
      warning: 'Using fallback list, Bybit API unavailable'
    });
  }
};
