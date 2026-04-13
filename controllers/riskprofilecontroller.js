/**
 * Risk profile controller — thin orchestration layer.
 *
 * All business logic lives in RiskProfileService.
 * This file only handles req/res translation and HTTP status codes.
 */
const RiskProfileService = require('../services/RiskProfileService');
const logger = require('../utils/logger');

const service = new RiskProfileService();

// Get all risk profiles (paginated)
const getAllRiskProfiles = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const result = await service.getAll(req.user._id, { page, limit });
    res.status(200).json(result);
  } catch (error) {
    logger.error('Error fetching risk profiles', error);
    res.status(500).json({ message: 'Error fetching risk profiles' });
  }
};

// Get a single risk profile
const getSingleRiskProfile = async (req, res) => {
  try {
    const result = await service.getById(req.user._id, req.params.id);
    if (result.error) return res.status(result.status).json({ message: result.error });
    res.status(200).json(result.data);
  } catch (error) {
    logger.error('Error fetching risk profile', error);
    res.status(500).json({ message: 'Error fetching risk profile' });
  }
};

// Create a new risk profile
const createRiskProfile = async (req, res) => {
  try {
    const result = await service.create(req.user._id, req.body);
    res.status(201).json({ message: 'New risk profile created', data: result.data });
  } catch (error) {
    logger.error('Error creating risk profile', error);
    res.status(500).json({ message: 'Error creating risk profile' });
  }
};

// Delete a risk profile
const deleteRiskProfile = async (req, res) => {
  try {
    const result = await service.delete(req.user._id, req.params.id);
    if (result.error) return res.status(result.status).json({ message: result.error });
    res.status(200).json({ message: 'Risk profile deleted successfully', data: result.data });
  } catch (error) {
    logger.error('Error deleting risk profile', error);
    res.status(500).json({ message: 'Error deleting risk profile' });
  }
};

// Update a risk profile
const updateRiskProfile = async (req, res) => {
  try {
    const result = await service.update(req.user._id, req.params.id, req.body);
    if (result.error) return res.status(result.status).json({ message: result.error });
    res.status(200).json({ message: 'Risk profile updated', data: result.data });
  } catch (error) {
    logger.error('Error updating risk profile', error);
    res.status(500).json({ message: 'Error updating risk profile' });
  }
};

// Get active risk profile
const getActiveRiskProfile = async (req, res) => {
  try {
    const result = await service.getActive(req.user._id);
    if (result.error) return res.status(result.status).json({ message: result.error });
    res.status(200).json(result.data);
  } catch (error) {
    logger.error('Error fetching active risk profile', error);
    res.status(500).json({ message: 'Error fetching active risk profile' });
  }
};

// Activate/deactivate a risk profile
const activateprofile = async (req, res) => {
  try {
    const result = await service.activate(req.user._id, req.params.id, req.body.ison);
    if (result.error) return res.status(result.status).json({ message: result.error });
    res.status(200).json({ message: result.message, data: result.data });
  } catch (error) {
    logger.error('Error in activateprofile', error);
    res.status(500).json({ message: 'Error updating risk profile' });
  }
};

// Reset default profile
const resetdeault = async (req, res) => {
  try {
    const result = await service.resetDefault(req.user._id, req.body.id);
    if (result.error) return res.status(result.status).json({ [result.status < 500 ? 'error' : 'message']: result.error });
    res.status(200).json({ message: result.message, updatedProfile: result.data });
  } catch (error) {
    logger.error('Error resetting default profile', error);
    res.status(500).json({ error: 'Failed to reset default profile.' });
  }
};

module.exports = {
  getAllRiskProfiles,
  getSingleRiskProfile,
  createRiskProfile,
  deleteRiskProfile,
  updateRiskProfile,
  activateprofile,
  getActiveRiskProfile,
  resetdeault
};
