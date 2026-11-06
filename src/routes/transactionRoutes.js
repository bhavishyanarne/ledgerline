const express = require('express');
const router = express.Router();
const { authenticateToken, requireRoles, requireAccountPermission } = require('../middleware/auth');
const { requireIdempotency } = require('../middleware/idempotency');
const { transfer, deposit, withdraw, LedgerError } = require('../services/ledgerService');
const config = require('../config');

/**
 * POST /api/transactions/transfer
 * Moves money from one account to another.
 * 
 * Invariants enforced:
 * 1. Double-entry posting: debits equal credits. System balances net to zero.
 * 2. Idempotency: exact duplicate requests return the original result.
 * 3. Concurrency safety: atomic database lock and floor constraint (balance >= 0).
 * 4. Authorization: only the account owner can move funds out of the source account.
 * 5. Refusal audit: failed attempts are permanently logged.
 */
router.post(
  '/transfer',
  authenticateToken,
  requireRoles(config.ROLES.ACCOUNT_HOLDER, config.ROLES.ADMIN),
  requireAccountPermission((req) => req.body.fromAccountId, 'WRITE'),
  requireIdempotency,
  (req, res) => {
    const { fromAccountId, toAccountId, amount, description } = req.body;

    try {
      const result = transfer({
        fromAccountId,
        toAccountId,
        amount: parseInt(amount, 10),
        description,
        initiatorId: req.user.userId,
        idempotencyKey: req.idempotencyKey
      });

      return res.status(200).json(result);
    } catch (err) {
      if (err instanceof LedgerError) {
        return res.status(err.statusCode).json({
          error: err.message,
          code: err.code,
          details: err.details
        });
      }
      return res.status(500).json({
        error: 'Transfer processing error',
        code: 'INTERNAL_ERROR'
      });
    }
  }
);

/**
 * POST /api/transactions/deposit
 * External deposit into an account.
 * Handled as a double-entry posting from the system settlement account.
 */
router.post(
  '/deposit',
  authenticateToken,
  requireRoles(config.ROLES.ACCOUNT_HOLDER, config.ROLES.ADMIN),
  requireIdempotency,
  (req, res) => {
    const { accountId, amount, description } = req.body;

    try {
      const result = deposit({
        accountId,
        amount: parseInt(amount, 10),
        description,
        initiatorId: req.user.userId,
        idempotencyKey: req.idempotencyKey
      });

      return res.status(200).json(result);
    } catch (err) {
      if (err instanceof LedgerError) {
        return res.status(err.statusCode).json({
          error: err.message,
          code: err.code,
          details: err.details
        });
      }
      return res.status(500).json({
        error: 'Deposit processing error',
        code: 'INTERNAL_ERROR'
      });
    }
  }
);

/**
 * POST /api/transactions/withdraw
 * External withdrawal from an account.
 * Handled as a double-entry posting to the system settlement account.
 * Requires account ownership ('WRITE' permission).
 */
router.post(
  '/withdraw',
  authenticateToken,
  requireRoles(config.ROLES.ACCOUNT_HOLDER, config.ROLES.ADMIN),
  requireAccountPermission((req) => req.body.accountId, 'WRITE'),
  requireIdempotency,
  (req, res) => {
    const { accountId, amount, description } = req.body;

    try {
      const result = withdraw({
        accountId,
        amount: parseInt(amount, 10),
        description,
        initiatorId: req.user.userId,
        idempotencyKey: req.idempotencyKey
      });

      return res.status(200).json(result);
    } catch (err) {
      if (err instanceof LedgerError) {
        return res.status(err.statusCode).json({
          error: err.message,
          code: err.code,
          details: err.details
        });
      }
      return res.status(500).json({
        error: 'Withdrawal processing error',
        code: 'INTERNAL_ERROR'
      });
    }
  }
);

module.exports = router;
