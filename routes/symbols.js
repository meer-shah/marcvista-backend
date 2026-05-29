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
// Server-side proxy for public klines — only wired for exchanges whose
// REST blocks CORS (currently just MEXC). Others 501 and the frontend
// falls back to direct exchange fetch.
router.get('/klines/:symbol', symbolController.getKlines);

module.exports = router;
