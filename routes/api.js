const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const apiConnectionController = require('../controllers/apiConnectionController');
const { authMiddleware } = require('../middleware/auth');
const { validateBody } = require('../middleware/validate');
const { apiConnectionSchema } = require('../validators/schemas');

// Credential changes are sensitive: 5 attempts per 15 min per IP
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many credential change attempts. Please try again later.' },
});

// All API connection routes require authentication
router.use(authMiddleware);

// Route to add API connection
router.post('/api-connection', credentialLimiter, validateBody(apiConnectionSchema), apiConnectionController.addApiConnection);

// Route to get API connection
router.get('/api-connection', apiConnectionController.getApiConnection);

// Route to delete API connection
router.delete('/api-connection', credentialLimiter, apiConnectionController.deleteApiConnection);

// ─── Multi-exchange endpoints (Phase 3) ─────────────────────────────────────
// Static metadata + per-user connection state.
router.get('/exchanges', apiConnectionController.listSupportedExchanges);
router.get('/connections', apiConnectionController.getConnectionStatus);
router.get('/balances', apiConnectionController.getAllBalances);

// Active-exchange selector.
router.get('/active-exchange', apiConnectionController.getActiveExchange);
router.post('/active-exchange', apiConnectionController.setActiveExchange);

// Per-exchange credential management.
router.post('/connection/:exchange', credentialLimiter, apiConnectionController.connectExchange);
router.delete('/connection/:exchange', credentialLimiter, apiConnectionController.disconnectExchange);

// ─── User guide markdown (served from /docs/exchanges/{exchange}.md) ───────
const path = require('path');
const fs = require('fs/promises');
router.get('/exchanges/:exchange/guide', async (req, res) => {
  const exchange = String(req.params.exchange || '').toLowerCase();
  const allowed = ['bybit', 'binance', 'okx', 'bitget', 'mexc'];
  if (!allowed.includes(exchange)) {
    return res.status(404).json({ message: 'Unknown exchange' });
  }
  try {
    const filePath = path.join(__dirname, '..', 'docs', 'exchanges', `${exchange}.md`);
    const markdown = await fs.readFile(filePath, 'utf8');
    res.type('text/markdown').send(markdown);
  } catch {
    res.status(404).json({ message: 'Guide not available' });
  }
});

module.exports = router;
