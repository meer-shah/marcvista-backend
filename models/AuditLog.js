const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    // Null for unauthenticated events (e.g. failed login attempts)
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    event: {
      type: String,
      required: true,
      enum: [
        'login.success',
        'login.failure',
        'logout',
        'register',
        'credential.added',
        'credential.deleted',
        'order.placed',
        'order.cancelled',
        'order.amended',
      ],
      index: true,
    },

    // Safe context — never store secrets, API keys, or full error messages
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

    ipAddress: { type: String, default: null },
    userAgent: { type: String, default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    // Prevent accidental updates to audit records
    strict: true,
  }
);

// Compound index for timeline reconstruction: userId + timestamp
auditLogSchema.index({ userId: 1, createdAt: -1 });

// Block updates — audit records are append-only
auditLogSchema.pre('findOneAndUpdate', function () {
  throw new Error('AuditLog records are immutable.');
});
auditLogSchema.pre('updateOne', function () {
  throw new Error('AuditLog records are immutable.');
});
auditLogSchema.pre('updateMany', function () {
  throw new Error('AuditLog records are immutable.');
});

module.exports = mongoose.model('AuditLog', auditLogSchema);
