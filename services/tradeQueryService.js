const Trade = require('../models/Trade');

class TradeQueryService {
  /**
   * Get trades for a specific profile, optionally filtered.
   * options: { outcome: string|string[], source: 'app'|'external', activatedAt: Date }
   */
  async getByProfile(userId, profileId, options = {}) {
    const query = { user: userId, riskProfile: profileId };
    if (options.outcome) {
      query.outcome = Array.isArray(options.outcome) ? { $in: options.outcome } : options.outcome;
    }
    if (options.source) query.source = options.source;
    if (options.activatedAt) query.placedAt = { $gte: new Date(options.activatedAt) };
    return Trade.find(query).sort({ placedAt: 1 }).lean();
  }

  /**
   * Get closed trades (Win/Loss) for a profile within its activation window.
   * Used by performanceService for real performance metrics.
   */
  async getByActivationWindow(userId, profileId, activatedAt) {
    return Trade.find({
      user: userId,
      riskProfile: profileId,
      placedAt: { $gte: new Date(activatedAt) },
      outcome: { $in: ['Win', 'Loss'] },
    }).sort({ placedAt: 1 }).lean();
  }

  /**
   * Get all user trades across all profiles.
   * options: { outcome, source, from, to }
   */
  async getAll(userId, options = {}) {
    const query = { user: userId };
    if (options.outcome) {
      query.outcome = Array.isArray(options.outcome) ? { $in: options.outcome } : options.outcome;
    }
    if (options.source) query.source = options.source;
    if (options.from || options.to) {
      query.placedAt = {};
      if (options.from) query.placedAt.$gte = new Date(options.from);
      if (options.to) query.placedAt.$lte = new Date(options.to);
    }
    return Trade.find(query).sort({ closedAt: -1, placedAt: -1 }).lean();
  }

  async getBySymbol(userId, symbol) {
    return Trade.find({ user: userId, symbol, outcome: { $in: ['Win', 'Loss'] } })
      .sort({ placedAt: 1 }).lean();
  }

  async getBySource(userId, source) {
    return Trade.find({ user: userId, source, outcome: { $in: ['Win', 'Loss'] } })
      .sort({ placedAt: 1 }).lean();
  }

  async getByTag(userId, tag) {
    return Trade.find({ user: userId, tags: tag, outcome: { $in: ['Win', 'Loss'] } })
      .sort({ placedAt: 1 }).lean();
  }

  async getByTimeRange(userId, from, to) {
    return Trade.find({
      user: userId,
      outcome: { $in: ['Win', 'Loss'] },
      placedAt: { $gte: new Date(from), $lte: new Date(to) },
    }).sort({ placedAt: 1 }).lean();
  }
}

module.exports = TradeQueryService;
