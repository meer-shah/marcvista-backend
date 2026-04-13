/**
 * Goal controller — thin orchestration layer.
 *
 * All business logic lives in GoalService.
 * This file only handles req/res translation and HTTP status codes.
 */
const GoalService = require('../services/GoalService');
const logger = require('../utils/logger');

const service = new GoalService();

// ✅ CREATE: Add a new goal to the active risk profile of current user
exports.addGoal = async (req, res) => {
  try {
    const result = await service.addGoal(req.user._id, req.body);
    if (result.error) return res.status(result.status).json({ message: result.error });
    res.status(result.status || 201).json(result.data ? { message: result.message, goal: result.data.goal } : result.data);
  } catch (error) {
    logger.error('Error adding goal', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
};

// ✅ READ: Always return goals in { goals: [...] } format with progress tracking
exports.getGoals = async (req, res) => {
  try {
    const result = await service.getGoals(req.user._id);
    res.status(200).json(result.data);
  } catch (error) {
    logger.error('Error fetching goals', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
};

// ✅ UPDATE: Update goal by ID
exports.updateGoal = async (req, res) => {
  try {
    const result = await service.updateGoal(req.user._id, req.body);
    if (result.error) return res.status(result.status).json({ message: result.error });
    res.status(200).json({ message: result.message, goal: result.data.goal });
  } catch (error) {
    logger.error('Error updating goal', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
};

// ✅ DELETE: Remove goal by ID
exports.deleteGoal = async (req, res) => {
  try {
    const result = await service.deleteGoal(req.user._id, req.params.goalId);
    if (result.error) return res.status(result.status).json({ message: result.error });
    res.status(200).json({ message: result.message, goals: result.data.goals });
  } catch (error) {
    logger.error('Error deleting goal', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
};
