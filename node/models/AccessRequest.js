// models/AccessRequest.js
const mongoose = require('mongoose');

const AccessRequestSchema = new mongoose.Schema({
  requestId: {
    type: String,
    required: true,
    unique: true,
    default: () => require('crypto').randomUUID()
  },
  
  // Document being requested
  document: {
    fileHash: { type: String, required: true },
    title: String,
    category: String
  },
  
  // Requester information
  requester: {
    email: { type: String, required: true },
    fullName: { type: String, required: true },
    phone: String,
    citizenId: String, // National ID, SSN, etc.
    organization: String
  },
  
  // Request details
  reason: {
    type: String,
    required: true,
    minlength: 20,
    maxlength: 1000
  },
  
  purpose: {
    type: String,
    enum: ['personal', 'research', 'legal', 'business', 'journalism', 'other'],
    required: true
  },
  
  // Status tracking
  status: {
    type: String,
    enum: ['pending', 'approved', 'denied', 'expired'],
    default: 'pending'
  },
  
  // Review
  reviewedBy: {
    username: String,
    email: String,
    role: String
  },
  
  reviewedAt: Date,
  reviewNotes: String,
  
  // Access grant details (if approved)
  accessGranted: {
    grantedAt: Date,
    expiresAt: Date,
    accessLevel: {
      type: String,
      enum: ['view-only', 'download', 'full'],
      default: 'view-only'
    }
  },
  
  // Audit trail
  ipAddress: String,
  userAgent: String,
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Index for fast queries
AccessRequestSchema.index({ 'requester.email': 1, 'document.fileHash': 1 });
AccessRequestSchema.index({ status: 1, createdAt: -1 });
AccessRequestSchema.index({ requestId: 1 });

const AccessRequest = mongoose.model('AccessRequest', AccessRequestSchema);

module.exports = AccessRequest;