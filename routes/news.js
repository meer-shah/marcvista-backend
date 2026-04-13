const express = require('express');
const router = express.Router();
const newsController = require('../controllers/newsController');

// GET most recent crypto news (public, cached by backend if needed)
router.get('/', newsController.getNews);

module.exports = router;
