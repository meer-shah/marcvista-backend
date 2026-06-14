const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Goals are user-global (not scoped to risk profile or exchange). Switching
// risk profiles or exchanges leaves the goal list intact.
const goalSchema = new mongoose.Schema({
  goalType: {
    type: String,
    enum: ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Yearly'],
    required: true,
  },
  goalAmount: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now },
}, { _id: true });

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: true
  },
  name: {
    type: String,
    trim: true
  },
  phone: {
    type: String,
    trim: true
  },
  profilePicture: {
    type: String, // base64 data URL or URL
    default: null
  },
  // Timestamp at which the user last cleared their trade history.
  // Trades with closedAt <= this value are hidden from trading panel history.
  tradeHistoryClearedAt: {
    type: Date,
    default: null,
  },
  // The exchange currently selected for trading. Risk-profile state, position
  // gating, balance and ticker all scope to this exchange. User may have
  // credentials stored for multiple exchanges but only one is "active" at a time.
  activeExchange: {
    type: String,
    enum: ['bybit', 'binance', 'okx', 'bitget', 'mexc'],
    default: 'bybit',
    index: true,
  },
  // Per-exchange active risk-profile pointer — keyed by exchange id, value =
  // the profile ObjectId active on that exchange. Single source of truth for
  // "which profile is active where"; replaces the old global RiskProfile.ison
  // flag (which only ever represented one exchange at a time).
  activeRiskProfileByExchange: {
    type: Map,
    of: { type: mongoose.Schema.Types.ObjectId, ref: 'RiskProfile' },
    default: () => new Map(),
  },
  // User-global goal list. Replaces the per-RiskProfile sub-array so the
  // user's goals persist across profile switches.
  goals: { type: [goalSchema], default: [] },

  // JWT token tracking for logout
  tokens: [{
    token: String,
    createdAt: { type: Date, default: Date.now }
  }]
}, {
  timestamps: true
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Generate JWT token. Also purges any expired tokens from this.tokens
// so the array doesn't grow unbounded across logins.
userSchema.methods.generateAuthToken = function() {
  const jwt = require('jsonwebtoken');
  const token = jwt.sign(
    { userId: this._id, email: this.email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE || '7d', algorithm: 'HS256' }
  );

  // Purge expired tokens — verify each stored token against JWT_SECRET,
  // drop ones that no longer verify (expired or otherwise invalid).
  this.tokens = this.tokens.filter(t => {
    try {
      jwt.verify(t.token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
      return true;
    } catch {
      return false;
    }
  });

  this.tokens.push({ token, createdAt: Date.now() });
  return this.save().then(() => token);
};

// Remove token (logout)
userSchema.methods.removeAuthToken = function(token) {
  this.tokens = this.tokens.filter(t => t.token !== token);
  return this.save();
};

module.exports = mongoose.model('User', userSchema);
