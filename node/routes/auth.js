// node/routes/auth.js
const express = require('express');
const User = require('../models/User');
const jwt = require('jsonwebtoken');
const { authenticate, isAdmin, generateToken } = require('../middleware/auth');

const router = express.Router();

// Citizen self-registration (PUBLIC) - Also allows first admin creation
router.post('/register', async (req, res) => {
  try {
    const {
      username,
      email,
      password,
      fullName,
      phone,
      citizenId,
      organization,
      role // NEW: Accept role parameter
    } = req.body;

    // Validate required fields
    if (!username || !email || !password || !fullName) {
      return res.status(400).json({
        success: false,
        error: 'Username, email, password, and full name are required'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 6 characters'
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ username }, { email }]
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: 'Username or email already exists'
      });
    }

    // ===== NEW: Check if this is the first user =====
    const userCount = await User.countDocuments();
    let userRole = 'citizen'; // Default role
    let createdBy = 'self-registration';

    if (userCount === 0) {
      // First user - can be admin
      userRole = role || 'admin'; // Use provided role or default to admin
      createdBy = 'first-user-registration';
      console.log('🎉 Creating FIRST USER with role:', userRole);
    } else {
      // Not first user - force citizen role for security
      userRole = 'citizen';
      createdBy = 'self-registration';
      
      // If someone tries to set admin role after first user, ignore it
      if (role && role !== 'citizen') {
        console.log('⚠️  Attempted to register as', role, '- forcing to citizen');
      }
    }

    // Create new user
    const user = new User({
      username,
      email,
      password,
      fullName,
      role: userRole, // Use determined role
      phone,
      citizenId,
      organization,
      createdBy: createdBy
    });

    await user.save();

    // Generate JWT token
    const token = jwt.sign(
      {
        id: user._id,
        username: user.username,
        email: user.email,
        role: user.role
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    console.log(`✅ User registered: ${username} (${userRole})`);

    res.status(201).json({
      success: true,
      message: 'Registration successful',
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        fullName: user.fullName,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Admin Login ONLY
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

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