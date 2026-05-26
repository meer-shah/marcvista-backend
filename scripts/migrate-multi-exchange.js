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

const MIGRATION_ID = '2026-05-26-multi-exchange-foundations-v3';

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

  // 5) Drop the legacy unique index on apiconnections.user — replaced by a
  // compound (user, exchange) unique. The Mongoose schema no longer declares
  // unique-on-user, but Mongo retains the old index until explicitly dropped.
  // Without this, inserting a SECOND exchange row for the same user fails.
  try {
    const indexes = await db.collection('apiconnections').indexes();
    for (const idx of indexes) {
      const keys = Object.keys(idx.key || {});
      if (idx.unique && keys.length === 1 && keys[0] === 'user') {
        await db.collection('apiconnections').dropIndex(idx.name);
        logger.info('Dropped legacy unique index on apiconnections.user', { name: idx.name });
      }
    }
  } catch (err) {
    logger.warn('Could not drop legacy apiconnections unique index', { message: err?.message });
  }

  // 6) Seed User.activeRiskProfileByExchange for the user's current active
  // exchange with whichever profile is currently ison=true. Without this,
  // the very first exchange switch on an existing account would have an
  // empty map and lose the user's selection.
  const users = await db.collection('users').find({}).toArray();
  let seeded = 0;
  for (const u of users) {
    const ex = u.activeExchange || 'bybit';
    const map = u.activeRiskProfileByExchange || {};
    if (map[ex]) continue; // already seeded
    const active = await db.collection('riskprofiles').findOne({ user: u._id, ison: true });
    if (!active) continue;
    await db.collection('users').updateOne(
      { _id: u._id },
      { $set: { [`activeRiskProfileByExchange.${ex}`]: active._id } }
    );
    seeded++;
  }
  touched.activeRiskProfileSeeded = seeded;

  await markApplied(db);
  logger.info('Multi-exchange migration applied', { id: MIGRATION_ID, ...touched });
}

module.exports = { migrate, MIGRATION_ID };
