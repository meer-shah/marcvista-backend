const ApiConnection = require('../models/ApiConnection');
const User = require('../models/User');
const { clearCredentialCache, getBaseUrl } = require('../config/bybitConfig');
const { clearCache: clearMultiExchangeCache, listConnectedExchanges } = require('../config/credentials');
const { getBroker, listExchanges } = require('../services/brokers');
const crypto = require('crypto');
const axios = require('axios');
const logger = require('../utils/logger');
const { writeAuditLog } = require('../utils/audit');

const SUPPORTED_EXCHANGES = ['bybit', 'binance', 'okx', 'bitget', 'mexc'];
const EXCHANGES_REQUIRING_PASSPHRASE = new Set(['okx', 'bitget']);

// Helper to verify Bybit credentials by making a test API call
async function verifyBybitCredentials(apiKey, secretKey, accountType = 'demo') {
  const baseUrl = accountType === 'live' ? 'https://api.bybit.com' : 'https://api-demo.bybit.com';
  const timestamp = Date.now().toString();
  const recvWindow = '5000';
  const queryString = 'accountType=UNIFIED';
  const body = '';

  // Generate signature (Bybit V5): timestamp + apiKey + recvWindow + queryString + body
  const sign_string = timestamp + apiKey + recvWindow + queryString + body;
  const signature = crypto.createHmac('sha256', secretKey)
                          .update(sign_string)
                          .digest('hex');

  const url = `${baseUrl}/v5/account/wallet-balance?${queryString}`;

  try {
    const response = await axios.get(url, {
      headers: {
        'X-BAPI-SIGN': signature,
        'X-BAPI-API-KEY': apiKey,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': recvWindow
      },
      timeout: 15000 // 15 second timeout (Render can be slow)
    });

    // Bybit returns retCode 0 on success
    return {
      valid: response.status === 200 && response.data?.retCode === 0,
      data: response.data
    };
  } catch (error) {
    const errorMsg = error.response?.data?.retMsg || error.message || error.code;
    logger.info('Bybit verification failed', {
      accountType,
      baseUrl,
      errorCode: error.code,
      status: error.response?.status,
      message: errorMsg,
      retCode: error.response?.data?.retCode,
    });
    return {
      valid: false,
      error: errorMsg,
      status: error.response?.status
    };
  }
}

// Controller to add API Key and Secret Key
exports.addApiConnection = async (req, res) => {
  let { apiKey, secretKey, accountType = 'demo' } = req.body;

  try {
    // Sanitize inputs: Trim whitespace but preserve hyphens and underscores
    const sanitizeInput = (input) => input.trim();

    apiKey = sanitizeInput(apiKey);
    secretKey = sanitizeInput(secretKey);

    // Validate inputs are not empty
    if (!apiKey || !secretKey) {
      return res.status(400).json({
        message: 'API Key and Secret Key are required.',
      });
    }

    // Check if any record already exists for this user
    const existingConnection = await ApiConnection.findOne({ user: req.user._id });
    if (existingConnection) {
      return res.status(400).json({
        message: 'API Key and Secret Key already exist. Delete the existing one to add new credentials.',
      });
    }

    // Validate accountType
    if (!['demo', 'live'].includes(accountType)) {
      accountType = 'demo';
    }

    // Verify credentials with Bybit BEFORE saving
    const verification = await verifyBybitCredentials(apiKey, secretKey, accountType);

    if (!verification.valid) {
      return res.status(400).json({
        message: 'Invalid Bybit credentials. Could not verify with Bybit.',
        error: verification.error || 'Verification failed',
        status: verification.status
      });
    }

    // Create and save new record with user association
    const newConnection = new ApiConnection({
      user: req.user._id,
      apiKey,
      secretKey,
      accountType
    });
    await newConnection.save();
    await clearCredentialCache(); // Clear cached credentials

    writeAuditLog({ event: 'credential.added', userId: req.user._id, req });

    res.status(201).json({
      message: 'API Key and Secret Key added successfully and verified with Bybit.',
      data: {
        _id: newConnection._id,
        createdAt: newConnection.createdAt
      },
    });
  } catch (error) {
    logger.error('Error in addApiConnection', error);
    res.status(500).json({
      message: 'Error adding API Key and Secret Key.',
    });
  }
};

// Controller to check whether an API connection exists for the current user.
// Never returns the stored keys — only metadata.
exports.getApiConnection = async (req, res) => {
  try {
    const connection = await ApiConnection.findOne({ user: req.user._id });
    if (!connection) {
      return res.status(404).json({
        message: 'No API Key and Secret Key found.',
      });
    }

    res.status(200).json({
      data: {
        _id: connection._id,
        accountType: connection.accountType || 'demo',
        createdAt: connection.createdAt,
        updatedAt: connection.updatedAt
      },
    });
  } catch (error) {
    res.status(500).json({
      message: 'Error fetching API connection.',
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Multi-exchange endpoints — Phase 3
//
// Existing addApiConnection / getApiConnection / deleteApiConnection above
// remain for backwards compat (they implicitly target 'bybit'). The new
// endpoints below are exchange-aware and should be preferred by the UI.
// ─────────────────────────────────────────────────────────────────────────────

/** Static metadata for the Connection UI to render its exchange list. */
exports.listSupportedExchanges = async (req, res) => {
  res.json({ exchanges: listExchanges() });
};

/** What exchanges this user has credentials for, and the user's active one. */
exports.getConnectionStatus = async (req, res) => {
  try {
    const connections = await listConnectedExchanges(req.user._id);
    const user = await User.findById(req.user._id).select('activeExchange').lean();
    res.json({
      activeExchange: user?.activeExchange || 'bybit',
      connections, // [{exchange, mode, updatedAt}]
    });
  } catch (err) {
    logger.error('Error in getConnectionStatus', err);
    res.status(500).json({ message: 'Error fetching connection status.' });
  }
};

/**
 * Verify credentials by asking the broker for the USDT balance.
 * If it returns without throwing, creds are valid.
 */
async function verifyExchangeCredentials(broker, ctx) {
  try {
    const balance = await broker.getUsdtBalance(ctx);
    return { valid: true, balance };
  } catch (err) {
    return { valid: false, error: err?.message || 'Verification failed' };
  }
}

/**
 * POST /api/connection/:exchange — add or replace credentials for one exchange.
 * Body: { apiKey, secretKey, passphrase?, mode: 'demo'|'real' }
 * The broker is called immediately with the new creds to verify them before
 * persisting; failure returns 400 with the exchange's error message.
 */
exports.connectExchange = async (req, res) => {
  const exchange = String(req.params.exchange || '').toLowerCase();
  if (!SUPPORTED_EXCHANGES.includes(exchange)) {
    return res.status(400).json({ message: `Unsupported exchange: ${exchange}` });
  }
  let { apiKey, secretKey, passphrase = null, mode = 'demo' } = req.body || {};
  apiKey = (apiKey || '').trim();
  secretKey = (secretKey || '').trim();
  passphrase = passphrase ? String(passphrase).trim() : null;
  if (!apiKey || !secretKey) {
    return res.status(400).json({ message: 'apiKey and secretKey are required.' });
  }
  if (EXCHANGES_REQUIRING_PASSPHRASE.has(exchange) && !passphrase) {
    return res.status(400).json({ message: `${exchange} requires a passphrase.` });
  }
  if (!['demo', 'real'].includes(mode)) mode = 'demo';

  try {
    // Persist temporarily so the broker can read via getExchangeCredentials.
    // Use a transactional dance: upsert, verify, rollback on failure.
    const existing = await ApiConnection.findOne({ user: req.user._id, exchange });
    const previousState = existing ? existing.toObject() : null;

    if (existing) {
      existing.apiKey = apiKey;
      existing.secretKey = secretKey;
      existing.passphrase = passphrase || null;
      existing.mode = mode;
      existing.accountType = mode === 'real' ? 'live' : 'demo';
      await existing.save();
    } else {
      await ApiConnection.create({
        user: req.user._id,
        exchange,
        apiKey,
        secretKey,
        passphrase: passphrase || null,
        mode,
        accountType: mode === 'real' ? 'live' : 'demo',
      });
    }
    clearMultiExchangeCache(req.user._id, exchange);

    const broker = getBroker(exchange);
    const verification = await verifyExchangeCredentials(broker, { userId: String(req.user._id), mode });

    if (!verification.valid) {
      // Roll back: restore previous state or delete the new row.
      if (previousState) {
        await ApiConnection.updateOne(
          { user: req.user._id, exchange },
          {
            $set: {
              apiKey: previousState.apiKey,
              secretKey: previousState.secretKey,
              passphrase: previousState.passphrase,
              mode: previousState.mode,
              accountType: previousState.accountType,
            },
          }
        );
      } else {
        await ApiConnection.deleteOne({ user: req.user._id, exchange });
      }
      clearMultiExchangeCache(req.user._id, exchange);
      return res.status(400).json({
        message: `Invalid ${exchange} credentials.`,
        error: verification.error,
      });
    }

    writeAuditLog({ event: 'credential.added', userId: req.user._id, metadata: { exchange, mode }, req });
    res.status(201).json({
      message: `${exchange} credentials saved and verified.`,
      exchange,
      mode,
      balance: verification.balance,
    });
  } catch (err) {
    logger.error('Error in connectExchange', { exchange, message: err?.message });
    res.status(500).json({ message: `Error saving ${exchange} credentials.` });
  }
};

/** DELETE /api/connection/:exchange — disconnect a specific exchange. */
exports.disconnectExchange = async (req, res) => {
  const exchange = String(req.params.exchange || '').toLowerCase();
  if (!SUPPORTED_EXCHANGES.includes(exchange)) {
    return res.status(400).json({ message: `Unsupported exchange: ${exchange}` });
  }
  try {
    const result = await ApiConnection.deleteOne({ user: req.user._id, exchange });
    clearMultiExchangeCache(req.user._id, exchange);
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: `No ${exchange} credentials to delete.` });
    }
    writeAuditLog({ event: 'credential.deleted', userId: req.user._id, metadata: { exchange }, req });
    res.json({ message: `${exchange} disconnected.` });
  } catch (err) {
    logger.error('Error in disconnectExchange', err);
    res.status(500).json({ message: `Error disconnecting ${exchange}.` });
  }
};

/** POST /api/connection/active-exchange  body: { exchange } */
exports.setActiveExchange = async (req, res) => {
  const exchange = String(req.body?.exchange || '').toLowerCase();
  if (!SUPPORTED_EXCHANGES.includes(exchange)) {
    return res.status(400).json({ message: `Unsupported exchange: ${exchange}` });
  }
  try {
    const connection = await ApiConnection.findOne({ user: req.user._id, exchange });
    if (!connection) {
      return res.status(400).json({ message: `${exchange} not connected — add credentials first.` });
    }

    // Switch the user's active exchange + restore that exchange's previously-
    // chosen risk profile. Each exchange remembers its own active profile in
    // user.activeRiskProfileByExchange — switching back must surface the
    // profile that was active there, NOT whatever was active on the prior
    // exchange. RiskProfile.ison is rewritten so legacy reads still work.
    const user = await User.findById(req.user._id).select('activeRiskProfileByExchange activeExchange');
    if (!user) return res.status(404).json({ message: 'User not found.' });

    user.activeExchange = exchange;

    // Look up which profile should be active on the new exchange. Two cases:
    //  (a) Map has an entry → flip ison to that profile.
    //  (b) No entry yet (first switch to this exchange) → leave the current
    //      globally-active profile as-is and seed the map with it.
    const RiskProfile = require('../models/riskprofilemodal');
    let targetProfileId = user.activeRiskProfileByExchange
      ? user.activeRiskProfileByExchange.get(exchange)
      : null;

    if (!targetProfileId) {
      const currentlyOn = await RiskProfile.findOne({ user: req.user._id, ison: true }).select('_id').lean();
      if (currentlyOn) {
        targetProfileId = currentlyOn._id;
        if (!user.activeRiskProfileByExchange) user.activeRiskProfileByExchange = new Map();
        user.activeRiskProfileByExchange.set(exchange, currentlyOn._id);
      }
    }

    if (targetProfileId) {
      // Flip ison flags atomically — exactly one ison:true per user at any moment.
      await RiskProfile.updateMany(
        { user: req.user._id, ison: true, _id: { $ne: targetProfileId } },
        { $set: { ison: false } }
      );
      await RiskProfile.updateOne(
        { _id: targetProfileId, user: req.user._id },
        { $set: { ison: true } }
      );
    }

    await user.save();
    res.json({ activeExchange: exchange, activeRiskProfile: targetProfileId || null });
  } catch (err) {
    logger.error('Error in setActiveExchange', err);
    res.status(500).json({ message: 'Error setting active exchange.' });
  }
};

/**
 * GET /api/connection/balances — aggregate USDT balance across every
 * exchange the user has credentials for. Used by the portfolio page to
 * show cumulative balance + per-exchange breakdown when filter='all'.
 */
exports.getAllBalances = async (req, res) => {
  try {
    const connections = await listConnectedExchanges(req.user._id);
    const results = await Promise.allSettled(
      connections.map(async ({ exchange, mode }) => {
        const broker = getBroker(exchange);
        const balance = await broker.getUsdtBalance({ userId: String(req.user._id), mode });
        return { exchange, mode, balance, ok: true };
      })
    );
    const balances = results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      return { exchange: connections[i].exchange, mode: connections[i].mode, balance: 0, ok: false, error: r.reason?.message };
    });
    const total = balances.reduce((s, b) => s + (b.ok ? b.balance : 0), 0);
    res.json({ total, balances });
  } catch (err) {
    logger.error('Error in getAllBalances', err);
    res.status(500).json({ message: 'Failed to fetch balances.' });
  }
};

/** GET /api/connection/active-exchange — quick fetch for header / chart prefix. */
exports.getActiveExchange = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('activeExchange').lean();
    res.json({ activeExchange: user?.activeExchange || 'bybit' });
  } catch (err) {
    logger.error('Error in getActiveExchange', err);
    res.status(500).json({ message: 'Error fetching active exchange.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Legacy single-exchange endpoint kept for back-compat
// ─────────────────────────────────────────────────────────────────────────────

// Controller to delete API Key and Secret Key for current user
exports.deleteApiConnection = async (req, res) => {
  try {
    const connection = await ApiConnection.findOne({ user: req.user._id });
    if (!connection) {
      return res.status(404).json({
        message: 'No API Key and Secret Key found to delete.',
      });
    }

    await ApiConnection.deleteOne({ _id: connection._id });
    await clearCredentialCache(); // Clear cached credentials

    writeAuditLog({ event: 'credential.deleted', userId: req.user._id, req });

    res.status(200).json({
      message: 'API Key and Secret Key deleted successfully.',
    });
  } catch (error) {
    logger.error('Error in deleteApiConnection', error);
    res.status(500).json({ message: 'Error deleting API Key and Secret Key.' });
  }
};
