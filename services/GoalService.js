/**
 * GoalService — pure business logic for goal management.
 *
 * No Express req/res objects — fully testable.
 * Goals live as sub-documents inside the active RiskProfile.
 */
const RiskProfile = require('../models/riskprofilemodal');
const { http_request } = require('../config/bybitConfig');
const logger = require('../utils/logger');

class GoalService {
  /**
   * Add a goal to the active risk profile.
   */
  async addGoal(userId, { goalType, goalAmount }) {
    if (!goalType || !goalAmount) {
      return { error: 'Goal type and amount are required.', status: 400 };
    }

    const activeProfile = await RiskProfile.findOne({ user: userId, ison: true });
    if (!activeProfile) {
      return { data: { goals: [] } };
    }

    if (!activeProfile.goals) {
      activeProfile.goals = [];
    }

    if (activeProfile.goals.length > 0) {
      return { error: 'Only one goal is allowed per profile. Please delete or update the existing one.', status: 400 };
    }

    const newGoal = { goalType, goalAmount, createdAt: new Date() };
    activeProfile.goals.push(newGoal);
    await activeProfile.save();

    return {
      message: 'Goal added successfully.',
      data: { goal: activeProfile.goals[activeProfile.goals.length - 1] },
      status: 201,
    };
  }

  /**
   * Get all goals with progress tracking.
   */
  async getGoals(userId) {
    const activeProfile = await RiskProfile.findOne({ user: userId, ison: true });
    let goals = activeProfile?.goals || [];

    if (goals.length === 0) {
      return { data: { goals: [] } };
    }

    // Fetch all closed trades once (for progress calculation)
    let allTrades = [];
    try {
      const pnlResponse = await http_request(
        '/v5/position/closed-pnl',
        'GET',
        'category=linear',
        'Get Closed PnL for Goal Progress'
      );
      allTrades = pnlResponse?.result?.list || [];
    } catch (error) {
      logger.error('Failed to fetch trades for goal progress', error);
      // Continue without progress data — goals will have 0 progress
    }

    // Enrich each goal with actualProfit and progress
    goals = goals.map((goal) => {
      const goalStart = new Date(goal.createdAt).getTime();
      const relevantTrades = allTrades.filter((trade) => {
        const tradeCloseTime = parseInt(trade.updatedTime);
        return tradeCloseTime >= goalStart;
      });

      const actualProfit = relevantTrades.reduce((sum, t) => sum + parseFloat(t.closedPnl || 0), 0);
      const progress = goal.goalAmount > 0 ? (actualProfit / goal.goalAmount) * 100 : 0;

      return { ...goal.toObject(), actualProfit, progress };
    });

    return { data: { goals } };
  }

  /**
   * Update a goal by ID.
   */
  async updateGoal(userId, { goalId, goalType, goalAmount }) {
    if (!goalId || (!goalType && !goalAmount)) {
      return { error: 'Invalid update request.', status: 400 };
    }

    const activeProfile = await RiskProfile.findOne({ user: userId, ison: true });
    if (!activeProfile) {
      return { data: { goals: [] } };
    }

    const goal = activeProfile.goals.id(goalId);
    if (!goal) return { error: 'Goal not found.', status: 404 };

    if (goalType) goal.goalType = goalType;
    if (goalAmount) goal.goalAmount = goalAmount;

    await activeProfile.save();
    return { message: 'Goal updated successfully.', data: { goal } };
  }

  /**
   * Delete a goal by ID.
   */
  async deleteGoal(userId, goalId) {
    if (!goalId) {
      return { error: 'Goal ID is required.', status: 400 };
    }

    const activeProfile = await RiskProfile.findOne({ user: userId, ison: true });
    if (!activeProfile) {
      return { data: { goals: [] } };
    }

    const goal = activeProfile.goals.id(goalId);
    if (!goal) return { error: 'Goal not found.', status: 404 };

    activeProfile.goals.pull(goalId);
    await activeProfile.save();

    return {
      message: 'Goal deleted successfully.',
      data: { goals: activeProfile.goals },
    };
  }
}

module.exports = GoalService;
