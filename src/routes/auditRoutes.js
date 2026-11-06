const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authenticateToken, requireRoles } = require('../middleware/auth');
const { listIdempotencyRecords } = require('../services/idempotencyService');
const config = require('../config');

// Require ADMIN or AUDITOR role for all audit endpoints
router.use(authenticateToken, requireRoles(config.ROLES.ADMIN, config.ROLES.AUDITOR));

/**
 * GET /api/audit/refused
 * Lists all refused attempts across the system.
 */
router.get('/refused', (req, res) => {
  const db = getDb();
  const limit = parseInt(req.query.limit, 10) || 100;

  const refusals = db.prepare(`
    SELECT 
      ra.id,
      ra.attempt_id,
      ra.idempotency_key,
      ra.account_id,
      a.account_number,
      a.name AS account_name,
      ra.action,
      ra.attempted_amount,
      ra.reason,
      ra.current_balance,
      ra.created_at,
      u.name AS initiator_name,
      u.email AS initiator_email,
      u.role AS initiator_role
    FROM refused_attempts ra
    LEFT JOIN accounts a ON ra.account_id = a.id
    LEFT JOIN users u ON ra.initiator_id = u.id
    ORDER BY ra.created_at DESC
    LIMIT ?
  `).all(limit);

  const formatted = refusals.map(r => ({
    ...r,
    attemptedAmountFormatted: `$${(r.attempted_amount / 100).toFixed(2)}`,
    currentBalanceFormatted: `$${(r.current_balance / 100).toFixed(2)}`
  }));

  return res.json({ count: formatted.length, refusals: formatted });
});

/**
 * GET /api/audit/idempotency
 * Lists idempotency records and duplicate request replays.
 */
router.get('/idempotency', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 100;
  const records = listIdempotencyRecords(limit);
  return res.json({ count: records.length, records });
});

/**
 * GET /api/audit/ledger
 * Lists chronological double-entry postings with cryptographic hash chain.
 */
router.get('/ledger', (req, res) => {
  const db = getDb();
  const limit = parseInt(req.query.limit, 10) || 100;

  const entries = db.prepare(`
    SELECT 
      le.id,
      le.entry_id,
      le.transaction_id,
      t.type AS transaction_type,
      t.description AS transaction_description,
      le.account_id,
      a.account_number,
      a.name AS account_name,
      le.entry_type,
      le.amount,
      le.running_balance,
      le.prev_hash,
      le.entry_hash,
      le.created_at
    FROM ledger_entries le
    JOIN transactions t ON le.transaction_id = t.id
    JOIN accounts a ON le.account_id = a.id
    ORDER BY le.id DESC
    LIMIT ?
  `).all(limit);

  const formatted = entries.map(e => ({
    ...e,
    amountFormatted: `$${(e.amount / 100).toFixed(2)}`,
    runningBalanceFormatted: `$${(e.running_balance / 100).toFixed(2)}`
  }));

  return res.json({ count: formatted.length, entries: formatted });
});

module.exports = router;
