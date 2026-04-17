const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

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
    { expiresIn: process.env.JWT_EXPIRE || '7d' }
  );

  // Purge expired tokens — verify each stored token against JWT_SECRET,
  // drop ones that no longer verify (expired or otherwise invalid).
  this.tokens = this.tokens.filter(t => {
    try {
      jwt.verify(t.token, process.env.JWT_SECRET);
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
