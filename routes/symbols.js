const express = require('express');
const router = express.Router();
const symbolController = require('../controllers/symbolController');

// GET all trading symbols
router.get('/', symbolController.getSymbols);

module.exports = router;
