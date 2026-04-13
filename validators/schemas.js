const { z } = require('zod');

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid ID format.');

// ---- Auth ----
// Strong password: min 8 chars, at least one lowercase, uppercase, digit.
const strongPassword = z
  .string()
  .min(8, 'Password must be at least 8 characters long.')
  .regex(/[a-z]/, 'Password must contain a lowercase letter.')
  .regex(/[A-Z]/, 'Password must contain an uppercase letter.')
  .regex(/[0-9]/, 'Password must contain a digit.');

const registerSchema = z.object({
  email: z.string().email('Invalid email address.'),
  password: strongPassword,
  name: z.string().trim().min(1).max(100).optional(),
  phone: z.string().trim().max(30).optional(),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email address.'),
  password: z.string().min(1, 'Password is required.'),
});

// ---- Risk Profile ----
// Accept number or empty string/undefined (controller sanitizes to defaults).
const numOrEmpty = z.union([z.number(), z.literal(''), z.undefined()]);

const riskProfileCreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().default(''),
  SLallowedperday: numOrEmpty.optional(),
  initialRiskPerTrade: numOrEmpty.optional(),
  increaseOnWin: numOrEmpty.optional(),
  decreaseOnLoss: numOrEmpty.optional(),
  maxRisk: numOrEmpty.optional(),
  minRisk: numOrEmpty.optional(),
  reset: numOrEmpty.optional(),
  growthThreshold: numOrEmpty.optional(),
  payoutPercentage: numOrEmpty.optional(),
  minRiskRewardRatio: numOrEmpty.optional(),
  isDefault: z.boolean().optional(),
}).passthrough();

// Update allows partial — same fields, all optional.
const riskProfileUpdateSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  SLallowedperday: z.number().optional(),
  initialRiskPerTrade: z.number().optional(),
  increaseOnWin: z.number().optional(),
  decreaseOnLoss: z.number().optional(),
  maxRisk: z.number().optional(),
  minRisk: z.number().optional(),
  reset: z.number().optional(),
  growthThreshold: z.number().optional(),
  payoutPercentage: z.number().optional(),
  minRiskRewardRatio: z.number().optional(),
  noofactivetrades: z.number().optional(),
  ison: z.boolean().optional(),
  default: z.boolean().optional(),
  previousrisk: z.number().optional(),
  currentrisk: z.number().optional(),
  consecutiveWins: z.number().optional(),
  consecutiveLosses: z.number().optional(),
}).passthrough();

const riskProfileActivateSchema = z.object({
  ison: z.boolean(),
});

const riskProfileResetDefaultSchema = z.object({
  id: z.string().min(1, 'Profile ID is required.'),
});

// ---- Goal ----
const goalCreateSchema = z.object({
  goalType: z.string().trim().min(1, 'Goal type is required.'),
  goalAmount: z.number().positive('Goal amount must be positive.'),
});

const goalUpdateSchema = z.object({
  goalId: z.string().min(1, 'Goal ID is required.'),
  goalType: z.string().trim().min(1).optional(),
  goalAmount: z.number().positive().optional(),
}).refine(d => d.goalType !== undefined || d.goalAmount !== undefined, {
  message: 'At least one of goalType or goalAmount is required.',
});

// ---- API Connection ----
const apiConnectionSchema = z.object({
  apiKey: z.string().trim().min(1, 'API Key is required.'),
  secretKey: z.string().trim().min(1, 'Secret Key is required.'),
  accountType: z.enum(['demo', 'live']).optional().default('demo'),
});

// ---- Orders ----
const placeOrderSchema = z.object({
  symbol: z.string().trim().min(1),
  side: z.enum(['Buy', 'Sell']),
  category: z.string().trim().min(1),
  qty: z.union([z.string(), z.number()]),
  orderType: z.string().trim().min(1),
  price: z.union([z.string(), z.number()]),
  takeProfit: z.union([z.string(), z.number()]),
  stopLoss: z.union([z.string(), z.number()]),
  adjustedRisk: z.number().optional(),
  lastTradeResult: z.enum(['Win', 'Loss']).nullable().optional(),
}).passthrough();

const cancelOrderSchema = z.object({
  symbol: z.string().trim().min(1, 'Symbol is required.'),
  orderLinkId: z.string().optional(),
  orderId: z.string().optional(),
}).passthrough();

const setLeverageSchema = z.object({
  symbol: z.string().trim().min(1),
  buyLeverage: z.union([z.string(), z.number()]),
  sellLeverage: z.union([z.string(), z.number()]),
});

const amendOrderSchema = z.object({
  symbol: z.string().trim().min(1),
}).passthrough();

const switchMarginModeSchema = z.object({
  symbol: z.string().trim().min(1),
}).passthrough();

const riskProfileIdParamSchema = z.object({
  id: objectIdSchema,
});

const goalIdParamSchema = z.object({
  goalId: objectIdSchema,
});

const coinParamSchema = z.object({
  coin: z.string().trim().min(1, 'Coin symbol is required.'),
});

module.exports = {
  registerSchema,
  loginSchema,
  riskProfileCreateSchema,
  riskProfileUpdateSchema,
  riskProfileActivateSchema,
  riskProfileResetDefaultSchema,
  goalCreateSchema,
  goalUpdateSchema,
  apiConnectionSchema,
  placeOrderSchema,
  cancelOrderSchema,
  setLeverageSchema,
  amendOrderSchema,
  switchMarginModeSchema,
  riskProfileIdParamSchema,
  goalIdParamSchema,
  coinParamSchema,
};
