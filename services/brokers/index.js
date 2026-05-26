/**
 * Broker factory + registry.
 *
 * Single place to look up a broker class or instance by exchange id.
 * Adding a new exchange = add the file + register here. OrderService and
 * controllers depend on this factory, never on a concrete broker.
 */
const BybitBroker = require('./BybitBroker');
const BinanceBroker = require('./BinanceBroker');
const OkxBroker = require('./OkxBroker');
const BitgetBroker = require('./BitgetBroker');
const MexcBroker = require('./MexcBroker');

const CLASSES = {
  bybit: BybitBroker,
  binance: BinanceBroker,
  okx: OkxBroker,
  bitget: BitgetBroker,
  mexc: MexcBroker,
};

// Broker instances are stateless apart from per-call ctx, so reuse one
// singleton per class. Reduces allocation per request.
const INSTANCES = {};

/**
 * Get a broker instance for an exchange id. Throws if unknown.
 * @param {'bybit'|'binance'|'okx'|'bitget'|'mexc'} exchange
 */
function getBroker(exchange) {
  const cls = CLASSES[exchange];
  if (!cls) throw new Error(`Unknown exchange: ${exchange}`);
  if (!INSTANCES[exchange]) INSTANCES[exchange] = new cls();
  return INSTANCES[exchange];
}

/**
 * Build an IBroker `ctx` object from a user document.
 * Requires that `getExchangeCredentials(userId, exchange)` was previously
 * verified — otherwise the broker will throw "No credentials" itself.
 * @returns {Promise<{userId:string, mode:'demo'|'real'}>}
 */
async function getBrokerContext(userId, exchange) {
  const { getExchangeCredentials } = require('../../config/credentials');
  const creds = await getExchangeCredentials(userId, exchange);
  return { userId: String(userId), mode: creds.mode };
}

/**
 * Static metadata for the UI (Connection page + exchange selector). Cheap —
 * pulls the class-level constants without instantiating.
 */
function listExchanges() {
  return Object.entries(CLASSES).map(([id, Cls]) => ({
    id,
    label: Cls.label,
    tvPrefix: Cls.tvPrefix,
    feeRates: Cls.feeRates(),
  }));
}

module.exports = { getBroker, getBrokerContext, listExchanges, CLASSES };
