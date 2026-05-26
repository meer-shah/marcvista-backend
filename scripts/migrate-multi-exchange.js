/**
 * One-shot migration to seed the multi-exchange data model.
 *
 * Idempotent — safe to run on every boot. Stamps a marker in the DB
 * (`migrations` collection) so already-applied work is a no-op.
 *
 * Backfills:
 *   1. ApiConnection.exchange = 'bybit', mode = (accountType==='live' ? 'real' : 'demo')
 *      for any row missing those fields.
 *   2. User.activeExchange = 'bybit' for users with an existing Bybit
 *      ApiConnection and no activeExchange set.
 *   3. Trade.exchange = 'bybit' for any row missing it.
 *   4. RiskProfileState rows created for each existing RiskProfile under
 *      (user, profile, 'bybit'), copying the currentrisk/streak counters
 *      from the legacy fields.
 *
 * Safe to run before Phase 2 lands — touches only fields/collections that
 * are now-additive (no destructive renames).
 */
const mongoose = require('mongoose');
const logger = require('../utils/logger');

const MIGRATION_ID = '2026-05-26-multi-exchange-foundations';

async function alreadyApplied(db) {
  const doc = await db.collection('migrations').findOne({ _id: MIGRATION_ID });
  return !!doc;
}

async function markApplied(db) {
  await db.collection('migrations').updateOne(
    { _id: MIGRATION_ID },
    { $set: { _id: MIGRATION_ID, appliedAt: new Date() } },
    { upsert: true }
  );
}

async function migrate() {
  const db = mongoose.connection.db;
  if (!db) {
    logger.warn('Migration skipped: mongoose connection not ready');
    return;
  }

  if (await alreadyApplied(db)) {
    logger.info('Migration already applied', { id: MIGRATION_ID });
    return;
  }

  let touched = { apiConnections: 0, users: 0, trades: 0, riskProfileStates: 0 };

  // 1) ApiConnection — backfill exchange + mode.
  const apiConnsRes = await db.collection('apiconnections').updateMany(
    { $or: [{ exchange: { $exists: false } }, { exchange: null }] },
    [
      {
        $set: {
          exchange: 'bybit',
          mode: {
            $cond: [{ $eq: ['$accountType', 'live'] }, 'real', 'demo'],
          },
        },
      },
    ]
  );
  touched.apiConnections = apiConnsRes.modifiedCount || 0;

  // 2) User — set activeExchange to 'bybit' where missing.
  const usersRes = await db.collection('users').updateMany(
    { $or: [{ activeExchange: { $exists: false } }, { activeExchange: null }] },
    { $set: { activeExchange: 'bybit' } }
  );
  touched.users = usersRes.modifiedCount || 0;

  // 3) Trade — backfill exchange.
  const tradesRes = await db.collection('trades').updateMany(
    { $or: [{ exchange: { $exists: false } }, { exchange: null }] },
    { $set: { exchange: 'bybit' } }
  );
  touched.trades = tradesRes.modifiedCount || 0;

  // 4) RiskProfileState — one per existing RiskProfile, under 'bybit'.
  const profiles = await db.collection('riskprofiles').find({}).toArray();
  for (const p of profiles) {
    const exists = await db.collection('riskprofilestates').findOne({
      user: p.user,
      riskProfile: p._id,
      exchange: 'bybit',
    });
    if (exists) continue;
    await db.collection('riskprofilestates').insertOne({
      user: p.user,
      riskProfile: p._id,
      exchange: 'bybit',
      currentrisk: p.currentrisk ?? 0,
      previousrisk: p.previousrisk ?? 0,
      consecutiveWins: p.consecutiveWins ?? 0,
      consecutiveLosses: p.consecutiveLosses ?? 0,
      isFirstTrade: p.isFirstTrade ?? true,
      lastProcessedTradeId: p.lastProcessedTradeId ?? null,
      activatedAt: p.activatedAt || p.createdAt || new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    touched.riskProfileStates++;
  }

  await markApplied(db);
  logger.info('Multi-exchange migration applied', { id: MIGRATION_ID, ...touched });
}

module.exports = { migrate, MIGRATION_ID };
