const express = require('express');
require('dotenv').config();
const Sentry = require('@sentry/node');
const logger = require('./utils/logger');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { csrfMiddleware } = require('./utils/csrf');
const mongoose = require('mongoose');
const riskProfileRoutes = require('./routes/riskprofiles');
const orderRoutes = require('./routes/order');
const goalRoutes = require('./routes/goal');
const apiConnectionRoutes = require('./routes/api');
const symbolsRoutes = require('./routes/symbols');
const authRoutes = require('./routes/auth');
const newsRoutes = require('./routes/news');

// Validate required environment variables before starting
const requiredEnvVars = ['JWT_SECRET', 'ENCRYPTION_KEY', 'MONGO_URI', 'PORT'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  // logger not yet initialised here, so use console.error directly
  console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), message: 'Missing required environment variables', vars: missingVars }));
  process.exit(1);
}

// Sentry — must be initialised before any other middleware or routes.
// SENTRY_DSN is optional; if absent, Sentry is a no-op (safe for local dev).
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    // Capture 100% of transactions in production; reduce if volume is high
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
  });
}

const app = express();
const isProduction = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1); // Trust only the first proxy (Render's load balancer)

// Security headers
app.use(helmet({
  hsts: isProduction
    ? {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
      }
    : false,
}));

// Enforce HTTPS in production
app.use((req, res, next) => {
  if (isProduction && !req.secure) {
    return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  }
  next();
});

// CORS — restrict to known frontend origins
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(o => o.trim())
  : ['http://localhost:8080', 'http://localhost:8081', 'http://localhost:5173', 'http://localhost:3000'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. server-to-server, Postman)
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error(`CORS policy: origin ${origin} is not allowed`));
  },
  credentials: true
}));

// Body parsing — 10kb for most routes; profile route accepts up to 3mb for base64 images
app.use((req, res, next) => {
  const limit = req.path === '/api/auth/profile' ? '3mb' : '10kb';
  express.json({ limit })(req, res, next);
});
app.use(cookieParser());

// CSRF protection — stateless HMAC (see utils/csrf.js for rationale)
app.use(csrfMiddleware);

// Request logging
app.use((req, _res, next) => {
  logger.info('request', { method: req.method, path: req.path });
  next();
});

// Health / readiness probes (no auth, no CSRF — skipped automatically for GET)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/ready', (_req, res) => {
  // readyState 1 = connected
  if (mongoose.connection.readyState === 1) {
    return res.json({ status: 'ready', db: 'connected' });
  }
  res.status(503).json({ status: 'not ready', db: 'disconnected' });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/riskprofiles', riskProfileRoutes);
app.use('/api/order', orderRoutes);
app.use('/api/goal', goalRoutes);
app.use('/api/connection', apiConnectionRoutes);
app.use('/api/symbols', symbolsRoutes);
app.use('/api/news', newsRoutes);

// Global error handler — never leak internal error details to the client
app.use((err, req, res, next) => {
  // Forward unhandled errors to Sentry before responding
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(err);
  }
  logger.error('Unhandled server error', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found', path: req.path });
});

// Connect to MongoDB then start listening
mongoose.connect(process.env.MONGO_URI, {
  maxPoolSize: 50,      // max concurrent connections in the pool
  minPoolSize: 5,       // keep at least 5 connections warm
  serverSelectionTimeoutMS: 5000,  // fail fast if MongoDB is unreachable
  socketTimeoutMS: 45000,          // drop idle sockets after 45 s
})
  .then(() => {
    app.listen(process.env.PORT, () => {
      logger.info('server started', { port: process.env.PORT });
    });
  })
  .catch((error) => {
    logger.error('MongoDB connection error', error);
    process.exit(1);
  });

// Graceful shutdown — close Mongoose cleanly
const shutdown = async (signal) => {
  logger.info('shutdown signal received', { signal });
  await mongoose.disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
