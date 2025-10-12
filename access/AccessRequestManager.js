// access/AccessRequestManager.js
const AccessRequest = require('../models/AccessRequest');
const crypto = require('crypto');

class AccessRequestManager {
  constructor(auditLogger) {
    this.auditLogger = auditLogger;
  }

  /**
   * Submit access request (no login required)
   */
  async submitRequest(documentInfo, requesterInfo, requestDetails, metadata) {
    try {
      // Check if user already has pending request for this document
      const existingRequest = await AccessRequest.findOne({
        'requester.email': requesterInfo.email,
        'document.fileHash': documentInfo.fileHash,
        status: 'pending'
      });

      if (existingRequest) {
        return {
          success: false,
          error: 'You already have a pending request for this document',
          existingRequest: existingRequest.requestId
        };
      }

      // Create new request
      const request = new AccessRequest({
        document: {
          fileHash: documentInfo.fileHash,
          title: documentInfo.title,
          category: documentInfo.category
        },
        requester: {
          email: requesterInfo.email,
          fullName: requesterInfo.fullName,
          phone: requesterInfo.phone,
          citizenId: requesterInfo.citizenId,
          organization: requesterInfo.organization
        },
        reason: requestDetails.reason,
        purpose: requestDetails.purpose,
        ipAddress: metadata.ip,
        userAgent: metadata.userAgent
      });

      await request.save();

      // Log to audit
      if (this.auditLogger) {
        await this.auditLogger.log(
          'ACCESS_REQUEST_SUBMITTED',
          {
            username: 'anonymous',
            role: 'citizen',
            email: requesterInfo.email,
            ip: metadata.ip,
            userAgent: metadata.userAgent
          },
          {
            type: 'access_request',
            id: request.requestId,
            documentHash: documentInfo.fileHash
          },
          {
            requesterName: requesterInfo.fullName,
            purpose: requestDetails.purpose
          },
          { success: true }
        );
      }

      // Send notification to admins (email, dashboard alert, etc.)
      await this.notifyAdmins(request);

      return {
        success: true,
        requestId: request.requestId,
        message: 'Access request submitted successfully',
        estimatedReviewTime: '2-3 business days'
      };

    } catch (error) {
      console.error('Access request error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Review access request (admin only)
   */
  async reviewRequest(requestId, reviewerInfo, decision, notes) {
    try {
      const request = await AccessRequest.findOne({ requestId });

      if (!request) {
        return { success: false, error: 'Request not found' };
      }

      if (request.status !== 'pending') {
        return { success: false, error: 'Request already reviewed' };
      }

      // Update request
      request.status = decision; // 'approved' or 'denied'
      request.reviewedBy = {
        username: reviewerInfo.username,
        email: reviewerInfo.email,
        role: reviewerInfo.role
      };
      request.reviewedAt = new Date();
      request.reviewNotes = notes;

      if (decision === 'approved') {
        request.accessGranted = {
          grantedAt: new Date(),
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
          accessLevel: 'download'
        };
      }

      request.updatedAt = new Date();
      await request.save();

      // Log to audit
      if (this.auditLogger) {
        await this.auditLogger.log(
          `ACCESS_REQUEST_${decision.toUpperCase()}`,
          {
            username: reviewerInfo.username,
            role: reviewerInfo.role,
            email: reviewerInfo.email,
            ip: reviewerInfo.ip
          },
          {
            type: 'access_request',
            id: requestId,
            documentHash: request.document.fileHash
          },
          {
            requesterEmail: request.requester.email,
            reviewNotes: notes
          },
          { success: true }
        );
      }

      // Notify requester
      await this.notifyRequester(request, decision);

      return {
        success: true,
        request,
        message: `Request ${decision}`
      };

    } catch (error) {
      console.error('Review error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if email has access to document
   */
  async checkAccess(email, fileHash) {
    const approvedRequest = await AccessRequest.findOne({
      'requester.email': email,
      'document.fileHash': fileHash,
      status: 'approved',
      'accessGranted.expiresAt': { $gt: new Date() }
    });

    return {
      hasAccess: !!approvedRequest,
      request: approvedRequest,
      expiresAt: approvedRequest?.accessGranted?.expiresAt
    };
  }

  /**
   * Get all pending requests (admin)
   */
  async getPendingRequests() {
    return await AccessRequest.find({ status: 'pending' })
      .sort({ createdAt: -1 })
      .limit(100);
  }

  /**
   * Get request status (by request ID or email)
   */
  async getRequestStatus(requestId, email) {
    if (requestId) {
      return await AccessRequest.findOne({ requestId });
    }
    
    if (email) {
      return await AccessRequest.find({ 'requester.email': email })
        .sort({ createdAt: -1 });
    }

    return null;
  }

  /**
   * Notify admins of new request
   */
  async notifyAdmins(request) {
    // TODO: Implement email notification
    console.log(`📧 New access request from ${request.requester.email} for "${request.document.title}"`);
    
    // Could integrate with:
    // - Email service
    // - Slack/Teams webhook
    // - SMS
    // - Dashboard notification system
  }

  /**
   * Notify requester of decision
   */
  async notifyRequester(request, decision) {
    // TODO: Implement email notification
    console.log(`📧 Notifying ${request.requester.email}: Request ${decision}`);
  }
}

module.exports = AccessRequestManager;