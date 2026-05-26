/**
 * credentials.js — multi-exchange credential lookup with in-memory cache.
 *
 * Replaces the single-(user → Bybit) lookup in bybitConfig with a generic
 * (user, exchange) lookup. Each broker calls `getExchangeCredentials(userId,
 * 'binance')` etc.; the broker is responsible for knowing what fields it
 * needs (apiKey, secret, passphrase).
 *
 * The legacy bybitConfig.getCredentials() still exists for the old code
 * paths and now delegates here for the bybit case.
 */
const ApiConnection = require('../models/ApiConnection');
const { decrypt } = require('./encryption');

const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX = 1000;
const cache = new Map(); // key -> { creds, expiresAt }

function cacheSet(key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function clearCache(userId, exchange) {
  if (!userId && !exchange) {
    cache.clear();
    return;
  }
  for (const key of [...cache.keys()]) {
    if (userId && exchange) {
      if (key === `${userId}:${exchange}`) cache.delete(key);
    } else if (userId) {
      if (key.startsWith(`${userId}:`)) cache.delete(key);
    } else {
      if (key.endsWith(`:${exchange}`)) cache.delete(key);
    }
  }
}

/**
 * Fetch decrypted credentials for (userId, exchange). Throws if not connected.
 * @returns {Promise<{apiKey:string, secret:string, passphrase:string|null, mode:'demo'|'real'}>}
 */
async function getExchangeCredentials(userId, exchange) {
  if (!userId) throw new Error('userId required for credential lookup');
  if (!exchange) throw new Error('exchange required for credential lookup');

  const key = `${userId}:${exchange}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    cache.delete(key);
    cache.set(key, hit); // refresh LRU
    return hit.creds;
  }

  const row = await ApiConnection.findOne({ user: userId, exchange });
  if (!row) {
    throw new Error(`No ${exchange} API credentials configured. Connect your ${exchange} account.`);
  }

  // Mode: prefer new `mode`, fall back to legacy `accountType`.
  let mode = row.mode || (row.accountType === 'live' ? 'real' : 'demo');
  if (mode !== 'real' && mode !== 'demo') mode = 'demo';

  const creds = {
    apiKey: decrypt(row.apiKey),
    secret: decrypt(row.secretKey),
    passphrase: row.passphrase ? decrypt(row.passphrase) : null,
    mode,
  };
  cacheSet(key, { creds, expiresAt: now + CACHE_TTL_MS });
  return creds;
}

/**
 * List the exchanges this user has credentials for, with mode.
 * Used by the connection page to render Connected / Not Connected.
 */
async function listConnectedExchanges(userId) {
  const rows = await ApiConnection.find({ user: userId }).select('exchange mode accountType updatedAt').lean();
  return rows.map(r => ({
    exchange: r.exchange || 'bybit',
    mode: r.mode || (r.accountType === 'live' ? 'real' : 'demo'),
    updatedAt: r.updatedAt,
  }));
}

module.exports = {
  getExchangeCredentials,
  listConnectedExchanges,
  clearCache,
};
