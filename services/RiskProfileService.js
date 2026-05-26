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

    const [riskProfiles, total] = await Promise.all([
      RiskProfile.find({ user: userId }).skip(skip).limit(limit),
      RiskProfile.countDocuments({ user: userId }),
    ]);

    return {
      data: riskProfiles,
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
    const riskProfile = await RiskProfile.findOne({ _id: profileId, user: userId });
    if (!riskProfile) {
      return { error: 'Risk profile not found', status: 404 };
    }
    return { data: riskProfile };
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

    // Cannot delete an active profile — deactivate it first
    if (riskProfile.ison) {
      return { error: 'Cannot delete an active risk profile. Deactivate it first.', status: 400 };
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
   */
  async update(userId, profileId, updates) {
    if (!mongoose.Types.ObjectId.isValid(profileId)) {
      return { error: 'Invalid ID format', status: 400 };
    }

    const updatedRiskProfile = await RiskProfile.findOneAndUpdate(
      { _id: profileId, user: userId },
      updates,
      { new: true }
    );
    if (!updatedRiskProfile) {
      return { error: 'Risk profile not found', status: 404 };
    }
    return { data: updatedRiskProfile };
  }

  /**
   * Get the active risk profile for a user.
   */
  async getActive(userId) {
    const activeRiskProfile = await RiskProfile.findOne({ user: userId, ison: true });
    if (!activeRiskProfile) {
      return { error: 'No active risk profile found', status: 404 };
    }
    return { data: activeRiskProfile };
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

    if (ison) {
      // Activating a profile: deactivate all others for this user first
      await RiskProfile.updateMany({ user: userId, ison: true }, { ison: false });

      // Reset tracking fields and activate
      profile.ison = true;
      profile.previousrisk = profile.currentrisk;
      profile.currentrisk = profile.initialRiskPerTrade;
      profile.consecutiveWins = 0;
      profile.consecutiveLosses = 0;
      profile.isFirstTrade = true;
      profile.lastProcessedTradeId = null;
      profile.activatedAt = new Date();
      profile.goals = [];
      await profile.save();

      // NOTE: we deliberately do NOT wipe RiskProfileState rows here. Per
      // the multi-exchange design, each (profile, exchange) state is
      // preserved independently — toggling a profile on/off must not lose
      // streak progress on other exchanges. To reset, use the explicit
      // resetState(userId, exchange) endpoint instead.

      return { message: 'Risk profile activated successfully', data: profile };
    } else {
      // Deactivating a profile — refuse if this is the user's only profile
      const profileCount = await RiskProfile.countDocuments({ user: userId });
      if (profileCount <= 1) {
        return {
          error: 'Cannot deactivate your only risk profile. Create another profile first.',
          status: 400,
        };
      }

      const wasActive = profile.ison;
      profile.ison = false;
      await profile.save();

      if (wasActive) {
        const defaultProfile = await RiskProfile.findOne({ user: userId, default: true, _id: { $ne: profileId } });
        if (defaultProfile) {
          defaultProfile.ison = true;
          defaultProfile.previousrisk = defaultProfile.currentrisk;
          defaultProfile.currentrisk = defaultProfile.initialRiskPerTrade;
          defaultProfile.consecutiveWins = 0;
          defaultProfile.consecutiveLosses = 0;
          defaultProfile.isFirstTrade = true;
          defaultProfile.lastProcessedTradeId = null;
          defaultProfile.activatedAt = new Date();
          defaultProfile.goals = [];
          await defaultProfile.save();
          return { message: 'Risk profile deactivated; default profile auto-activated', data: defaultProfile };
        }

        const anyProfile = await RiskProfile.findOne({ user: userId, _id: { $ne: profileId } });
        if (anyProfile) {
          anyProfile.ison = true;
          anyProfile.previousrisk = anyProfile.currentrisk;
          anyProfile.currentrisk = anyProfile.initialRiskPerTrade;
          anyProfile.consecutiveWins = 0;
          anyProfile.consecutiveLosses = 0;
          anyProfile.isFirstTrade = true;
          anyProfile.lastProcessedTradeId = null;
          anyProfile.activatedAt = new Date();
          anyProfile.goals = [];
          await anyProfile.save();
          return { message: 'Profile deactivated; another profile auto-activated', data: anyProfile };
        }

        // No other profiles exist
        return { message: 'Risk profile deactivated. No other profiles available.', data: null };
      } else {
        return { message: 'Risk profile already deactivated', data: profile };
      }
    }
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
  /**
   * Process a new trade result, update streak counters, and apply reset point if needed.
   * Returns true if the profile was updated.
   */
  async processNewTradeResult(userId, tradeResult, tradeId, providedProfile = null, saveProfile = true) {
    if (!tradeResult || !tradeId) return false;

    const profile = providedProfile || await RiskProfile.findOne({ user: userId, ison: true });
    if (!profile) return false;

    // Prevent double-counting
    if (profile.lastProcessedTradeId === tradeId) {
      return false;
    }

    const reset = Number(profile.reset) || 0;
    let nextWins = Number(profile.consecutiveWins) || 0;
    let nextLosses = Number(profile.consecutiveLosses) || 0;
    let newRisk = Number(profile.currentrisk) || Number(profile.initialRiskPerTrade) || 0;

    if (tradeResult === 'Win') {
      nextWins++;
      nextLosses = 0;
      // Compound win
      newRisk = newRisk * (1 + (Number(profile.increaseOnWin) || 0) / 100);
    } else if (tradeResult === 'Loss') {
      nextLosses++;
      nextWins = 0;
      // Compound loss
      newRisk = newRisk * (1 - (Number(profile.decreaseOnLoss) || 0) / 100);
    }

    // Apply Reset Logic (Deterministic)
    if (reset > 0 && (nextWins >= reset || nextLosses >= reset)) {
      newRisk = Number(profile.initialRiskPerTrade);
      nextWins = 0;
      nextLosses = 0;
    }

    // Clamp risk
    const minRisk = Number(profile.minRisk) || 0;
    const maxRisk = Number(profile.maxRisk) || 100;
    newRisk = Math.max(minRisk, Math.min(newRisk, maxRisk));

    // Update profile
    logger.info('Risk profile updating', { 
      tradeId, 
      result: tradeResult, 
      oldRisk: profile.currentrisk, 
      newRisk, 
      oldLosses: profile.consecutiveLosses, 
      nextLosses,
      resetPoint: reset,
      didReset: (reset > 0 && nextLosses === 0 && newRisk === profile.initialRiskPerTrade && tradeResult === 'Loss')
    });

    profile.previousrisk = profile.currentrisk;
    profile.currentrisk = newRisk;
    profile.consecutiveWins = nextWins;
    profile.consecutiveLosses = nextLosses;
    profile.lastProcessedTradeId = tradeId;

    if (saveProfile) {
      await profile.save();
    }
    return true;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Per-exchange runtime state — Phase 3 of multi-exchange.
  // The methods below operate on the RiskProfileState collection so each
  // exchange evolves independently from the same RiskProfile config.
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Fetch (or lazily create) the RiskProfileState for (user, active profile, exchange).
   * Returns null if the user has no active risk profile.
   */
  async getOrCreateState(userId, exchange) {
    const RiskProfileState = require('../models/RiskProfileState');
    const profile = await RiskProfile.findOne({ user: userId, ison: true });
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
   * Reset the per-exchange runtime state for a user — wipes streak counters
   * back to initial. Useful when historical drift from mis-classified trades
   * has corrupted the streak.
   */
  async resetState(userId, exchange) {
    const RiskProfileState = require('../models/RiskProfileState');
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

    // Mirror to LEGACY RiskProfile fields so anything still reading them
    // (the frontend's calculateAdjustedRisk reads `currentrisk` + `isFirstTrade`
    // off the RiskProfile doc returned by getActive) sees the same number.
    // This converges both stores on every tick — no more drift.
    profile.previousrisk = profile.currentrisk;
    profile.currentrisk = newRisk;
    profile.consecutiveWins = nextWins;
    profile.consecutiveLosses = nextLosses;
    profile.lastProcessedTradeId = tradeId;
    profile.isFirstTrade = false;
    await profile.save();
    return true;
  }
}

module.exports = RiskProfileService;
