// middleware/documentAccess.js

const AccessRequest = require('../models/AccessRequest');

/**
 * Check if user/email can access document
 * Supports both authenticated users AND email-based access
 * 
 * @param {Object|null} user - Authenticated user object (can be null for guests)
 * @param {Object} document - Document object from blockchain
 * @param {String|null} email - Email address for non-authenticated access
 * @returns {Object} - { allowed: boolean, reason: string, level: string }
 */
async function canAccessDocument(user, document, email = null) {
  // System admin can access everything
  if (user && user.role === 'admin') {
    return { 
      allowed: true, 
      reason: 'System administrator', 
      level: 'full' 
    };
  }

  const accessControl = document.accessControl;
  
  // Legacy documents without access control - default to admin only
  if (!accessControl) {
    return { 
      allowed: user && user.role === 'admin', 
      reason: 'Legacy document - admin only',
      level: user && user.role === 'admin' ? 'full' : 'metadata'
    };
  }

  // ===== CRITICAL: PUBLIC documents - everyone gets FULL access =====
  if (accessControl.isPublic || accessControl.privacyLevel === 'public') {
    return { 
      allowed: true, 
      reason: 'Public document', 
      level: 'full'  // ← FULL access for public docs!
    };
  }

  // Rest of the function stays the same...
  // (Keep all your existing checks for expiry, roles, citizens, etc.)
  
  // Check if document has expired and become public
  if (accessControl.expiryDate) {
    const expiryDate = new Date(accessControl.expiryDate);
    if (new Date() > expiryDate) {
      return { 
        allowed: true, 
        reason: 'Document expired to public domain', 
        level: 'full' 
      };
    }
  }

  const userEmail = user?.email || email;

  // Check authenticated user access
  if (user) {
    if (accessControl.allowedRoles && 
        Array.isArray(accessControl.allowedRoles) && 
        accessControl.allowedRoles.includes(user.role)) {
      return { 
        allowed: true, 
        reason: 'Role-based access granted', 
        level: 'full' 
      };
    }

    if (user.department && 
        document.department && 
        document.department === user.department) {
      return { 
        allowed: true, 
        reason: 'Same department access', 
        level: 'full' 
      };
    }

    if (document.uploadedByEmail && 
        user.email && 
        document.uploadedByEmail.toLowerCase() === user.email.toLowerCase()) {
      return { 
        allowed: true, 
        reason: 'Document owner', 
        level: 'full' 
      };
    }
  }

  // Check citizen-specific access
  if (userEmail && accessControl.privacyLevel === 'citizen-specific') {
    if (accessControl.specificCitizens && 
        Array.isArray(accessControl.specificCitizens)) {
      const hasAccess = accessControl.specificCitizens.some(
        citizenEmail => citizenEmail.toLowerCase() === userEmail.toLowerCase()
      );
      
      if (hasAccess) {
        return { 
          allowed: true, 
          reason: 'Citizen-specific access granted', 
          level: 'full' 
        };
      }
    }
    
    if (document.recipient && 
        userEmail && 
        document.recipient.toLowerCase() === userEmail.toLowerCase()) {
      return { 
        allowed: true, 
        reason: 'Document recipient', 
        level: 'full' 
      };
    }
  }

  // Check approved access requests
  if (userEmail && document.fileHash) {
    try {
      const accessRequest = await AccessRequest.findOne({
        'requester.email': userEmail,
        'document.fileHash': document.fileHash,
        status: 'approved',
        'accessGranted.expiresAt': { $gt: new Date() }
      });

      if (accessRequest) {
        return { 
          allowed: true, 
          reason: 'Approved access request', 
          level: accessRequest.accessGranted.accessLevel || 'download',
          expiresAt: accessRequest.accessGranted.expiresAt,
          requestId: accessRequest.requestId
        };
      }
    } catch (error) {
      console.error('Error checking access request:', error);
    }
  }

  // No access - but can see metadata
  return { 
    allowed: false, 
    reason: 'Insufficient permissions',
    level: 'metadata',
    canRequest: !user || user.role === 'citizen' || !user.role
  };
}

/**
 * Sanitize document based on access level
 * 
 * @param {Object} document - Full document object
 * @param {String} accessLevel - 'full' or 'metadata'
 * @returns {Object} - Sanitized document object
 */
function sanitizeDocument(document, accessLevel) {
  if (accessLevel === 'full') {
    return document;
  }

  // Check if document is public
  const isPublic = document.accessControl?.isPublic || 
                   document.accessControl?.privacyLevel === 'public';

  // For PUBLIC documents, return almost everything except file path
  if (isPublic) {
    const publicDoc = { ...document };
    // Remove only security-sensitive fields
    delete publicDoc.filePath; // Don't expose server file paths
    
    return {
      ...publicDoc,
      _accessLevel: 'public',
      _isPublic: true
    };
  }

  // For metadata-only access (confidential/restricted documents)
  const sanitized = {
    // Basic identification
    title: document.title,
    category: document.category,
    documentType: document.documentType,
    referenceNumber: document.referenceNumber,
    department: document.department,
    
    // Public timestamps
    uploadedAt: document.uploadedAt,
    timestamp: document.timestamp,
    
    // File info (but not path)
    fileType: document.fileType,
    fileSize: document.fileSize,
    fileName: document.fileName,
    fileHash: document.fileHash,
    
    // Blockchain info
    blockIndex: document.blockIndex,
    blockHash: document.blockHash,
    status: document.status,
    
    // Access control info
    accessControl: {
      privacyLevel: document.accessControl?.privacyLevel || 'confidential',
      requiresAuthentication: true
    },
    
    // Flags for UI
    metadataOnly: true,
    accessRestricted: true
  };

  // Do NOT include for restricted documents:
  // - filePath (security risk)
  // - issuer/recipient (privacy)
  // - uploadedBy details (privacy)
  // - nlpMetadata (content leak)
  // - extractedText (content leak)
  // - Full description (may contain sensitive info)

  return sanitized;
}

/**
 * Filter documents for listing based on user access
 * Everyone sees metadata, but content access varies
 * 
 * @param {Object|null} user - Authenticated user object
 * @param {Array} documents - Array of document objects
 * @param {String|null} email - Email for non-authenticated access
 * @returns {Array} - Filtered and sanitized documents
 */
async function filterAccessibleDocuments(user, documents, email = null) {
  const results = [];

  // CRITICAL: Admin sees everything without filtering
  if (user && user.role === 'admin') {
    return documents.map(doc => ({
      ...doc,
      _accessLevel: 'full',
      _accessReason: 'Administrator',
      _isAdmin: true
    }));
  }

  for (const doc of documents) {
    try {
      const access = await canAccessDocument(user, doc, email);
      
      if (access.level === 'full') {
        // Full access - return complete document
        results.push({
          ...doc,
          _accessLevel: 'full',
          _accessReason: access.reason,
          _expiresAt: access.expiresAt || null
        });
      } else if (access.level === 'metadata') {
        // Metadata only - return sanitized version
        results.push({
          ...sanitizeDocument(doc, 'metadata'),
          _accessLevel: 'metadata',
          _canRequest: access.canRequest,
          _accessReason: access.reason
        });
      }
    } catch (error) {
      console.error('Error filtering document:', error);
      // On error, show metadata only to be safe
      results.push({
        ...sanitizeDocument(doc, 'metadata'),
        _accessLevel: 'metadata',
        _canRequest: true,
        _accessReason: 'Error checking permissions'
      });
    }
  }

  return results;
}

/**
 * Middleware to check document access for API routes
 * Use this in Express routes that serve documents
 * 
 * Usage:
 *   app.get('/api/documents/:hash', checkDocumentAccess, (req, res) => {
 *     // req.documentAccess contains the access check result
 *     // req.sanitizedDocument contains the sanitized document
 *   })
 */
async function checkDocumentAccess(req, res, next) {
  try {
    const user = req.user || null;
    const email = req.query.email || req.body.email || null;
    const document = req.document; // Assume document is attached by previous middleware

    if (!document) {
      return res.status(404).json({
        success: false,
        error: 'Document not found'
      });
    }

    const accessCheck = await canAccessDocument(user, document, email);
    
    // Attach access info to request
    req.documentAccess = accessCheck;
    req.sanitizedDocument = accessCheck.level === 'full' 
      ? document 
      : sanitizeDocument(document, accessCheck.level);

    next();
  } catch (error) {
    console.error('Document access check error:', error);
    res.status(500).json({
      success: false,
      error: 'Error checking document access'
    });
  }
}

/**
 * Check if current request is from authenticated admin
 */
function isAdmin(user) {
  return user && user.role === 'admin';
}

/**
 * Check if current request is from authenticated citizen
 */
function isCitizen(user) {
  return user && user.role === 'citizen';
}

/**
 * Check if email has pending request for document
 */
async function hasPendingRequest(email, fileHash) {
  try {
    const request = await AccessRequest.findOne({
      'requester.email': email,
      'document.fileHash': fileHash,
      status: 'pending'
    });
    
    return !!request;
  } catch (error) {
    console.error('Error checking pending request:', error);
    return false;
  }
}

/**
 * Get access summary for a document (useful for UI)
 */
async function getDocumentAccessSummary(document, user = null, email = null) {
  const access = await canAccessDocument(user, document, email);
  const hasPending = email ? await hasPendingRequest(email, document.fileHash) : false;
  
  return {
    fileHash: document.fileHash,
    title: document.title,
    privacyLevel: document.accessControl?.privacyLevel || 'confidential',
    hasAccess: access.allowed,
    accessLevel: access.level,
    accessReason: access.reason,
    canRequest: access.canRequest,
    hasPendingRequest: hasPending,
    expiresAt: access.expiresAt || null
  };
}

module.exports = {
  canAccessDocument,
  filterAccessibleDocuments,
  sanitizeDocument,
  checkDocumentAccess,
  isAdmin,
  isCitizen,
  hasPendingRequest,
  getDocumentAccessSummary
};