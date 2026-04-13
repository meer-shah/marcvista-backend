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

module.exports = router;
