/**
 * Redis client singleton.
 *
 * Exports a lazy-initialised Redis connection.  If Redis is unreachable the
 * client emits 'error' events which are logged — callers should treat it as
 * unavailable and fall back to a direct DB lookup (no crash).
 *
 * Environment variables:
 *   REDIS_URL  — full connection string, e.g. redis://127.0.0.1:6379
 *                Defaults to redis://127.0.0.1:6379 when absent.
 */
const { createClient } = require('redis');
const logger = require('../utils/logger');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

let client = null;
let connectionPromise = null;

/**
 * Returns a connected Redis client.
 * If Redis is not available, returns null (callers must handle this).
 */
async function getRedisClient() {
  if (client && client.isReady) return client;

  // Avoid multiple concurrent connection attempts
  if (connectionPromise) return connectionPromise;

  connectionPromise = (async () => {
    try {
      client = createClient({
        url: REDIS_URL,
        socket: {
          connectTimeout: 500, // 500ms max to establish connection
          reconnectStrategy: false // Do not retry infinitely if Redis is down
        }
      });

      client.on('error', (err) => {
        logger.warn('Redis client error — falling back to in-memory', { code: err.code });
      });

      client.on('reconnecting', () => {
        logger.info('Redis reconnecting');
      });

      await client.connect();
      logger.info('Redis connected', { url: REDIS_URL.replace(/\/\/.*@/, '//***@') });
      return client;
    } catch (err) {
      logger.warn('Redis unavailable — credential cache will use in-memory fallback', { code: err.code });
      client = null;
      return null;
    } finally {
      connectionPromise = null;
    }
  })();

  return connectionPromise;
}

/**
 * Gracefully disconnect (call on process shutdown).
 */
async function disconnectRedis() {
  if (client) {
    try {
      await client.quit();
    } catch { /* best effort */ }
    client = null;
  }
}

module.exports = { getRedisClient, disconnectRedis };
