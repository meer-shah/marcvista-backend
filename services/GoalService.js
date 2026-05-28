/**
 * GoalService — pure business logic for goal management.
 *
 * Goals are USER-GLOBAL. They live on the User document, not on individual
 * RiskProfile docs, so switching risk profiles or exchanges doesn't change
 * which goals the user is working toward.
 *
 * Migration: first call per user copies any existing goals off the legacy
 * RiskProfile sub-array onto the User doc so historical setups carry over.
 */
const User = require('../models/User');
const RiskProfile = require('../models/riskprofilemodal');
const Trade = require('../models/Trade');
const logger = require('../utils/logger');

const MAX_GOALS_PER_USER = 1;

async function _loadUserWithBackfill(userId) {
  const user = await User.findById(userId).select('goals');
  if (!user) return null;
  // ONE-TIME backfill from legacy per-profile goals.
  //
  // Two failure modes the current logic must avoid:
  //   (a) If the user has legacy goals but `user.goals` is empty, copy ONE
  //       legacy goal into `user.goals` so they don't lose it on the
  //       schema migration.
  //   (b) After backfill, CLEAR the legacy source — otherwise deleting the
  //       backfilled goal would just refill it from the same legacy row on
  //       the next getGoals call (the reason the UI kept showing the goal
  //       after a successful delete).
  //
  // We always sweep legacy `RiskProfile.goals` entries to [] regardless of
  // whether user.goals is empty. After this method runs once per user, the
  // legacy source is gone and backfill becomes a no-op forever.
  try {
    const profilesWithGoals = await RiskProfile.find({
      user: userId,
      goals: { $exists: true, $not: { $size: 0 } },
    }).select('goals');
    if (profilesWithGoals.length > 0) {
      // Only seed user.goals if it's truly empty — don't overwrite goals
      // the user may have created post-migration.
      if (!user.goals || user.goals.length === 0) {
        const legacy = profilesWithGoals[0].goals[0];
        if (legacy) {
          user.goals = [{
            goalType: legacy.goalType,
            goalAmount: legacy.goalAmount,
            createdAt: legacy.createdAt || new Date(),
          }];
          await user.save();
        }
      }
      // Clear ALL legacy profile-level goals so they can never replay.
      await RiskProfile.updateMany(
        { user: userId, goals: { $exists: true, $not: { $size: 0 } } },
        { $set: { goals: [] } }
      );
    }
  } catch (err) {
    logger.warn('Goal backfill from legacy RiskProfile failed', { message: err?.message });
  }
  return user;
}

class GoalService {
  async addGoal(userId, { goalType, goalAmount }) {
    if (!goalType || !goalAmount) {
      return { error: 'Goal type and amount are required.', status: 400 };
    }
    const user = await _loadUserWithBackfill(userId);
    if (!user) return { error: 'User not found.', status: 404 };

    if ((user.goals?.length || 0) >= MAX_GOALS_PER_USER) {
      return { error: 'Only one goal is allowed. Delete or update the existing one.', status: 400 };
    }
    user.goals.push({ goalType, goalAmount, createdAt: new Date() });
    await user.save();

    return {
      message: 'Goal added successfully.',
      data: { goal: user.goals[user.goals.length - 1] },
      status: 201,
    };
  }

  async getGoals(userId) {
    const user = await _loadUserWithBackfill(userId);
    let goals = user?.goals || [];
    if (goals.length === 0) {
      return { data: { goals: [] } };
    }

    // Progress = sum of realised PnL across the canonical Trade collection
    // since the goal was created. Reads from our own DB (not the exchange),
    // so every venue with synced trades contributes — Bybit, Binance, MEXC,
    // etc. — and the math survives offline/exchange downtime.
    const earliestGoalStart = goals.reduce(
      (min, g) => Math.min(min, new Date(g.createdAt).getTime() || Date.now()),
      Date.now()
    );
    let allTrades = [];
    try {
      // Only count APP-placed trades toward goal progress. External trades
      // (opened directly on the exchange UI, not through Marcvista) aren't
      // governed by the risk profile rules the goal is set against, so
      // crediting them would inflate the bar with PnL the user's strategy
      // didn't actually drive.
      allTrades = await Trade.find({
        user: userId,
        source: 'app',
        outcome: { $in: ['Win', 'Loss'] },
        closedAt: { $gte: new Date(earliestGoalStart) },
      }).select('pnl closedAt').lean();
    } catch (error) {
      logger.error('Failed to fetch trades for goal progress', error);
    }

    goals = goals.map((goal) => {
      const goalStart = new Date(goal.createdAt).getTime();
      const relevantTrades = allTrades.filter((t) => {
        const closedMs = t.closedAt ? new Date(t.closedAt).getTime() : 0;
        return closedMs >= goalStart;
      });
      const actualProfit = relevantTrades.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
      const progress = goal.goalAmount > 0 ? (actualProfit / goal.goalAmount) * 100 : 0;
      return { ...goal.toObject(), actualProfit, progress };
    });

    return { data: { goals } };
  }

  async updateGoal(userId, { goalId, goalType, goalAmount }) {
    if (!goalId || (!goalType && !goalAmount)) {
      return { error: 'Invalid update request.', status: 400 };
    }
    const user = await _loadUserWithBackfill(userId);
    if (!user) return { error: 'User not found.', status: 404 };

    const goal = user.goals.id(goalId);
    if (!goal) return { error: 'Goal not found.', status: 404 };

    if (goalType) goal.goalType = goalType;
    if (goalAmount) goal.goalAmount = goalAmount;
    await user.save();

    return { message: 'Goal updated successfully.', data: { goal } };
  }

  async deleteGoal(userId, goalId) {
    if (!goalId) {
      return { error: 'Goal ID is required.', status: 400 };
    }
    const user = await _loadUserWithBackfill(userId);
    if (!user) return { error: 'User not found.', status: 404 };

    const goal = user.goals.id(goalId);
    if (!goal) return { error: 'Goal not found.', status: 404 };

    user.goals.pull(goalId);
    await user.save();

    return {
      message: 'Goal deleted successfully.',
      data: { goals: user.goals },
    };
  }
}

module.exports = GoalService;
