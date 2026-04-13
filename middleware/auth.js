const jwt = require('jsonwebtoken');
const User = require('../models/User');
const logger = require('../utils/logger');

const getTokenFromRequest = (req) => {
  const authHeader = req.header('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.replace('Bearer ', '');
  }

  if (req.cookies?.authToken) {
    return req.cookies.authToken;
  }

  return null;
};

const authMiddleware = async (req, res, next) => {
  try {
    const token = getTokenFromRequest(req);
    if (!token) {
      return res.status(401).json({ message: 'Authentication required. No token provided.' });
    }

    // Verify token — JWT_SECRET is guaranteed present by server startup check
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(401).json({ message: 'User no longer exists.' });
    }

    // Verify token is still active (not invalidated by logout)
    const tokenExists = user.tokens.some(t => t.token === token);
    if (!tokenExists) {
      return res.status(401).json({ message: 'Token has been invalidated. Please log in again.' });
    }

    req.user = user;
    req.authToken = token;
    next();
  } catch (error) {
    logger.error('Auth middleware error', error);
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: 'Invalid token.' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired.' });
    }
    res.status(401).json({ message: 'Authentication failed.' });
  }
};

// Optional auth — allows both authenticated and unauthenticated access
const optionalAuth = async (req, res, next) => {
  try {
    const token = getTokenFromRequest(req);
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.userId);
      if (user) {
        req.user = user;
        req.authToken = token;
      }
    }
  } catch {
    // Silently ignore errors — this is optional auth
  }
  next();
};

module.exports = { authMiddleware, optionalAuth };
