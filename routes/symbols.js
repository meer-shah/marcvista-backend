const express = require('express');
const router = express.Router();
const symbolController = require('../controllers/symbolController');
const { authMiddleware } = require('../middleware/auth');

// Auth — needed because we resolve the user's active exchange to pick the broker.
router.use(authMiddleware);

// GET all tradable USDT-perp symbols on the active exchange.
router.get('/', symbolController.getSymbols);
// Per-symbol metadata.
router.get('/info/:symbol', symbolController.getInstrumentInfo);
router.get('/ticker/:symbol', symbolController.getTicker);

module.exports = router;
