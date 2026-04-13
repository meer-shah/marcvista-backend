const mongoose = require('mongoose');
const { encrypt } = require('../config/encryption');

const ApiConnectionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true
    },
    apiKey: {
      type: String,
      required: true,
      trim: true,
    },
    secretKey: {
      type: String,
      required: true,
      trim: true,
    },
    accountType: {
      type: String,
      enum: ['demo', 'live'],
      default: 'demo'
    },
  },
  { timestamps: true }
);

// Encrypt API keys before persisting to the database
ApiConnectionSchema.pre('save', function (next) {
  if (this.isModified('apiKey')) {
    this.apiKey = encrypt(this.apiKey);
  }
  if (this.isModified('secretKey')) {
    this.secretKey = encrypt(this.secretKey);
  }
  next();
});

module.exports = mongoose.model('ApiConnection', ApiConnectionSchema);
