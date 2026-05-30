/**
 * Idempotent migration: replace the legacy unique+sparse index on
 * trades.bybitClosedPnlId with a partial unique index (string values only).
 *
 * Why: a unique+sparse index still indexes documents whose field is
 * present-but-null, and bybitClosedPnlId defaults to null. Once any trade
 * holds null (e.g. a Cancelled trade), every new Pending insert collides on
 * the null key (E11000) and the Pending Trade row silently fails to persist —
 * the trade then never appears in the portfolio breakdown and the close sync
 * labels it 'external'. A partialFilterExpression scoped to string values
 * indexes only real closed-pnl ids and leaves null/absent values unconstrained.
 *
 * Self-healing: inspects the live index each boot and only acts when the
 * index is missing or still in the legacy (non-partial) form. Safe to run on
 * every startup.
 */
const mongoose = require('mongoose');
const logger = require('../utils/logger');

async function migrateTradeIndex() {
  const db = mongoose.connection.db;
  if (!db) {
    logger.warn('Trade index migration skipped: mongoose connection not ready');
    return;
  }
  const coll = db.collection('trades');

  let indexes;
  try {
    indexes = await coll.indexes();
  } catch (err) {
    logger.warn('Trade index migration: could not list indexes', { message: err?.message });
    return;
  }

  const existing = indexes.find(i => i.name === 'bybitClosedPnlId_1');
  const isPartial = !!(existing && existing.partialFilterExpression);
  if (isPartial) return; // already migrated — no-op

  // Drop the legacy sparse index if present.
  if (existing) {
    try {
      await coll.dropIndex('bybitClosedPnlId_1');
      logger.info('Dropped legacy sparse index trades.bybitClosedPnlId_1');
    } catch (err) {
      logger.warn('Could not drop legacy bybitClosedPnlId index', { message: err?.message });
    }
  }

  // Create the partial unique index (unique only for real string ids).
  try {
    await coll.createIndex(
      { bybitClosedPnlId: 1 },
      {
        unique: true,
        partialFilterExpression: { bybitClosedPnlId: { $type: 'string' } },
        name: 'bybitClosedPnlId_1',
      }
    );
    logger.info('Created partial unique index trades.bybitClosedPnlId_1');
  } catch (err) {
    logger.warn('Could not create partial bybitClosedPnlId index', { message: err?.message });
  }
}

module.exports = { migrateTradeIndex };
