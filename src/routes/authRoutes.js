const express = require('express');
const router = express.Router();
const { login, createUser } = require('../services/authService');
const { authenticateToken, requireRoles } = require('../middleware/auth');
const config = require('../config');

/**
 * POST /api/auth/login
 * Public endpoint to sign in.
 */
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({
      error: 'Email and password are required',
      code: 'MISSING_CREDENTIALS'
    });
  }

  try {
    const result = login(email, password);
    return res.json(result);
  } catch (err) {
    return res.status(err.statusCode || 401).json({
      error: err.message,
      code: err.code || 'LOGIN_FAILED'
    });
  }
});

/**
 * GET /api/auth/me
 * Returns the currently authenticated user's profile.
 */
router.get('/me', authenticateToken, (req, res) => {
  return res.json({ user: req.user });
});

/**
 * POST /api/auth/register
 * Admin-only endpoint to provision new system users.
 */
router.post('/register', authenticateToken, requireRoles(config.ROLES.ADMIN), (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !role) {
    return res.status(400).json({
      error: 'name, email, password, and role are required',
      code: 'MISSING_FIELDS'
    });
  }

  try {
    const newUser = createUser({ name, email, password, role });
    return res.status(201).json({ user: newUser });
  } catch (err) {
    return res.status(err.statusCode || 400).json({
      error: err.message,
      code: err.code || 'REGISTRATION_FAILED'
    });
  }
});

module.exports = router;
