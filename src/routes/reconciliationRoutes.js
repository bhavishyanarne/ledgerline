const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { verifySystemReconciliation } = require('../services/ledgerService');

/**
 * GET /api/reconciliation
 * Public/authenticated endpoint providing mathematical and cryptographic proof
 * that the books balance, money is conserved, debits equal credits, and the ledger
 * hash chain is completely untampered.
 */
router.get('/', authenticateToken, (req, res) => {
  try {
    const report = verifySystemReconciliation();
    return res.json(report);
  } catch (err) {
    return res.status(500).json({
      error: 'Reconciliation verification error: ' + err.message,
      code: 'RECONCILIATION_ERROR'
    });
  }
});

module.exports = router;
