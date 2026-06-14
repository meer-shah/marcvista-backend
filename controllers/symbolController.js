const logger = require('../utils/logger');

/**
 * Resolve the broker + ctx for the user's currently-active exchange.
 * Now backed by the shared services/brokers/activeBroker helper; the custom
 * log label preserves this controller's original warning line.
 */
const { getActiveBrokerForUser } = require('../services/brokers/activeBroker');
const getActiveBroker = (req) => getActiveBrokerForUser(req, 'symbols: getActiveBroker failed');

/**
 * Tiny TTL + in-flight cache for exchange MARKET METADATA (symbol list,
 * instrument info). This data is user-independent — it only depends on
 * (exchange, mode) — and changes on the order of minutes/hours, so caching it
 * server-side collapses a ~1000-row exchange round-trip per request into one
 * shared fetch. Mirrors the inflight+TTL pattern in newsController.js.
 *
 * Only successful, non-empty results are cached; failures fall through so the
 * next request retries against the exchange. Transparent to callers.
 */
const SYMBOLS_TTL_MS = 10 * 60 * 1000;     // tradable-symbol set: new listings appear within ~10 min
const INSTRUMENT_TTL_MS = 60 * 60 * 1000;  // qtyStep / tickSize / maxLeverage: effectively static
const _cache = new Map();    // key -> { value, expiresAt }
const _inflight = new Map(); // key -> Promise

async function cachedFetch(key, ttlMs, producer) {
  const now = Date.now();
  const hit = _cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  const existing = _inflight.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const value = await producer();
    return value;
  })()
    .then((value) => {
      // Cache only meaningful results — never poison the cache with empty/null.
      const isEmpty = value == null || (Array.isArray(value) && value.length === 0);
      if (!isEmpty) _cache.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    })
    .finally(() => { _inflight.delete(key); });
  _inflight.set(key, promise);
  return promise;
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
    const sorted = await cachedFetch(
      `symbols:${ab.exchange}:${ab.ctx.mode}`,
      SYMBOLS_TTL_MS,
      async () => ((await ab.broker.listSymbols(ab.ctx)) || []).sort(),
    );
    res.status(200).json({
      success: true,
      data: sorted,
      count: sorted.length,
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
    const info = await cachedFetch(
      `instrument:${ab.exchange}:${ab.ctx.mode}:${symbol}`,
      INSTRUMENT_TTL_MS,
      () => ab.broker.getInstrumentInfo(ab.ctx, symbol),
    );
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
