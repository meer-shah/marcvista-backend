const express = require('express');
const rateLimit = require('express-rate-limit');
const orderController = require('../controllers/order');
const fetchinfoController = require('../controllers/fetchinfo');
const { authMiddleware } = require('../middleware/auth');
const { validateBody, validateParams } = require('../middleware/validate');
const {
  placeOrderSchema,
  cancelOrderSchema,
  setLeverageSchema,
  amendOrderSchema,
  switchMarginModeSchema,
  coinParamSchema,
} = require('../validators/schemas');

const router = express.Router();

// Placing orders: 30 per 15 min — generous for active trading, blocks spam
const placeOrderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many order requests. Please wait before placing more orders.' },
});

// Mutations (cancel, amend, leverage, margin): 60 per 15 min
const orderMutationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please slow down.' },
});

// All order routes require authentication
router.use(authMiddleware);

// Order Management Routes
router.post('/place-order', placeOrderLimiter, validateBody(placeOrderSchema), orderController.placeOrder); // Place a new order (applies risk profile automatically when active)
router.get('/order-list', fetchinfoController.getOrderListf); // Get pending orders
router.post('/cancel-order', orderMutationLimiter, validateBody(cancelOrderSchema), orderController.cancelOrder); // Cancel an existing order
router.post('/ammend-order', orderMutationLimiter, validateBody(amendOrderSchema), orderController.ammendOrder); // Amend an order

// Position Management Routes
router.get('/active-positions', fetchinfoController.getPositionInfof); // Get active positions
router.post('/set-leverage', orderMutationLimiter, validateBody(setLeverageSchema), orderController.setLeverage); // Set leverage for trading
router.post('/switch-margin-mode', orderMutationLimiter, validateBody(switchMarginModeSchema), orderController.switchMarginMode); // Switch margin mode

// Trade History and Risk Management Routes
router.get('/closed-pnl', fetchinfoController.getClosedPnlf); // Get closed PnL for trade history
router.get('/showusdtbalance', fetchinfoController.showusdtbalance);
router.get('/portfolio-summary', fetchinfoController.getPortfolioSummary);

// Account Management Routes (from fetchinfo)
router.get('/account-balance', fetchinfoController.getAccountBalance); // Get account balance details
router.get('/coin-balance', fetchinfoController.getCoinBalance); // Get balance of all coins
router.get('/single-coin-balance/:coin', validateParams(coinParamSchema), fetchinfoController.getSingleCoinBalance); // Get balance of a specific coin
router.get('/transaction-log', fetchinfoController.gettransactionlog);

module.exports = router;
