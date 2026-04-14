const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const User = require('../models/User');
const RiskProfile = require('../models/riskprofilemodal');
const { authMiddleware, optionalAuth } = require('../middleware/auth');
const { validateBody } = require('../middleware/validate');
const { registerSchema, loginSchema } = require('../validators/schemas');
const logger = require('../utils/logger');
const { writeAuditLog } = require('../utils/audit');
const { generateToken: generateCsrfToken } = require('../utils/csrf');

const isProduction = process.env.NODE_ENV === 'production';
const authCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  // 'none' required for cross-domain deployments (frontend on Vercel, backend on Render etc.)
  // CSRF protection is provided independently by a stateless HMAC token (see utils/csrf.js).
  // In dev, 'strict' is fine since both run on localhost.
  sameSite: isProduction ? 'none' : 'strict',
  path: '/',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

// Limit login and register to 10 attempts per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please try again after 15 minutes.' }
});

router.get('/csrf-token', (req, res) => {
  res.json({ csrfToken: generateCsrfToken() });
});

// Register new user
router.post('/register', authLimiter, validateBody(registerSchema), async (req, res) => {
  try {
    const { email, password, name, phone } = req.body;

    // Check if user exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'User with this email already exists.' });
    }

    // Create new user
    const user = new User({ email, password, name, phone });
    await user.save();

    // Provision a default starter risk profile for the new user
    await RiskProfile.create({
      user: user._id,
      title: 'Starter Profile',
      description: 'Default risk profile created on account setup.',
      initialRiskPerTrade: 1,
      increaseOnWin: 0.5,
      decreaseOnLoss: 0.5,
      maxRisk: 5,
      minRisk: 0.5,
      SLallowedperday: 3,
      reset: 100000,
      growthThreshold: 10,
      payoutPercentage: 50,
      minRiskRewardRatio: 1.5,
      noofactivetrades: 3,
      ison: true,
      default: true,
    });

    // Generate token
    const token = await user.generateAuthToken();
    res.cookie('authToken', token, authCookieOptions);

    writeAuditLog({ event: 'register', userId: user._id, metadata: { email: user.email }, req });

    res.status(201).json({
      message: 'User registered successfully.',
      user: {
        id: user._id,
        email: user.email,
        name: user.name
      }
    });
  } catch (error) {
    logger.error('Registration error', error);
    res.status(500).json({ message: 'Failed to register user.' });
  }
});

// Login
router.post('/login', authLimiter, validateBody(loginSchema), async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      writeAuditLog({ event: 'login.failure', metadata: { reason: 'user_not_found' }, req });
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    // Verify password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      writeAuditLog({ event: 'login.failure', userId: user._id, metadata: { reason: 'bad_password' }, req });
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    // Generate new token
    const token = await user.generateAuthToken();
    res.cookie('authToken', token, authCookieOptions);

    writeAuditLog({ event: 'login.success', userId: user._id, req });

    res.json({
      message: 'Login successful.',
      user: {
        id: user._id,
        email: user.email,
        name: user.name
      }
    });
  } catch (error) {
    logger.error('Login error', error);
    res.status(500).json({ message: 'Failed to login.' });
  }
});

// Logout (invalidate token)
router.post('/logout', optionalAuth, async (req, res) => {
  try {
    if (!req.user) {
      return res.json({ message: 'Already logged out (no active session).' });
    }

    if (req.authToken) {
      await req.user.removeAuthToken(req.authToken);
    }
    res.clearCookie('authToken', authCookieOptions);

    writeAuditLog({ event: 'logout', userId: req.user._id, req });

    res.json({ message: 'Logged out successfully.' });
  } catch (error) {
    logger.error('Logout error', error);
    res.status(500).json({ message: 'Failed to logout.' });
  }
});

// Get current user
router.get('/me', optionalAuth, async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: 'Not authenticated.' });
    }

    res.json({
      user: {
        id: req.user._id,
        email: req.user.email,
        name: req.user.name,
        phone: req.user.phone,
        profilePicture: req.user.profilePicture
      }
    });
  } catch (error) {
    logger.error('Get user error', error);
    res.status(500).json({ message: 'Failed to fetch user.' });
  }
});

// Update profile (name + phone + profilePicture)
router.put('/profile', authMiddleware, async (req, res) => {
  try {
    const { name, phone, profilePicture } = req.body;
    if (name !== undefined) req.user.name = name.trim();
    if (phone !== undefined) req.user.phone = phone ? phone.trim() : '';
    if (profilePicture !== undefined) req.user.profilePicture = profilePicture;
    await req.user.save();
    res.json({
      message: 'Profile updated successfully.',
      user: {
        id: req.user._id,
        email: req.user.email,
        name: req.user.name,
        phone: req.user.phone,
        profilePicture: req.user.profilePicture
      }
    });
  } catch (error) {
    logger.error('Profile update error', error);
    res.status(500).json({ message: 'Failed to update profile.' });
  }
});

module.exports = router;
