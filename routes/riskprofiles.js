const express = require('express');
const {
  getAllRiskProfiles,
  getSingleRiskProfile,
  createRiskProfile,
  deleteRiskProfile,
  updateRiskProfile,
  activateprofile,
  getActiveRiskProfile,
  resetdeault
} = require('../controllers/riskprofilecontroller');
const { authMiddleware } = require('../middleware/auth');
const { validateBody, validateParams } = require('../middleware/validate');
const {
  riskProfileCreateSchema,
  riskProfileUpdateSchema,
  riskProfileActivateSchema,
  riskProfileResetDefaultSchema,
  riskProfileIdParamSchema,
} = require('../validators/schemas');

const router = express.Router();

// All risk profile routes require authentication
router.use(authMiddleware);

router.get('/getactive', getActiveRiskProfile);
// Get all risk profiles
router.get('/', getAllRiskProfiles);

// Get a single risk profile
router.get('/:id', validateParams(riskProfileIdParamSchema), getSingleRiskProfile);

// Create a new risk profile
router.post('/', validateBody(riskProfileCreateSchema), createRiskProfile);
router.post('/reset-default', validateBody(riskProfileResetDefaultSchema), resetdeault);

// Delete a risk profile
router.delete('/:id', validateParams(riskProfileIdParamSchema), deleteRiskProfile);

// Update a risk profile
router.patch('/:id', validateParams(riskProfileIdParamSchema), validateBody(riskProfileUpdateSchema), updateRiskProfile);
router.put('/:id/activate', validateParams(riskProfileIdParamSchema), validateBody(riskProfileActivateSchema), activateprofile); // Activate/deactivate risk profile

module.exports = router;
