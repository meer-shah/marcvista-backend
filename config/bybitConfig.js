const crypto = require('crypto');
const axios = require('axios');
const ApiConnection = require('../models/ApiConnection');
const { decrypt } = require('./encryption');
const logger = require('../utils/logger');

// ── Cache configuration ─────────────────────────────────────────────────────
// Single-process in-memory cache. Redis was removed because it was unreachable
// on our deploy target and every request was paying a reconnect penalty — the
// in-memory fallback already handled missed lookups, so Redis was pure overhead.
const CREDENTIAL_CACHE_DURATION_MS = 60 * 1000; // 60 seconds

const memoryCache = new Map(); // key -> { credentials, expiresAt }

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
 * Fetch API credentials from database with in-memory caching (user-specific).
 * Decrypts stored keys before returning them.
 */
async function getCredentials(userId) {
  const cacheKey = `cred:${userId || 'global'}`;
  const now = Date.now();

  const cached = memoryCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.credentials;
  }

  let connection;
  if (userId) {
    connection = await ApiConnection.findOne({ user: userId });
  } else {
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

  memoryCache.set(cacheKey, {
    credentials,
    expiresAt: now + CREDENTIAL_CACHE_DURATION_MS,
  });
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
      timeout: 8000,
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
 */
async function clearCredentialCache() {
  memoryCache.clear();
}

module.exports = {
  http_request,
  getCredentials,
  clearCredentialCache,
  getBaseUrl
};
