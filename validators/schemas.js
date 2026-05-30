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

// Risk-bound invariant — minRisk <= initialRiskPerTrade <= maxRisk. If this
// were violated, the per-tick clamp in processNewTradeResultForExchange
// (Math.max(minRisk, Math.min(newRisk, maxRisk))) would produce nonsensical
// state — e.g. setting minRisk=5 above initial=3 lets a loss tick compound
// to 1.5, then ratchet back up to 5 on the next read, then drop to 0.75 on
// the next loss, etc. Reject the config at the API boundary instead.
const numericOrUndefined = (v) =>
  v === '' || v === undefined ? undefined : Number(v);
const riskBoundsRefine = (data) => {
  const min = numericOrUndefined(data.minRisk);
  const init = numericOrUndefined(data.initialRiskPerTrade);
  const max = numericOrUndefined(data.maxRisk);
  if (min != null && init != null && min > init) return false;
  if (init != null && max != null && init > max) return false;
  if (min != null && max != null && min > max) return false;
  return true;
};
const riskBoundsMessage = {
  message: 'Invalid risk bounds — required: minRisk ≤ initialRiskPerTrade ≤ maxRisk.',
  path: ['initialRiskPerTrade'],
};

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
}).passthrough().refine(riskBoundsRefine, riskBoundsMessage);

// Update allows partial — same fields, all optional.
// IMPORTANT: this schema is .strip() (the zod default) — unknown keys are
// dropped silently rather than passed through. Mutable runtime state
// (currentrisk, previousrisk, consecutiveWins, consecutiveLosses,
// isFirstTrade, lastProcessedTradeId, activatedAt) lives on RiskProfileState
// per-exchange and MUST NOT be writable via the profile PATCH endpoint.
// `ison` is also excluded — activation goes through PUT /:id/activate.
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
  default: z.boolean().optional(),
});

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
// Numeric fields arrive as strings from the exchange-style payload; coerce
// then defensively bound. Upper bounds are deliberately generous — they
// exist to reject obvious garbage (negative, NaN, Infinity, absurd values),
// not to enforce trading limits (those live on RiskProfile + broker).
const positiveNum = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'string' ? Number(v) : v))
  .refine((n) => Number.isFinite(n) && n > 0, { message: 'Must be a positive finite number.' })
  .refine((n) => n <= 1e12, { message: 'Value is unreasonably large.' });

const nonNegativeNum = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'string' ? Number(v) : v))
  .refine((n) => Number.isFinite(n) && n >= 0, { message: 'Must be a non-negative finite number.' })
  .refine((n) => n <= 1e12, { message: 'Value is unreasonably large.' });

const leverageNum = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'string' ? Number(v) : v))
  // Upper bound is a sanity check only — the real per-symbol max is enforced
  // by the exchange + instrument leverageFilter. Bybit tops out ~100x but
  // MEXC and others allow ~200x+, so a hard 125 wrongly rejected valid MEXC
  // leverage ("Validation failed"). Keep a generous ceiling that still blocks
  // obvious garbage.
  .refine((n) => Number.isFinite(n) && n >= 1 && n <= 1000, { message: 'Leverage must be between 1 and 1000.' });

const placeOrderSchema = z.object({
  symbol: z.string().trim().min(1).max(40),
  side: z.enum(['Buy', 'Sell']),
  category: z.string().trim().min(1).max(20),
  qty: positiveNum,
  orderType: z.string().trim().min(1).max(20),
  price: nonNegativeNum,
  takeProfit: nonNegativeNum,
  stopLoss: nonNegativeNum,
  // adjustedRisk is a % of equity per trade. OrderService additionally clamps
  // it to [profile.minRisk, profile.maxRisk] — here we only reject obvious
  // garbage (negative, NaN, > 100% of equity).
  adjustedRisk: z.number().finite().gt(0).lte(100).optional(),
  lastTradeResult: z.enum(['Win', 'Loss']).nullable().optional(),
}).passthrough();

const cancelOrderSchema = z.object({
  symbol: z.string().trim().min(1, 'Symbol is required.').max(40),
  orderLinkId: z.string().max(64).optional(),
  orderId: z.string().max(64).optional(),
}).passthrough();

const setLeverageSchema = z.object({
  symbol: z.string().trim().min(1).max(40),
  buyLeverage: leverageNum,
  sellLeverage: leverageNum,
});

const amendOrderSchema = z.object({
  symbol: z.string().trim().min(1).max(40),
  qty: positiveNum.optional(),
  price: nonNegativeNum.optional(),
  takeProfit: nonNegativeNum.optional(),
  stopLoss: nonNegativeNum.optional(),
}).passthrough();

const switchMarginModeSchema = z.object({
  symbol: z.string().trim().min(1).max(40),
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
