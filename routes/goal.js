const express = require('express');
const router = express.Router();
const goalController = require('../controllers/goalcontroller');
const { authMiddleware } = require('../middleware/auth');
const { validateBody, validateParams } = require('../middleware/validate');
const { goalCreateSchema, goalUpdateSchema, goalIdParamSchema } = require('../validators/schemas');

// All goal routes require authentication
router.use(authMiddleware);

// POST /api/goal/goals
router.post('/goals', validateBody(goalCreateSchema), goalController.addGoal);

// GET /api/goal/goals
router.get('/goals', goalController.getGoals);

// PUT /api/goal/goals
router.put('/goals', validateBody(goalUpdateSchema), goalController.updateGoal);

// DELETE /api/goal/goals/:goalId
router.delete('/goals/:goalId', validateParams(goalIdParamSchema), goalController.deleteGoal);

module.exports = router;
