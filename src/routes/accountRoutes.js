const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const { authenticateToken, requireRoles, requireAccountPermission } = require('../middleware/auth');
const { getAccountStatement } = require('../services/ledgerService');
const config = require('../config');

/**
 * GET /api/accounts
 * Lists accounts based on role:
 * - Admin and Auditor see all accounts
 * - Account Holders see only their own accounts
 */
router.get('/', authenticateToken, (req, res) => {
  const db = getDb();
  let accounts = [];

  if (req.user.role === config.ROLES.ADMIN || req.user.role === config.ROLES.AUDITOR) {
    accounts = db.prepare(`
      SELECT 
        a.id,
        a.account_number,
        a.name,
        a.currency,
        a.balance,
        a.is_system,
        a.status,
        a.created_at,
        u.id AS user_id,
        u.name AS owner_name,
        u.email AS owner_email,
        u.role AS owner_role
      FROM accounts a
      JOIN users u ON a.user_id = u.id
      ORDER BY a.is_system DESC, a.created_at ASC
    `).all();
  } else {
    accounts = db.prepare(`
      SELECT 
        a.id,
        a.account_number,
        a.name,
        a.currency,
        a.balance,
        a.is_system,
        a.status,
        a.created_at,
        u.id AS user_id,
        u.name AS owner_name,
        u.email AS owner_email,
        u.role AS owner_role
      FROM accounts a
      JOIN users u ON a.user_id = u.id
      WHERE a.user_id = ?
      ORDER BY a.created_at ASC
    `).all(req.user.userId);
  }

  const formatted = accounts.map(acc => ({
    ...acc,
    balanceFormatted: `$${(acc.balance / 100).toFixed(2)}`
  }));

  return res.json({ accounts: formatted });
});

/**
 * GET /api/accounts/:id
 * Fetches a single account by ID with authorization verification.
 */
router.get('/:id', authenticateToken, requireAccountPermission('id', 'READ'), (req, res) => {
  const db = getDb();
  const acc = db.prepare(`
    SELECT 
      a.id,
      a.account_number,
      a.name,
      a.currency,
      a.balance,
      a.is_system,
      a.status,
      a.created_at,
      u.id AS user_id,
      u.name AS owner_name,
      u.email AS owner_email
    FROM accounts a
    JOIN users u ON a.user_id = u.id
    WHERE a.id = ?
  `).get(req.params.id);

  if (!acc) {
    return res.status(404).json({ error: 'Account not found', code: 'ACCOUNT_NOT_FOUND' });
  }

  return res.json({
    account: {
      ...acc,
      balanceFormatted: `$${(acc.balance / 100).toFixed(2)}`
    }
  });
});

/**
 * POST /api/accounts
 * Creates a new account.
 * - Admin can create for any user.
 * - Account Holder can create for themselves.
 * - Initial balance is always $0.00 (must be funded via double-entry deposit).
 */
router.post('/', authenticateToken, (req, res) => {
  if (req.user.role === config.ROLES.AUDITOR) {
    return res.status(403).json({
      error: 'Auditors have read-only access and cannot create accounts',
      code: 'AUDITOR_FORBIDDEN'
    });
  }

  const db = getDb();
  const { name, currency = 'USD' } = req.body;
  let targetUserId = req.user.userId;

  if (req.user.role === config.ROLES.ADMIN && req.body.userId) {
    targetUserId = req.body.userId;
  }

  // Verify target user exists
  const owner = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(targetUserId);
  if (!owner) {
    return res.status(404).json({ error: 'Target owner user not found', code: 'USER_NOT_FOUND' });
  }

  const id = `acc_${uuidv4().substring(0, 8)}`;
  const accountNumber = `ACT-${Math.floor(100000 + Math.random() * 900000)}`;
  const accountName = name || `${owner.name}'s Account`;

  db.prepare(`
    INSERT INTO accounts (id, account_number, user_id, name, currency, balance, is_system, status)
    VALUES (?, ?, ?, ?, ?, 0, 0, 'ACTIVE')
  `).run(id, accountNumber, targetUserId, accountName, currency.toUpperCase());

  return res.status(201).json({
    account: {
      id,
      accountNumber,
      userId: targetUserId,
      ownerName: owner.name,
      name: accountName,
      currency: currency.toUpperCase(),
      balance: 0,
      balanceFormatted: '$0.00',
      status: 'ACTIVE'
    }
  });
});

/**
 * GET /api/accounts/:id/statement
 * Retrieves the full chronological statement for an account.
 * Contains every debit, every credit, and every refused attempt with running balances.
 */
router.get('/:id/statement', authenticateToken, requireAccountPermission('id', 'READ'), (req, res) => {
  try {
    const statementData = getAccountStatement(req.params.id);
    return res.json(statementData);
  } catch (err) {
    return res.status(err.statusCode || 400).json({
      error: err.message,
      code: err.code || 'STATEMENT_ERROR'
    });
  }
});

/**
 * PATCH /api/accounts/:id/status
 * Admin-only endpoint to freeze or unfreeze an account.
 */
router.patch('/:id/status', authenticateToken, requireRoles(config.ROLES.ADMIN), (req, res) => {
  const { status } = req.body;
  if (!['ACTIVE', 'FROZEN', 'CLOSED'].includes(status)) {
    return res.status(400).json({
      error: 'Invalid status. Allowed values: ACTIVE, FROZEN, CLOSED',
      code: 'INVALID_STATUS'
    });
  }

  const db = getDb();
  const result = db.prepare('UPDATE accounts SET status = ?, updated_at = datetime("now") WHERE id = ?').run(status, req.params.id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Account not found', code: 'ACCOUNT_NOT_FOUND' });
  }

  return res.json({
    message: `Account status updated to ${status}`,
    accountId: req.params.id,
    status
  });
});

module.exports = router;
