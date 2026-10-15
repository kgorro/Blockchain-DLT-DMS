// node/middleware/auth.js
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

// The JWT secret must come from the environment. There is deliberately no hardcoded
// fallback: a known default would let anyone mint admin tokens.
const WEAK_SECRETS = ['your-secret-key-change-in-production', 'your-super-secret-jwt-key-change-this-in-production'];
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || WEAK_SECRETS.includes(JWT_SECRET) || JWT_SECRET.length < 32) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set to a random value of at least 32 characters in production');
  }
  JWT_SECRET = crypto.randomBytes(48).toString('base64url');
  console.warn('⚠️  JWT_SECRET missing or weak: using a random per-process secret (logins will not survive restarts). Set JWT_SECRET in .env.');
}

// Verify JWT token
const authenticate = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ 
        success: false, 
        error: 'Authentication required' 
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.userId);

    if (!user || !user.isActive) {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid authentication' 
      });
    }

    req.user = user;
    req.token = token;
    next();
  } catch (error) {
    res.status(401).json({ 
      success: false, 
      error: 'Invalid or expired token' 
    });
  }
};

// Attach req.user when a valid token is present, but never block the request.
const optionalAuthenticate = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (token) {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(decoded.userId);
      if (user && user.isActive) req.user = user;
    }
  } catch (e) {
    // invalid token: treat as anonymous
  }
  next();
};

// Check if user is admin
const isAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ 
      success: false, 
      error: 'Admin access required' 
    });
  }
  next();
};

// Check if user is citizen or admin
const isCitizen = (req, res, next) => {
  if (req.user.role !== 'citizen' && req.user.role !== 'admin') {
    return res.status(403).json({ 
      success: false, 
      error: 'Citizen or admin access required' 
    });
  }
  next();
};

// Generate JWT token
const generateToken = (userId) => {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '12h' });
};

module.exports = {
  authenticate,
  optionalAuthenticate,
  isAdmin,
  isCitizen,
  generateToken
};