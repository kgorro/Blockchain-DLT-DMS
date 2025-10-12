// audit/AuditLogger.js
const mongoose = require('mongoose');

const AuditLogSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now, index: true },
  action: { type: String, required: true, index: true },
  actor: {
    username: String,
    role: String,
    email: String,
    ip: String,
    userAgent: String
  },
  // Store resource as Mixed type (flexible)
  resource: mongoose.Schema.Types.Mixed,
  details: mongoose.Schema.Types.Mixed,
  result: {
    success: Boolean,
    error: String
  },
  metadata: {
    nodeId: String,
    blockchainState: {
      blockCount: Number,
      lastBlockHash: String
    }
  }
}, {
  timestamps: true
});

// Create indexes for fast queries
AuditLogSchema.index({ 'actor.username': 1, timestamp: -1 });
AuditLogSchema.index({ action: 1, timestamp: -1 });

const AuditLog = mongoose.model('AuditLog', AuditLogSchema);

class AuditLogger {
  constructor(nodeId) {
    this.nodeId = nodeId;
  }

  /**
   * Log an action
   */
  async log(action, actor, resource, details = {}, result = { success: true }) {
    try {
      const log = new AuditLog({
        action,
        actor: {
          username: actor.username || 'system',
          role: actor.role || 'system',
          email: actor.email,
          ip: actor.ip,
          userAgent: actor.userAgent
        },
        resource,  // ← Just pass it directly as Mixed type
        details,
        result,
        metadata: {
          nodeId: this.nodeId,
          blockchainState: details.blockchainState
        }
      });

      await log.save();
      
      // Log critical actions to console
      if (['DELETE', 'MODIFY_BLOCKCHAIN', 'SYSTEM_CHANGE'].includes(action.split('_')[0])) {
        console.log(`🚨 CRITICAL AUDIT: ${action} by ${actor.username} (${actor.role})`);
      }
      
      return log;
    } catch (error) {
      console.error('❌ Audit logging failed:', error);
      // CRITICAL: Always log audit failures
      console.error('🚨 AUDIT LOG FAILURE:', { action, actor: actor.username, error: error.message });
    }
  }

  /**
   * Get audit logs with filters
   */
  async getLogs(filters = {}, limit = 100, skip = 0) {
    const query = {};

    if (filters.action) query.action = new RegExp(filters.action, 'i');
    if (filters.username) query['actor.username'] = new RegExp(filters.username, 'i');
    if (filters.resourceType) query['resource.type'] = filters.resourceType;
    if (filters.dateFrom) query.timestamp = { $gte: new Date(filters.dateFrom) };
    if (filters.dateTo) {
      query.timestamp = query.timestamp || {};
      query.timestamp.$lte = new Date(filters.dateTo);
    }

    const logs = await AuditLog.find(query)
      .sort({ timestamp: -1 })
      .limit(limit)
      .skip(skip)
      .lean();

    const total = await AuditLog.countDocuments(query);

    return { logs, total };
  }

  /**
   * Get user activity summary
   */
  async getUserActivity(username, days = 30) {
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - days);

    return await AuditLog.aggregate([
      {
        $match: {
          'actor.username': username,
          timestamp: { $gte: dateFrom }
        }
      },
      {
        $group: {
          _id: '$action',
          count: { $sum: 1 },
          lastOccurrence: { $max: '$timestamp' }
        }
      },
      {
        $sort: { count: -1 }
      }
    ]);
  }

  /**
   * Detect suspicious activity
   */
  async detectSuspiciousActivity() {
    const lastHour = new Date(Date.now() - 3600000);
    
    // Multiple failed login attempts
    const failedLogins = await AuditLog.countDocuments({
      action: 'AUTH_LOGIN_FAILED',
      timestamp: { $gte: lastHour }
    });

    // Rapid document uploads
    const rapidUploads = await AuditLog.aggregate([
      {
        $match: {
          action: 'DOCUMENT_UPLOAD',
          timestamp: { $gte: lastHour }
        }
      },
      {
        $group: {
          _id: '$actor.username',
          count: { $sum: 1 }
        }
      },
      {
        $match: { count: { $gt: 50 } } // More than 50 uploads in an hour
      }
    ]);

    return {
      failedLogins,
      rapidUploads,
      suspicious: failedLogins > 10 || rapidUploads.length > 0
    };
  }
}

module.exports = AuditLogger;