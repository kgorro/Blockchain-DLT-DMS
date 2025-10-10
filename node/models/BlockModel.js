// node/models/BlockModel.js
const mongoose = require('mongoose');

const blockSchema = new mongoose.Schema({
  index: {
    type: Number,
    required: true,
    unique: true
  },
  timestamp: {
    type: Number,
    required: true
  },
  transactions: {
    type: Array,
    default: []
  },
  previousHash: {
    type: String,
    required: true
  },
  hash: {
    type: String,
    required: true,
    unique: true
  },
  nonce: {
    type: Number,
    default: 0
  },
  authority: {
    type: String,
    default: null
  },
  signature: {
    type: String,
    default: null
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

// Indexes for faster queries
blockSchema.index({ index: 1 });
blockSchema.index({ hash: 1 });
blockSchema.index({ timestamp: -1 });
blockSchema.index({ authority: 1 });

const BlockModel = mongoose.model('Block', blockSchema);

module.exports = BlockModel;
