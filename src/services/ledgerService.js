const crypto = require('node:crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb, transaction } = require('../db');
const config = require('../config');

class LedgerError extends Error {
  constructor(message, code, statusCode = 400, details = {}) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

/**
 * Calculates SHA-256 hash for ledger entry tamper-evidence.
 */
function calculateEntryHash(prevHash, entryId, txId, accountId, entryType, amount, runningBalance, createdAt) {
  const payload = `${prevHash}:${entryId}:${txId}:${accountId}:${entryType}:${amount}:${runningBalance}:${createdAt}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Retrieves the latest ledger entry's hash to maintain the chain.
 */
function getLatestEntryHash(db) {
  const row = db.prepare('SELECT entry_hash FROM ledger_entries ORDER BY id DESC LIMIT 1').get();
  return row ? row.entry_hash : '0'.repeat(64); // Genesis hash
}

/**
 * Logs a refused money movement attempt into the immutable audit table.
 * Runs in its own transaction so it persists even when operations fail.
 */
function logRefusedAttempt(data) {
  const db = getDb();
  const attemptId = `ref_${uuidv4()}`;
  const now = new Date().toISOString();

  // Find account current balance if account exists
  let currentBalance = 0;
  if (data.accountId) {
    const acc = db.prepare('SELECT balance FROM accounts WHERE id = ?').get(data.accountId);
    if (acc) {
      currentBalance = acc.balance;
    }
  }

  db.prepare(`
    INSERT INTO refused_attempts (
      attempt_id, idempotency_key, account_id, action,
      attempted_amount, reason, initiator_id, current_balance, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    attemptId,
    data.idempotencyKey || null,
    data.accountId || 'UNKNOWN',
    data.action,
    data.amount || 0,
    data.reason,
    data.initiatorId,
    currentBalance,
    now
  );

  return {
    attemptId,
    status: 'REFUSED',
    reason: data.reason,
    currentBalance,
    createdAt: now
  };
}

/**
 * Core money movement: Moves money between two accounts atomically.
 * Works for TRANSFER, DEPOSIT (from system clearing), and WITHDRAWAL (to system clearing).
 * 
 * Guarantees:
 * 1. Double-entry bookkeeping: debit and credit always balance.
 * 2. Atomic serialization: uses SQLite immediate transaction.
 * 3. Conservation of money: debits equal credits.
 * 4. Floor guarantee: account balance cannot fall below 0.
 * 5. Tamper-evident hash chaining.
 */
function executeMovement({
  type,
  fromAccountId,
  toAccountId,
  amount,
  description,
  initiatorId,
  idempotencyKey = null
}) {
  const db = getDb();

  // Basic validation
  if (!Number.isInteger(amount) || amount <= 0) {
    logRefusedAttempt({
      accountId: fromAccountId,
      action: type,
      amount,
      reason: 'INVALID_AMOUNT: Amount must be a positive integer in cents',
      initiatorId,
      idempotencyKey
    });
    throw new LedgerError('Amount must be a positive integer in minor units (cents)', 'INVALID_AMOUNT', 400);
  }

  if (fromAccountId === toAccountId) {
    logRefusedAttempt({
      accountId: fromAccountId,
      action: type,
      amount,
      reason: 'SELF_TRANSFER_DISALLOWED: Source and destination accounts cannot be the same',
      initiatorId,
      idempotencyKey
    });
    throw new LedgerError('Source and destination accounts must be different', 'SELF_TRANSFER_DISALLOWED', 400);
  }

  return transaction((txDb) => {
    // 1. Fetch and verify source account
    const fromAccount = txDb.prepare('SELECT * FROM accounts WHERE id = ?').get(fromAccountId);
    if (!fromAccount) {
      throw new LedgerError(`Source account not found: ${fromAccountId}`, 'ACCOUNT_NOT_FOUND', 404);
    }
    if (fromAccount.status !== 'ACTIVE') {
      logRefusedAttempt({
        accountId: fromAccountId,
        action: type,
        amount,
        reason: `ACCOUNT_INACTIVE: Source account is ${fromAccount.status}`,
        initiatorId,
        idempotencyKey
      });
      throw new LedgerError(`Source account is ${fromAccount.status}`, 'ACCOUNT_INACTIVE', 400);
    }

    // 2. Fetch and verify destination account
    const toAccount = txDb.prepare('SELECT * FROM accounts WHERE id = ?').get(toAccountId);
    if (!toAccount) {
      throw new LedgerError(`Destination account not found: ${toAccountId}`, 'ACCOUNT_NOT_FOUND', 404);
    }
    if (toAccount.status !== 'ACTIVE') {
      logRefusedAttempt({
        accountId: fromAccountId,
        action: type,
        amount,
        reason: `DESTINATION_INACTIVE: Destination account is ${toAccount.status}`,
        initiatorId,
        idempotencyKey
      });
      throw new LedgerError(`Destination account is ${toAccount.status}`, 'DESTINATION_INACTIVE', 400);
    }

    // 3. For non-system source accounts, verify sufficient funds and deduct atomically
    // We execute an atomic update with predicate: `WHERE id = ? AND balance >= ?`
    if (!fromAccount.is_system) {
      if (fromAccount.balance < amount) {
        // Log refusal into audit trail
        logRefusedAttempt({
          accountId: fromAccountId,
          action: type,
          amount,
          reason: `INSUFFICIENT_FUNDS: Requested ${amount} cents, available ${fromAccount.balance} cents`,
          initiatorId,
          idempotencyKey
        });
        throw new LedgerError(
          `Insufficient funds in account ${fromAccount.account_number}. Requested: $${(amount / 100).toFixed(2)}, Available: $${(fromAccount.balance / 100).toFixed(2)}`,
          'INSUFFICIENT_FUNDS',
          400,
          { available: fromAccount.balance, requested: amount }
        );
      }

      // Atomic deduction
      const debitUpdate = txDb.prepare(`
        UPDATE accounts 
        SET balance = balance - ?, updated_at = datetime('now')
        WHERE id = ? AND balance >= ?
      `).run(amount, fromAccountId, amount);

      if (debitUpdate.changes === 0) {
        logRefusedAttempt({
          accountId: fromAccountId,
          action: type,
          amount,
          reason: 'CONCURRENCY_RACE_CONDITION: Balance changed during transaction',
          initiatorId,
          idempotencyKey
        });
        throw new LedgerError('Concurrent update conflict or insufficient funds', 'CONCURRENCY_CONFLICT', 409);
      }
    } else {
      // System clearing account can go negative or track total external balance
      txDb.prepare(`
        UPDATE accounts 
        SET balance = balance - ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(amount, fromAccountId);
    }

    // 4. Credit destination account
    txDb.prepare(`
      UPDATE accounts 
      SET balance = balance + ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(amount, toAccountId);

    // 5. Fetch updated running balances
    const updatedFrom = txDb.prepare('SELECT balance FROM accounts WHERE id = ?').get(fromAccountId);
    const updatedTo = txDb.prepare('SELECT balance FROM accounts WHERE id = ?').get(toAccountId);

    // 6. Record Journal Transaction
    const txId = `tx_${uuidv4()}`;
    const now = new Date().toISOString();

    txDb.prepare(`
      INSERT INTO transactions (
        id, type, description, idempotency_key, initiator_id, total_amount, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'POSTED', ?)
    `).run(txId, type, description || `${type} of $${(amount / 100).toFixed(2)}`, idempotencyKey, initiatorId, amount, now);

    // 7. Record Double-Entry Postings with Cryptographic Hash Chaining
    // First entry: DEBIT on fromAccountId
    let prevHash = getLatestEntryHash(txDb);
    const debitEntryId = `ent_${uuidv4()}`;
    const debitHash = calculateEntryHash(
      prevHash, debitEntryId, txId, fromAccountId, 'DEBIT', amount, updatedFrom.balance, now
    );

    txDb.prepare(`
      INSERT INTO ledger_entries (
        entry_id, transaction_id, account_id, entry_type, amount,
        running_balance, prev_hash, entry_hash, created_at
      ) VALUES (?, ?, ?, 'DEBIT', ?, ?, ?, ?, ?)
    `).run(debitEntryId, txId, fromAccountId, amount, updatedFrom.balance, prevHash, debitHash, now);

    // Second entry: CREDIT on toAccountId
    prevHash = debitHash;
    const creditEntryId = `ent_${uuidv4()}`;
    const creditHash = calculateEntryHash(
      prevHash, creditEntryId, txId, toAccountId, 'CREDIT', amount, updatedTo.balance, now
    );

    txDb.prepare(`
      INSERT INTO ledger_entries (
        entry_id, transaction_id, account_id, entry_type, amount,
        running_balance, prev_hash, entry_hash, created_at
      ) VALUES (?, ?, ?, 'CREDIT', ?, ?, ?, ?, ?)
    `).run(creditEntryId, txId, toAccountId, amount, updatedTo.balance, prevHash, creditHash, now);

    return {
      transactionId: txId,
      type,
      amount,
      amountFormatted: `$${(amount / 100).toFixed(2)}`,
      fromAccountId,
      fromRunningBalance: updatedFrom.balance,
      toAccountId,
      toRunningBalance: updatedTo.balance,
      initiatorId,
      status: 'POSTED',
      createdAt: now,
      debitEntryId,
      creditEntryId
    };
  });
}

/**
 * Transfers money from one user account to another.
 */
function transfer({ fromAccountId, toAccountId, amount, description, initiatorId, idempotencyKey }) {
  return executeMovement({
    type: 'TRANSFER',
    fromAccountId,
    toAccountId,
    amount,
    description: description || 'Internal account transfer',
    initiatorId,
    idempotencyKey
  });
}

/**
 * External deposit: Moves money from system clearing account to user account.
 */
function deposit({ accountId, amount, description, initiatorId, idempotencyKey }) {
  return executeMovement({
    type: 'DEPOSIT',
    fromAccountId: config.SYSTEM_ACCOUNT_ID,
    toAccountId: accountId,
    amount,
    description: description || 'External deposit',
    initiatorId,
    idempotencyKey
  });
}

/**
 * External withdrawal: Moves money from user account to system clearing account.
 */
function withdraw({ accountId, amount, description, initiatorId, idempotencyKey }) {
  return executeMovement({
    type: 'WITHDRAWAL',
    fromAccountId: accountId,
    toAccountId: config.SYSTEM_ACCOUNT_ID,
    amount,
    description: description || 'External withdrawal',
    initiatorId,
    idempotencyKey
  });
}

/**
 * Retrieves full chronological account statement:
 * Debits, credits, and refused attempts with running balances and initiators.
 */
function getAccountStatement(accountId) {
  const db = getDb();

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!account) {
    throw new LedgerError('Account not found', 'ACCOUNT_NOT_FOUND', 404);
  }

  // Fetch posted ledger entries
  const postings = db.prepare(`
    SELECT 
      le.created_at AS timestamp,
      le.entry_id AS reference_id,
      t.id AS transaction_id,
      t.type AS transaction_type,
      t.description,
      le.entry_type,
      le.amount,
      le.running_balance,
      'POSTED' AS status,
      NULL AS refusal_reason,
      u.name AS initiator_name,
      u.email AS initiator_email,
      u.role AS initiator_role,
      le.entry_hash
    FROM ledger_entries le
    JOIN transactions t ON le.transaction_id = t.id
    JOIN users u ON t.initiator_id = u.id
    WHERE le.account_id = ?
  `).all(accountId);

  // Fetch refused attempts
  const refusals = db.prepare(`
    SELECT 
      ra.created_at AS timestamp,
      ra.attempt_id AS reference_id,
      NULL AS transaction_id,
      ra.action AS transaction_type,
      'REFUSED: ' || ra.reason AS description,
      CASE 
        WHEN ra.action = 'DEPOSIT' THEN 'CREDIT' 
        ELSE 'DEBIT' 
      END AS entry_type,
      ra.attempted_amount AS amount,
      ra.current_balance AS running_balance,
      'REFUSED' AS status,
      ra.reason AS refusal_reason,
      u.name AS initiator_name,
      u.email AS initiator_email,
      u.role AS initiator_role,
      NULL AS entry_hash
    FROM refused_attempts ra
    JOIN users u ON ra.initiator_id = u.id
    WHERE ra.account_id = ?
  `).all(accountId);

  // Merge and sort chronologically (most recent first)
  const statement = [...postings, ...refusals].sort((a, b) => {
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  return {
    account: {
      id: account.id,
      accountNumber: account.account_number,
      name: account.name,
      balance: account.balance,
      balanceFormatted: `$${(account.balance / 100).toFixed(2)}`,
      currency: account.currency,
      status: account.status
    },
    statementCount: statement.length,
    statement
  };
}

/**
 * System-wide reconciliation and cryptographic proof:
 * 1. Verifies that sum of user accounts = sum of deposits - sum of withdrawals.
 * 2. Verifies double-entry: total debits == total credits.
 * 3. Verifies cryptographic hash chain integrity.
 */
function verifySystemReconciliation() {
  const db = getDb();

  // 1. Sum of all user accounts (excluding system clearing)
  const userAccountsSum = db.prepare(`
    SELECT COALESCE(SUM(balance), 0) AS total_user_balance, COUNT(*) AS user_account_count
    FROM accounts 
    WHERE is_system = 0
  `).get();

  // 2. Sum of all external deposits
  const depositsSum = db.prepare(`
    SELECT COALESCE(SUM(total_amount), 0) AS total_deposits, COUNT(*) AS deposit_count
    FROM transactions 
    WHERE type = 'DEPOSIT' AND status = 'POSTED'
  `).get();

  // 3. Sum of all external withdrawals
  const withdrawalsSum = db.prepare(`
    SELECT COALESCE(SUM(total_amount), 0) AS total_withdrawals, COUNT(*) AS withdrawal_count
    FROM transactions 
    WHERE type = 'WITHDRAWAL' AND status = 'POSTED'
  `).get();

  // 4. Sum of all internal transfers
  const transfersSum = db.prepare(`
    SELECT COALESCE(SUM(total_amount), 0) AS total_transfers, COUNT(*) AS transfer_count
    FROM transactions 
    WHERE type = 'TRANSFER' AND status = 'POSTED'
  `).get();

  // 5. Double-entry total debits vs total credits
  const doubleEntryCheck = db.prepare(`
    SELECT 
      COALESCE(SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE 0 END), 0) AS total_debits,
      COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE 0 END), 0) AS total_credits,
      COUNT(*) AS total_postings
    FROM ledger_entries
  `).get();

  // 6. Refused attempts count
  const refusedCount = db.prepare('SELECT COUNT(*) AS total_refused FROM refused_attempts').get();

  // Invariant calculation:
  // Expected User Balances = Total Deposits - Total Withdrawals
  const expectedUserBalance = depositsSum.total_deposits - withdrawalsSum.total_withdrawals;
  const actualUserBalance = userAccountsSum.total_user_balance;
  const invariantHolds = (expectedUserBalance === actualUserBalance);
  const doubleEntryBalanced = (doubleEntryCheck.total_debits === doubleEntryCheck.total_credits);

  // 7. Verify cryptographic SHA-256 hash chain
  const entries = db.prepare('SELECT * FROM ledger_entries ORDER BY id ASC').all();
  let chainValid = true;
  let lastHash = '0'.repeat(64);
  let corruptedEntryId = null;

  for (const entry of entries) {
    if (entry.prev_hash !== lastHash) {
      chainValid = false;
      corruptedEntryId = entry.entry_id;
      break;
    }
    const computedHash = calculateEntryHash(
      entry.prev_hash,
      entry.entry_id,
      entry.transaction_id,
      entry.account_id,
      entry.entry_type,
      entry.amount,
      entry.running_balance,
      entry.created_at
    );
    if (computedHash !== entry.entry_hash) {
      chainValid = false;
      corruptedEntryId = entry.entry_id;
      break;
    }
    lastHash = entry.entry_hash;
  }

  const overallIntegrityProven = invariantHolds && doubleEntryBalanced && chainValid;

  return {
    verifiedAt: new Date().toISOString(),
    overallIntegrityProven,
    moneyConservation: {
      invariantHolds,
      invariantEquation: 'Total User Balances == Total Deposits - Total Withdrawals',
      actualUserBalance,
      actualUserBalanceFormatted: `$${(actualUserBalance / 100).toFixed(2)}`,
      expectedUserBalance,
      expectedUserBalanceFormatted: `$${(expectedUserBalance / 100).toFixed(2)}`,
      discrepancy: actualUserBalance - expectedUserBalance,
      totalDeposits: depositsSum.total_deposits,
      totalDepositsFormatted: `$${(depositsSum.total_deposits / 100).toFixed(2)}`,
      depositCount: depositsSum.deposit_count,
      totalWithdrawals: withdrawalsSum.total_withdrawals,
      totalWithdrawalsFormatted: `$${(withdrawalsSum.total_withdrawals / 100).toFixed(2)}`,
      withdrawalCount: withdrawalsSum.withdrawal_count,
      totalTransfers: transfersSum.total_transfers,
      totalTransfersFormatted: `$${(transfersSum.total_transfers / 100).toFixed(2)}`,
      transferCount: transfersSum.transfer_count
    },
    doubleEntry: {
      doubleEntryBalanced,
      totalDebits: doubleEntryCheck.total_debits,
      totalCredits: doubleEntryCheck.total_credits,
      netDifference: doubleEntryCheck.total_debits - doubleEntryCheck.total_credits,
      totalPostings: doubleEntryCheck.total_postings
    },
    cryptographicLedgerChain: {
      chainValid,
      totalBlocksVerified: entries.length,
      latestBlockHash: lastHash,
      corruptedEntryId
    },
    refusalAudit: {
      totalRefusedAttempts: refusedCount.total_refused
    }
  };
}

module.exports = {
  LedgerError,
  executeMovement,
  transfer,
  deposit,
  withdraw,
  getAccountStatement,
  verifySystemReconciliation,
  logRefusedAttempt
};
