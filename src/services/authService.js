const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const config = require('../config');

class AuthError extends Error {
  constructor(message, code, statusCode = 401) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Creates a new user with securely hashed password.
 */
function createUser({ name, email, password, role }) {
  const db = getDb();
  const normalizedEmail = email.trim().toLowerCase();

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) {
    throw new AuthError('A user with this email already exists', 'EMAIL_EXISTS', 409);
  }

  const validRoles = Object.values(config.ROLES);
  if (!validRoles.includes(role)) {
    throw new AuthError(`Invalid role: ${role}. Valid roles are: ${validRoles.join(', ')}`, 'INVALID_ROLE', 400);
  }

  const salt = bcrypt.genSaltSync(10);
  const passwordHash = bcrypt.hashSync(password, salt);
  const id = `usr_${uuidv4()}`;

  db.prepare(`
    INSERT INTO users (id, name, email, password_hash, role)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, normalizedEmail, passwordHash, role);

  return {
    id,
    name,
    email: normalizedEmail,
    role
  };
}

/**
 * Authenticates user credentials and issues a signed JWT.
 */
function login(email, password) {
  const db = getDb();
  const normalizedEmail = (email || '').trim().toLowerCase();

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
  if (!user) {
    throw new AuthError('Invalid email or password', 'INVALID_CREDENTIALS', 401);
  }

  const isPasswordValid = bcrypt.compareSync(password, user.password_hash);
  if (!isPasswordValid) {
    throw new AuthError('Invalid email or password', 'INVALID_CREDENTIALS', 401);
  }

  const tokenPayload = {
    id: user.id,
    userId: user.id,
    name: user.name,
    email: user.email,
    role: user.role
  };

  const token = jwt.sign(tokenPayload, config.JWT_SECRET, {
    expiresIn: config.JWT_EXPIRES_IN
  });

  return {
    token,
    user: tokenPayload
  };
}

/**
 * Verifies JWT and returns decoded payload.
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, config.JWT_SECRET);
  } catch (err) {
    throw new AuthError('Invalid or expired authentication token', 'TOKEN_INVALID', 401);
  }
}

/**
 * Verifies whether a user has authority to access or manipulate an account.
 * 
 * Permissions:
 * - 'READ': View balance, view statement
 * - 'WRITE': Withdraw, transfer funds out
 */
function verifyAccountAuthorization(user, accountId, permission = 'READ') {
  const db = getDb();

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!account) {
    throw new AuthError(`Account not found: ${accountId}`, 'ACCOUNT_NOT_FOUND', 404);
  }

  // System accounts cannot be accessed directly by users
  if (account.is_system && user.role !== config.ROLES.ADMIN && user.role !== config.ROLES.AUDITOR) {
    throw new AuthError('Direct access to system clearing accounts is forbidden', 'FORBIDDEN_SYSTEM_ACCOUNT', 403);
  }

  // Auditors are strictly READ-ONLY
  if (user.role === config.ROLES.AUDITOR) {
    if (permission === 'WRITE') {
      throw new AuthError('Auditor role is strictly read-only. Money movement is forbidden', 'AUDITOR_CANNOT_WRITE', 403);
    }
    return { authorized: true, account };
  }

  const currentUserId = user.id || user.userId;

  // Administrators
  if (user.role === config.ROLES.ADMIN) {
    if (permission === 'READ') {
      return { authorized: true, account };
    }
    // For WRITE operations: Admin cannot move funds out of customer accounts without account holder authority
    if (account.user_id !== currentUserId && permission === 'WRITE') {
      throw new AuthError('Administrators cannot move customer funds without account holder credentials', 'ADMIN_UNAUTHORIZED_MOVEMENT', 403);
    }
    return { authorized: true, account };
  }

  // Account Holders: can ONLY access their own accounts
  if (user.role === config.ROLES.ACCOUNT_HOLDER) {
    if (account.user_id !== currentUserId) {
      throw new AuthError('Access denied: You do not have permission to access or move money from this account', 'UNAUTHORIZED_ACCOUNT_ACCESS', 403);
    }
    return { authorized: true, account };
  }

  throw new AuthError('Unauthorized', 'UNAUTHORIZED', 403);
}

module.exports = {
  AuthError,
  createUser,
  login,
  verifyToken,
  verifyAccountAuthorization
};
