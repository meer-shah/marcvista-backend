const ApiConnection = require('../models/ApiConnection');
const { clearCredentialCache, getBaseUrl } = require('../config/bybitConfig');
const crypto = require('crypto');
const axios = require('axios');
const logger = require('../utils/logger');
const { writeAuditLog } = require('../utils/audit');

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
      responseData: error.response?.data
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
