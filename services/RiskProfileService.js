/**
 * RiskProfileService — pure business logic for risk profile management.
 *
 * No Express req/res objects here — fully testable.
 * Controllers call these methods, passing plain data, and return the results.
 */
const RiskProfile = require('../models/riskprofilemodal');
const mongoose = require('mongoose');
const logger = require('../utils/logger');

class RiskProfileService {
  /**
   * Get paginated risk profiles for a user.
   * @returns {{ data: Array, pagination: object }}
   */
  async getAll(userId, { page = 1, limit = 20 } = {}) {
    page = Math.max(1, page);
    limit = Math.min(50, Math.max(1, limit));
    const skip = (page - 1) * limit;

    const [riskProfiles, total, activeOnCurrent] = await Promise.all([
      RiskProfile.find({ user: userId }).skip(skip).limit(limit).lean(),
      RiskProfile.countDocuments({ user: userId }),
      this.resolveActiveProfile(userId).then(p => (p ? String(p._id) : null)).catch(() => null),
    ]);

    // Tag each profile with `ison` = "is this the active profile on the
    // user's CURRENT exchange?". Frontend still reads `ison` to render the
    // active toggle — keeping the same response key avoids touching every
    // consumer just because the storage location moved.
    const data = riskProfiles.map(p => ({
      ...p,
      ison: activeOnCurrent ? String(p._id) === activeOnCurrent : false,
    }));

    return {
      data,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    };
  }

  /**
   * Get a single risk profile by ID (must belong to user).
   */
  async getById(userId, profileId) {
    if (!mongoose.Types.ObjectId.isValid(profileId)) {
      return { error: 'Invalid ID format', status: 400 };
    }
    const riskProfile = await RiskProfile.findOne({ _id: profileId, user: userId }).lean();
    if (!riskProfile) {
      return { error: 'Risk profile not found', status: 404 };
    }
    // Tag with `ison` to match the response shape from getAll — single
    // profile endpoints used to return raw docs, leaving the frontend to
    // guess activity from a list lookup.
    const activeId = await this._activeIdForCurrentExchange(userId);
    return { data: { ...riskProfile, ison: activeId ? String(riskProfile._id) === activeId : false } };
  }

  /**
   * Create a new risk profile.
   */
  async create(userId, body) {
    const sanitize = (value, defaultValue) =>
      value === '' || value === undefined ? defaultValue : value;

    const {
      title, description, SLallowedperday, initialRiskPerTrade,
      increaseOnWin, decreaseOnLoss, maxRisk, minRisk, reset,
      growthThreshold, payoutPercentage, minRiskRewardRatio, isDefault,
    } = body;

    // If the profile is marked as default, turn off 'default' for all other profiles of this user
    if (isDefault) {
      await RiskProfile.updateMany({ user: userId }, { default: false });
    }

    const newRiskProfile = await RiskProfile.create({
      user: userId,
      title,
      description,
      SLallowedperday: sanitize(SLallowedperday, 100),
      initialRiskPerTrade: sanitize(initialRiskPerTrade, 0),
      increaseOnWin: sanitize(increaseOnWin, 0),
      decreaseOnLoss: sanitize(decreaseOnLoss, 0),
      maxRisk: sanitize(maxRisk, 100),
      minRisk: sanitize(minRisk, 0),
      reset: sanitize(reset, 100000),
      growthThreshold: sanitize(growthThreshold, 0),
      payoutPercentage: sanitize(payoutPercentage, 0),
      minRiskRewardRatio: sanitize(minRiskRewardRatio, 1),
      default: sanitize(isDefault, false),
      currentrisk: sanitize(initialRiskPerTrade, 0),
    });

    return { data: newRiskProfile };
  }

  /**
   * Resolve the user's active risk profile for a given exchange (defaults to
   * the user's currently-selected exchange). Single source of truth — reads
   * from User.activeRiskProfileByExchange map, falls back to the user's
   * `default` profile if no entry exists yet for that exchange.
   * Replaces the old `RiskProfile.findOne({ user, ison: true })` lookup
   * which only ever held the active profile for ONE exchange at a time and
   * required a write on every exchange switch to stay accurate.
   */
  async resolveActiveProfile(userId, exchange = null) {
    const User = require('../models/User');
    const user = await User.findById(userId).select('activeExchange activeRiskProfileByExchange').lean();
    if (!user) return null;
    const ex = (exchange || user.activeExchange || 'bybit').toLowerCase();
    const map = user.activeRiskProfileByExchange || {};
    const mappedId = map[ex] || map.get?.(ex);
    if (mappedId) {
      const p = await RiskProfile.findOne({ _id: mappedId, user: userId });
      if (p) return p;
    }
    // No entry yet for this exchange — fall back to the user's default
    // profile, and lazily record it on the map so subsequent lookups are O(1).
    const fallback = await RiskProfile.findOne({ user: userId, default: true })
      || await RiskProfile.findOne({ user: userId });
    if (fallback) {
      try {
        await User.updateOne(
          { _id: userId },
          { $set: { [`activeRiskProfileByExchange.${ex}`]: fallback._id } }
        );
      } catch { /* non-fatal */ }
    }
    return fallback;
  }

  /**
   * Resolve the profile id currently active on the user's CURRENT exchange,
   * or null. Wrapper used by single-profile read paths to tag responses with
   * `ison` consistently with getAll().
   */
  async _activeIdForCurrentExchange(userId) {
    const p = await this.resolveActiveProfile(userId).catch(() => null);
    return p ? String(p._id) : null;
  }

  /**
   * Return the list of exchange ids on which this profile is currently the
   * active selection (per User.activeRiskProfileByExchange). Used to block
   * edits/deletes of any profile in use on any exchange.
   */
  async _exchangesActiveOn(userId, profileId) {
    const User = require('../models/User');
    const user = await User.findById(userId).select('activeRiskProfileByExchange').lean();
    const map = user?.activeRiskProfileByExchange || {};
    const out = [];
    for (const [ex, pid] of Object.entries(map)) {
      if (pid && String(pid) === String(profileId)) out.push(ex);
    }
    return out;
  }

  /**
   * Delete a risk profile (owned by user).
   */
  async delete(userId, profileId) {
    if (!mongoose.Types.ObjectId.isValid(profileId)) {
      return { error: 'Invalid ID format', status: 400 };
    }

    const riskProfile = await RiskProfile.findOne({ _id: profileId, user: userId });
    if (!riskProfile) {
      return { error: 'Risk profile not found', status: 404 };
    }

    // Cannot delete a profile active on ANY exchange. Single source of truth
    // is the per-exchange map on User; the old global `ison` flag was removed.
    const activeOn = await this._exchangesActiveOn(userId, profileId);
    if (activeOn.length > 0) {
      return {
        error: `Cannot delete — this profile is active on ${activeOn.join(', ')}. Switch to that exchange and activate a different profile first.`,
        status: 400,
      };
    }

    // If the profile being deleted is the default, auto-promote another profile
    if (riskProfile.default) {
      const nextDefault = await RiskProfile.findOne({ user: userId, _id: { $ne: profileId } });
      if (!nextDefault) {
        return { error: 'Cannot delete the only risk profile.', status: 400 };
      }
      await RiskProfile.updateOne({ _id: nextDefault._id }, { default: true });
    }

    const deletedRiskProfile = await RiskProfile.findByIdAndDelete(profileId);
    return { data: deletedRiskProfile };
  }

  /**
   * Update a risk profile (owned by user).
   * Blocks edits to a profile active on ANY exchange — its rules are being
   * used to size live trades, so changing them mid-stream would break the
   * streak math. User must switch to a different profile on each exchange
   * where this one is active before editing.
   */
  async update(userId, profileId, updates) {
    if (!mongoose.Types.ObjectId.isValid(profileId)) {
      return { error: 'Invalid ID format', status: 400 };
    }

    const target = await RiskProfile.findOne({ _id: profileId, user: userId }).select('_id').lean();
    if (!target) {
      return { error: 'Risk profile not found', status: 404 };
    }
    const activeOn = await this._exchangesActiveOn(userId, profileId);
    if (activeOn.length > 0) {
      return {
        error: `Cannot edit — this profile is active on ${activeOn.join(', ')}. Switch to a different profile on those exchanges first.`,
        status: 400,
      };
    }

    // Project to allowed keys only — defense in depth even if the validator
    // ever gets relaxed. Per-exchange runtime state lives in RiskProfileState
    // and must NEVER be reachable via this PATCH path.
    const ALLOWED_UPDATE_FIELDS = [
      'title', 'description', 'SLallowedperday', 'initialRiskPerTrade',
      'increaseOnWin', 'decreaseOnLoss', 'maxRisk', 'minRisk', 'reset',
      'growthThreshold', 'payoutPercentage', 'minRiskRewardRatio',
      'noofactivetrades', 'default',
    ];
    const safeUpdates = {};
    for (const k of ALLOWED_UPDATE_FIELDS) {
      if (updates[k] !== undefined) safeUpdates[k] = updates[k];
    }
    const updatedRiskProfile = await RiskProfile.findOneAndUpdate(
      { _id: profileId, user: userId },
      safeUpdates,
      { new: true }
    ).lean();
    if (!updatedRiskProfile) {
      return { error: 'Risk profile not found', status: 404 };
    }
    const activeId = await this._activeIdForCurrentExchange(userId);
    return { data: { ...updatedRiskProfile, ison: activeId ? String(updatedRiskProfile._id) === activeId : false } };
  }

  /**
   * Get the active risk profile for a user.
   */
  async getActive(userId) {
    const activeRiskProfile = await this.resolveActiveProfile(userId);
    if (!activeRiskProfile) {
      return { error: 'No active risk profile found', status: 404 };
    }
    return { data: activeRiskProfile };
  }

  /**
   * Reset the per-exchange RiskProfileState for (profile, exchange) so the
   * UI shows initialRiskPerTrade immediately after activation. Also marks
   * any closed trades on this exchange as riskApplied so the sync won't
   * re-tick them onto the fresh state. Called on every activation path
   * (manual toggle + auto-activate-after-deactivate).
   */
  async _resetStateOnActivation(userId, profile, exchange) {
    try {
      const RiskProfileState = require('../models/RiskProfileState');
      const Trade = require('../models/Trade');
      await RiskProfileState.findOneAndUpdate(
        { user: userId, riskProfile: profile._id, exchange },
        {
          $set: {
            currentrisk: Number(profile.initialRiskPerTrade) || 0,
            previousrisk: 0,
            consecutiveWins: 0,
            consecutiveLosses: 0,
            isFirstTrade: true,
            lastProcessedTradeId: null,
            activatedAt: new Date(),
          },
        },
        { upsert: true, new: true }
      );
      // Stamp only trades that BELONG TO THIS PROFILE on this exchange. If
      // we marked all exchange trades, a later reactivation of a DIFFERENT
      // profile on the same exchange would inherit those stamps and never
      // re-tick its own historical trades onto its own fresh state.
      await Trade.updateMany(
        {
          user: userId,
          exchange,
          riskProfile: profile._id,
          outcome: { $in: ['Win', 'Loss'] },
        },
        { $set: { riskApplied: true } }
      );
    } catch (err) {
      logger.warn('Failed to reset per-exchange state on activation', {
        exchange, message: err?.message,
      });
    }
  }

  /**
   * Activate or deactivate a risk profile (toggle).
   */
  async activate(userId, profileId, ison) {
    if (!mongoose.Types.ObjectId.isValid(profileId)) {
      return { error: 'Invalid ID format', status: 400 };
    }
    if (typeof ison !== 'boolean') {
      return { error: 'The request body must include a boolean "ison" field', status: 400 };
    }

    const profile = await RiskProfile.findOne({ _id: profileId, user: userId });
    if (!profile) {
      return { error: 'Risk profile not found', status: 404 };
    }

    const User = require('../models/User');
    const user = await User.findById(userId).select('activeExchange activeRiskProfileByExchange');
    if (!user) return { error: 'User not found', status: 404 };
    const exchange = user.activeExchange || 'bybit';
    if (!user.activeRiskProfileByExchange) user.activeRiskProfileByExchange = new Map();

    if (ison) {
      // Make THIS profile active on the user's CURRENT exchange. Other
      // exchanges keep their existing map entries (and their RiskProfileState
      // rows) intact, so streaks elsewhere are preserved.
      user.activeRiskProfileByExchange.set(exchange, profile._id);
      await user.save();
      await this._resetStateOnActivation(userId, profile, exchange);
      return { message: 'Risk profile activated successfully', data: profile };
    }

    // Deactivating — only meaningful if the profile is currently active on
    // this exchange. Pick a replacement (default profile, else any other)
    // and put IT in the map. Refuse if there's nothing else to switch to.
    const mappedId = user.activeRiskProfileByExchange.get(exchange);
    const isActiveHere = mappedId && String(mappedId) === String(profileId);
    if (!isActiveHere) {
      return { message: `Profile is not active on ${exchange}`, data: profile };
    }
    const replacement =
      await RiskProfile.findOne({ user: userId, default: true, _id: { $ne: profileId } })
      || await RiskProfile.findOne({ user: userId, _id: { $ne: profileId } });
    if (!replacement) {
      return {
        error: 'Cannot deactivate — no other risk profile exists to switch to. Create another profile first.',
        status: 400,
      };
    }
    user.activeRiskProfileByExchange.set(exchange, replacement._id);
    await user.save();
    await this._resetStateOnActivation(userId, replacement, exchange);
    return {
      message: `Profile deactivated on ${exchange}; ${replacement.title || 'another profile'} auto-activated`,
      data: replacement,
    };
  }

  /**
   * Reset the default profile selection.
   */
  async resetDefault(userId, profileId) {
    if (!profileId) {
      return { error: 'Profile ID is required.', status: 400 };
    }

    const existingDefault = await RiskProfile.findOne({ user: userId, default: true });

    if (!existingDefault) {
      const firstProfile = await RiskProfile.findOne({ user: userId });
      if (firstProfile) {
        await RiskProfile.updateOne({ _id: firstProfile._id }, { default: true });
      }
    } else {
      await RiskProfile.updateMany({ user: userId, _id: { $ne: profileId } }, { default: false });
    }

    const updatedProfile = await RiskProfile.findOneAndUpdate(
      { _id: profileId, user: userId },
      { default: true },
      { new: true }
    );

    if (!updatedProfile) {
      return { error: 'Profile not found.', status: 404 };
    }

    return { message: 'Default risk profile updated successfully.', data: updatedProfile };
  }

  // Legacy `processNewTradeResult` (global-flag streak tick) was removed —
  // all live call sites now use processNewTradeResultForExchange, which
  // mutates per-exchange state in RiskProfileState. See git history if you
  // need to recover the old single-store implementation.

  // ──────────────────────────────────────────────────────────────────────────
  // Per-exchange runtime state — Phase 3 of multi-exchange.
  // The methods below operate on the RiskProfileState collection so each
  // exchange evolves independently from the same RiskProfile config.
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Fetch (or lazily create) the RiskProfileState for the profile active on
   * (user, exchange). Resolves the profile via User.activeRiskProfileByExchange
   * (the only source of truth for per-exchange active profile). Falls back
   * to the user's default profile when no map entry exists yet (first call
   * on a fresh exchange) and lazily seeds the map.
   */
  async getOrCreateState(userId, exchange) {
    const RiskProfileState = require('../models/RiskProfileState');
    const User = require('../models/User');
    const user = await User.findById(userId).select('activeRiskProfileByExchange').lean();
    let profile = null;
    const mappedId = user?.activeRiskProfileByExchange?.[exchange];
    if (mappedId) {
      profile = await RiskProfile.findOne({ _id: mappedId, user: userId });
    }
    if (!profile) {
      // Fallback — no map entry for this exchange yet. Use the user's
      // default profile and lazily record it on the map.
      profile = await RiskProfile.findOne({ user: userId, default: true })
        || await RiskProfile.findOne({ user: userId });
      if (profile) {
        try {
          await User.updateOne(
            { _id: userId },
            { $set: { [`activeRiskProfileByExchange.${exchange}`]: profile._id } }
          );
        } catch { /* non-fatal */ }
      }
    }
    if (!profile) return { profile: null, state: null };

    let state = await RiskProfileState.findOne({
      user: userId,
      riskProfile: profile._id,
      exchange,
    });

    if (!state) {
      state = await RiskProfileState.create({
        user: userId,
        riskProfile: profile._id,
        exchange,
        currentrisk: profile.initialRiskPerTrade || 0,
        previousrisk: 0,
        consecutiveWins: 0,
        consecutiveLosses: 0,
        isFirstTrade: true,
        lastProcessedTradeId: null,
        activatedAt: new Date(),
      });
    }
    return { profile, state };
  }

  /**
   * Return the user's active risk profile MERGED with its per-exchange state.
   * This is the single source of truth the trading panel should read for
   * `currentrisk` / `previousrisk` / `isFirstTrade` / streak counters.
   *
   * Why: the legacy `RiskProfile` doc holds only one set of mutable counters,
   * shared across all exchanges. The trading panel needs per-exchange numbers,
   * otherwise switching exchanges shows whichever exchange ticked last.
   */
  async getActiveStateForExchange(userId, exchange) {
    const { profile, state } = await this.getOrCreateState(userId, exchange);
    if (!profile || !state) return null;
    const merged = profile.toObject ? profile.toObject() : { ...profile };
    merged.currentrisk = state.currentrisk;
    merged.previousrisk = state.previousrisk;
    merged.consecutiveWins = state.consecutiveWins;
    merged.consecutiveLosses = state.consecutiveLosses;
    merged.isFirstTrade = state.isFirstTrade;
    merged.lastProcessedTradeId = state.lastProcessedTradeId;
    merged.activatedAt = state.activatedAt;
    merged.exchange = exchange;
    return merged;
  }

  /**
   * Reset the per-exchange runtime state for a user — wipes streak counters
   * back to initial. Useful when historical drift from mis-classified trades
   * has corrupted the streak.
   */
  async resetState(userId, exchange) {
    const RiskProfileState = require('../models/RiskProfileState');
    const Trade = require('../models/Trade');
    const { state, profile } = await this.getOrCreateState(userId, exchange);
    if (!state || !profile) return null;
    state.currentrisk = profile.initialRiskPerTrade || 0;
    state.previousrisk = 0;
    state.consecutiveWins = 0;
    state.consecutiveLosses = 0;
    state.isFirstTrade = true;
    state.lastProcessedTradeId = null;
    state.activatedAt = new Date();
    await state.save();

    // Clear riskApplied on this exchange's trades so the next sync re-ticks
    // them from scratch. Without this, any closed trade after the reset
    // moment would compound from initialRiskPerTrade but past trades whose
    // result we want to fold back in (e.g. after recovering from a botched
    // backfill) would stay frozen.
    try {
      await Trade.updateMany(
        { user: userId, exchange, outcome: { $in: ['Win', 'Loss'] } },
        { $set: { riskApplied: false } }
      );
    } catch { /* non-fatal */ }
    return state;
  }

  /**
   * Per-exchange variant of processNewTradeResult. Same business rules as the
   * legacy method, but mutates RiskProfileState (per-exchange) instead of
   * RiskProfile (global).
   */
  async processNewTradeResultForExchange(userId, exchange, tradeResult, tradeId) {
    if (!tradeResult || !tradeId) return false;
    const { profile, state } = await this.getOrCreateState(userId, exchange);
    if (!profile || !state) return false;
    if (state.lastProcessedTradeId === tradeId) return false;

    // Durable dedup: if `tradeId` is a real Trade._id, check the riskApplied
    // flag. This survives across reloads and is order-independent — fixes the
    // oscillation where the sync re-ticked every "unprocessed" trade on each
    // page load because lastProcessedTradeId only remembers the LAST one.
    let tradeDoc = null;
    if (mongoose.Types.ObjectId.isValid(tradeId)) {
      const Trade = require('../models/Trade');
      tradeDoc = await Trade.findById(tradeId).select('riskApplied').lean();
      if (tradeDoc?.riskApplied) return false;
    }

    const reset = Number(profile.reset) || 0;
    let nextWins = Number(state.consecutiveWins) || 0;
    let nextLosses = Number(state.consecutiveLosses) || 0;
    let newRisk = Number(state.currentrisk) || Number(profile.initialRiskPerTrade) || 0;

    if (tradeResult === 'Win') {
      nextWins++;
      nextLosses = 0;
      newRisk = newRisk * (1 + (Number(profile.increaseOnWin) || 0) / 100);
    } else if (tradeResult === 'Loss') {
      nextLosses++;
      nextWins = 0;
      newRisk = newRisk * (1 - (Number(profile.decreaseOnLoss) || 0) / 100);
    }

    if (reset > 0 && (nextWins >= reset || nextLosses >= reset)) {
      newRisk = Number(profile.initialRiskPerTrade);
      nextWins = 0;
      nextLosses = 0;
    }

    const minRisk = Number(profile.minRisk) || 0;
    const maxRisk = Number(profile.maxRisk) || 100;
    newRisk = Math.max(minRisk, Math.min(newRisk, maxRisk));

    logger.info('RiskProfileState updating', {
      exchange, tradeId, result: tradeResult,
      oldRisk: state.currentrisk, newRisk,
      oldLosses: state.consecutiveLosses, nextLosses,
    });

    state.previousrisk = state.currentrisk;
    state.currentrisk = newRisk;
    state.consecutiveWins = nextWins;
    state.consecutiveLosses = nextLosses;
    state.lastProcessedTradeId = tradeId;
    state.isFirstTrade = false;
    await state.save();

    // Stamp the source Trade as applied so it can't be re-ticked on the next
    // sync pass (page reload, periodic poll, etc.).
    if (tradeDoc) {
      try {
        const Trade = require('../models/Trade');
        await Trade.updateOne({ _id: tradeId }, { $set: { riskApplied: true } });
      } catch { /* non-fatal */ }
    }
    return true;
  }
}

module.exports = RiskProfileService;
