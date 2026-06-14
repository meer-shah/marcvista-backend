/**
 * Shared helper: resolve the broker + ctx for a request user's currently-active
 * exchange. Extracted from controllers/fetchinfo.js and controllers/symbolController.js,
 * which previously each kept a byte-for-byte copy of this logic.
 *
 * Tolerant of missing user / missing credentials — callers may treat a null
 * return as "show empty list" and surface a friendly error.
 */
const { getBroker, getBrokerContext } = require('./index');
const User = require('../../models/User');
const logger = require('../../utils/logger');

/**
 * @param {object} req       - Express request; must carry req.user._id.
 * @param {string} [logLabel] - Warning label used if resolution fails, so each
 *   caller keeps its original log line.
 * @returns {Promise<{broker, ctx, exchange}|null>}
 */
async function getActiveBrokerForUser(req, logLabel = 'getActiveBrokerForUser failed') {
  try {
    const user = await User.findById(req.user._id).select('activeExchange').lean();
    const exchange = user?.activeExchange || 'bybit';
    const broker = getBroker(exchange);
    const ctx = await getBrokerContext(req.user._id, exchange);
    return { broker, ctx, exchange };
  } catch (err) {
    logger.warn(logLabel, { message: err?.message });
    return null;
  }
}

module.exports = { getActiveBrokerForUser };
