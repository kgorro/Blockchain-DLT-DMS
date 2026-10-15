// node/routes/auth.js
const express = require('express');
const User = require('../models/User');
const { authenticate, isAdmin, generateToken } = require('../middleware/auth');

const router = express.Router();

// Simple in-memory login throttle: 10 failed attempts per IP per 15 minutes.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const loginFailures = new Map();
function tooManyFailures(ip) {
  const entry = loginFailures.get(ip);
  if (!entry || Date.now() > entry.resetAt) return false;
  return entry.count >= LOGIN_MAX_FAILURES;
}
function recordFailure(ip) {
  const now = Date.now();
  const entry = loginFailures.get(ip);
  if (!entry || now > entry.resetAt) loginFailures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  else entry.count++;
}

// Register new admin (first user only)
router.post('/register', async (req, res) => {
  try {
    const { username, email, password, fullName } = req.body;

    if (!username || !email || !password || !fullName) {
      return res.status(400).json({ 
        success: false, 
        error: 'All fields are required' 
      });
    }

    const existingUser = await User.findOne({ 
      $or: [{ email }, { username }] 
    });

    if (existingUser) {
      return res.status(400).json({ 
        success: false, 
        error: 'Username or email already exists' 
      });
    }

    const userCount = await User.countDocuments();
    
    // Only allow admin registration, no citizens
    if (userCount > 0) {
      return res.status(403).json({ 
        success: false, 
        error: 'Admin registration is closed. Only the first user can register as admin.' 
      });
    }

    const user = new User({
      username,
      email,
      password,
      fullName,
      role: 'admin'  // Force admin role
    });

    await user.save();
    const token = generateToken(user._id);

    res.status(201).json({
      success: true,
      message: 'Admin registered successfully',
      user: user.getPublicProfile(),
      token
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Admin Login ONLY
router.post('/login', async (req, res) => {
  try {
    const ip = req.ip;
    if (tooManyFailures(ip)) {
      return res.status(429).json({ success: false, error: 'Too many failed login attempts. Try again later.' });
    }
    const username = typeof req.body.username === 'string' ? req.body.username : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (!username || !password) {
      return res.status(400).json({ 
        success: false, 
        error: 'Username and password are required' 
      });
    }

    const user = await User.findOne({ 
      $or: [{ username }, { email: username }] 
    });

    if (!user) {
      recordFailure(ip);
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid credentials' 
      });
    }

    // Only allow admin login
    if (user.role !== 'admin') {
      return res.status(403).json({ 
        success: false, 
        error: 'Access denied. Admin login only.' 
      });
    }

    if (!user.isActive) {
      return res.status(401).json({ 
        success: false, 
        error: 'Account is deactivated. Contact administrator.' 
      });
    }

    const isMatch = await user.comparePassword(password);

    if (!isMatch) {
      recordFailure(ip);
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid credentials' 
      });
    }

    user.lastLogin = new Date();
    await user.save();

    const token = generateToken(user._id);

    res.json({
      success: true,
      message: 'Login successful',
      user: user.getPublicProfile(),
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get current user profile
router.get('/me', authenticate, async (req, res) => {
  res.json({
    success: true,
    user: req.user.getPublicProfile()
  });
});

// Admin: Create new admin account
router.post('/users', authenticate, isAdmin, async (req, res) => {
  try {
    const { username, email, password, fullName } = req.body;

    if (!username || !email || !password || !fullName) {
      return res.status(400).json({ 
        success: false, 
        error: 'All fields are required' 
      });
    }

    const existingUser = await User.findOne({ 
      $or: [{ email }, { username }] 
    });

    if (existingUser) {
      return res.status(400).json({ 
        success: false, 
        error: 'Username or email already exists' 
      });
    }

    const user = new User({
      username,
      email,
      password,
      fullName,
      role: 'admin',  // Only create admin accounts
      createdBy: req.user._id
    });

    await user.save();

    res.status(201).json({
      success: true,
      message: 'Admin created successfully',
      user: user.getPublicProfile()
    });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Admin: Get all users
router.get('/users', authenticate, isAdmin, async (req, res) => {
  try {
    const users = await User.find()
      .select('-password')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      users: users.map(u => u.getPublicProfile()),
      count: users.length
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Admin: Update user
router.put('/users/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const { fullName, email, isActive } = req.body;
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }

    if (req.user._id.toString() === user._id.toString() && isActive === false) {
      return res.status(400).json({ 
        success: false, 
        error: 'Cannot deactivate your own account' 
      });
    }

    if (fullName) user.fullName = fullName;
    if (email) user.email = email;
    if (typeof isActive === 'boolean') user.isActive = isActive;

    await user.save();

    res.json({
      success: true,
      message: 'User updated successfully',
      user: user.getPublicProfile()
    });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Admin: Delete user
router.delete('/users/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }

    if (req.user._id.toString() === user._id.toString()) {
      return res.status(400).json({ 
        success: false, 
        error: 'Cannot delete your own account' 
      });
    }

    await User.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

module.exports = router;