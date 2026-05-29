const { getBroker, getBrokerContext } = require('../services/brokers');
const logger = require('../utils/logger');

/**
 * Resolve the broker + ctx for the user's currently-active exchange.
 * Mirrors the helper in fetchinfo.js — duplicated here to avoid a cyclic
 * controller-to-controller import.
 */
async function getActiveBroker(req) {
  try {
    const User = require('../models/User');
    const user = await User.findById(req.user._id).select('activeExchange').lean();
    const exchange = user?.activeExchange || 'bybit';
    const broker = getBroker(exchange);
    const ctx = await getBrokerContext(req.user._id, exchange);
    return { broker, ctx, exchange };
  } catch (err) {
    logger.warn('symbols: getActiveBroker failed', { message: err?.message });
    return null;
  }
}

/**
 * List every tradable USDT-perpetual symbol for the user's ACTIVE exchange.
 * Each broker implements listSymbols(ctx) and returns canonical symbols
 * (BTCUSDT, ETHUSDT, …) — OKX/MEXC native formats are translated upstream.
 */
exports.getSymbols = async (req, res) => {
  try {
    const ab = await getActiveBroker(req);
    if (!ab) return res.status(401).json({ success: false, data: [], count: 0, error: 'No active exchange' });
    const symbols = await ab.broker.listSymbols(ab.ctx);
    res.status(200).json({
      success: true,
      data: (symbols || []).sort(),
      count: (symbols || []).length,
      source: ab.exchange,
    });
  } catch (error) {
    logger.error('Error fetching symbols', { message: error?.message });
    res.status(502).json({ success: false, data: [], count: 0, error: 'Failed to fetch symbols' });
  }
};

/**
 * Per-symbol instrument info (qty step, tick size, max leverage) from the
 * user's active exchange. Replaces the frontend's old direct-to-Bybit fetch
 * so the precision the UI uses matches whatever venue will execute the order.
 */
exports.getInstrumentInfo = async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase();
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const ab = await getActiveBroker(req);
    if (!ab) return res.status(401).json({ error: 'No active exchange' });
    const info = await ab.broker.getInstrumentInfo(ab.ctx, symbol);
    if (!info) return res.status(404).json({ error: 'Symbol not found on this exchange' });
    res.json({ ...info, exchange: ab.exchange });
  } catch (error) {
    logger.error('Error fetching instrument info', { message: error?.message });
    res.status(502).json({ error: 'Failed to fetch instrument info' });
  }
};

/**
 * Current ticker (lastPrice + book sizes) for a symbol on the user's active
 * exchange. Drives the "Live: $X" hint in PlaceOrder.
 */
exports.getTicker = async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase();
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const ab = await getActiveBroker(req);
    if (!ab) return res.status(401).json({ error: 'No active exchange' });
    const ticker = await ab.broker.getTicker(ab.ctx, symbol);
    if (!ticker) return res.status(404).json({ error: 'No ticker' });
    res.json({ ...ticker, exchange: ab.exchange });
  } catch (error) {
    logger.error('Error fetching ticker', { message: error?.message });
    res.status(502).json({ error: 'Failed to fetch ticker' });
  }
};

/**
 * Historical klines proxy for the user's active exchange. Only brokers that
 * implement getKlines (currently MEXC, whose public REST blocks browser CORS)
 * return data; others 501 so the frontend falls back to a direct fetch.
 */
exports.getKlines = async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase();
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const interval = String(req.query.interval || '').trim();
    if (!interval) return res.status(400).json({ error: 'interval required' });
    const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit, 10) || 500));
    const ab = await getActiveBroker(req);
    if (!ab) return res.status(401).json({ error: 'No active exchange' });
    if (typeof ab.broker.getKlines !== 'function') {
      return res.status(501).json({ error: `Klines proxy not implemented for ${ab.exchange}` });
    }
    const candles = await ab.broker.getKlines(ab.ctx, symbol, { interval, limit });
    res.json({ exchange: ab.exchange, symbol, interval, candles: candles || [] });
  } catch (error) {
    logger.error('Error fetching klines', { message: error?.message });
    res.status(502).json({ error: error?.message || 'Failed to fetch klines' });
  }
};
