const crypto = require('crypto');
const axios = require('axios');
const ApiConnection = require('../models/ApiConnection');
const { decrypt } = require('./encryption');
const logger = require('../utils/logger');
const { getRedisClient } = require('./redisClient');

// ── Cache configuration ─────────────────────────────────────────────────────
const CREDENTIAL_CACHE_DURATION = 60; // seconds (used by both Redis TTL and in-memory)

// In-memory fallback — used only when Redis is unavailable
let memoryCache = {};
let memoryCacheTimestamp = {};

/**
 * Get Bybit API base URL from environment
 * Use BYBIT_ENV=production (default) or BYBIT_ENV=demo
 */
function getBaseUrl() {
  const env = process.env.BYBIT_ENV || 'production';
  if (env === 'demo') {
    return 'https://api-demo.bybit.com';
  }
  return 'https://api.bybit.com'; // production
}

/**
 * Fetch API credentials from database with caching (user-specific).
 * Decrypts stored keys before returning them.
 *
 * Cache priority: Redis → in-memory fallback → database.
 */
async function getCredentials(userId) {
  const cacheKey = `cred:${userId || 'global'}`;

  // ── 1. Try Redis ──────────────────────────────────────────────────────────
  try {
    const redis = await getRedisClient();
    if (redis) {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    }
  } catch {
    // Redis read failed — continue to fallback
  }

  // ── 2. Try in-memory fallback ─────────────────────────────────────────────
  const now = Date.now();
  if (memoryCache[cacheKey] && (now - (memoryCacheTimestamp[cacheKey] || 0)) < CREDENTIAL_CACHE_DURATION * 1000) {
    return memoryCache[cacheKey];
  }

  // ── 3. Fetch from database ────────────────────────────────────────────────
  let connection;
  if (userId) {
    connection = await ApiConnection.findOne({ user: userId });
  } else {
    // Fallback for backward compatibility (no userId provided)
    connection = await ApiConnection.findOne();
  }

  if (!connection) {
    throw new Error('No API credentials configured. Please connect your Bybit account.');
  }

  const credentials = {
    apiKey: decrypt(connection.apiKey),
    secret: decrypt(connection.secretKey),
    accountType: connection.accountType || 'demo'
  };

  // ── 4. Write-through: persist to Redis (best-effort) then in-memory ───────
  try {
    const redis = await getRedisClient();
    if (redis) {
      await redis.setEx(cacheKey, CREDENTIAL_CACHE_DURATION, JSON.stringify(credentials));
    }
  } catch {
    // Redis write failed — no-op, in-memory will cover us
  }

  memoryCache[cacheKey] = credentials;
  memoryCacheTimestamp[cacheKey] = now;
  return credentials;
}

/**
 * Core HTTP request function for Bybit API.
 * Automatically fetches credentials from database (user-specific if userId provided).
 */
async function http_request(endpoint, method, data, Info, userId = null) {
  try {
    const { apiKey, secret, accountType } = await getCredentials(userId);
    const baseUrl = accountType === 'live' ? 'https://api.bybit.com' : 'https://api-demo.bybit.com';

    const timestamp = Date.now().toString();
    let queryString = '';
    let body = '';

    // Prepare parameters based on method
    if (method === 'GET') {
      queryString = data;
    } else {
      body = JSON.stringify(data);
    }

    // Generate signature (Bybit V5: timestamp + apiKey + recvWindow + queryString + body)
    const recvWindow = '5000';
    const signString = timestamp + apiKey + recvWindow + queryString + body;
    const signature = crypto.createHmac('sha256', secret)
                            .update(signString)
                            .digest('hex');

    const fullUrl = baseUrl + endpoint + (queryString ? `?${queryString}` : '');

    const config = {
      method,
      url: fullUrl,
      headers: {
        'X-BAPI-SIGN': signature,
        'X-BAPI-API-KEY': apiKey,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': recvWindow,
        ...(method === 'POST' && { 'Content-Type': 'application/json' })
      },
      data: body
    };

    const response = await axios(config);
    logger.info('bybit request succeeded', {
      info: Info,
      method,
      endpoint,
      status: response.status,
      retCode: response.data?.retCode,
    });
    return response.data;
  } catch (error) {
    const errorMsg = error.response?.data || error.message;
    logger.warn('[Bybit] Request failed', {
      method,
      endpoint,
      status: error.response?.status,
      message: typeof errorMsg === 'string' ? errorMsg : errorMsg?.retMsg || 'Request failed',
    });
    throw new Error(errorMsg);
  }
}

/**
 * Clear credential cache (call after credentials are updated or deleted).
 * Flushes both Redis keys and in-memory fallback.
 */
async function clearCredentialCache() {
  // Flush in-memory
  memoryCache = {};
  memoryCacheTimestamp = {};

  // Flush Redis keys (best-effort)
  try {
    const redis = await getRedisClient();
    if (redis) {
      // Delete all credential keys
      const keys = await redis.keys('cred:*');
      if (keys.length > 0) {
        await redis.del(keys);
      }
    }
  } catch {
    // Redis flush failed — in-memory is already cleared
  }
}

module.exports = {
  http_request,
  getCredentials,
  clearCredentialCache,
  getBaseUrl
};
