const AuditLog = require('../models/AuditLog');
const logger = require('./logger');

/**
 * Write an immutable audit log entry.
 * Fire-and-forget — never throws; failures are logged but never surface to callers.
 *
 * @param {object} opts
 * @param {string}   opts.event    - Audit event name (see AuditLog enum)
 * @param {string}  [opts.userId]  - MongoDB ObjectId string (null for unauthenticated events)
 * @param {object}  [opts.metadata] - Safe context fields (no secrets)
 * @param {object}  [opts.req]     - Express request (for IP + userAgent extraction)
 */
async function writeAuditLog({ event, userId = null, metadata = {}, req = null }) {
  try {
    const ipAddress = req
      ? (req.ip || req.headers['x-forwarded-for'] || null)
      : null;
    const userAgent = req ? (req.headers['user-agent'] || null) : null;

    await AuditLog.create({ event, userId, metadata, ipAddress, userAgent });
  } catch (err) {
    // Audit write failure must never crash the main request
    logger.error('audit write failed', err);
  }
}

module.exports = { writeAuditLog };
