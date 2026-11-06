-- LedgerLine Double-Entry Ledger Schema
-- Strict financial invariants, append-only triggers, and audit logging

PRAGMA foreign_keys = ON;

-- Users table with RBAC (ADMIN, ACCOUNT_HOLDER, AUDITOR)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('ADMIN', 'ACCOUNT_HOLDER', 'AUDITOR')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Accounts table with strict floor: Customer accounts can NEVER drop below 0
CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    account_number TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    balance INTEGER NOT NULL DEFAULT 0,
    is_system INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'FROZEN', 'CLOSED')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CONSTRAINT chk_user_account_balance_floor CHECK (is_system = 1 OR balance >= 0)
);

CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_accounts_number ON accounts(account_number);

-- Transactions table (Journal Header)
CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('TRANSFER', 'DEPOSIT', 'WITHDRAWAL', 'ADJUSTMENT')),
    description TEXT NOT NULL,
    idempotency_key TEXT UNIQUE,
    initiator_id TEXT NOT NULL REFERENCES users(id),
    total_amount INTEGER NOT NULL CHECK (total_amount > 0),
    status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'REFUSED')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at);

-- Ledger Entries table (Double-Entry Postings - STRICTLY APPEND-ONLY)
CREATE TABLE IF NOT EXISTS ledger_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id TEXT UNIQUE NOT NULL,
    transaction_id TEXT NOT NULL REFERENCES transactions(id),
    account_id TEXT NOT NULL REFERENCES accounts(id),
    entry_type TEXT NOT NULL CHECK (entry_type IN ('DEBIT', 'CREDIT')),
    amount INTEGER NOT NULL CHECK (amount > 0),
    running_balance INTEGER NOT NULL,
    prev_hash TEXT NOT NULL,
    entry_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CONSTRAINT chk_customer_running_balance CHECK (account_id = 'acc_system_clearing' OR running_balance >= 0)
);

CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_transaction ON ledger_entries(transaction_id);
CREATE INDEX IF NOT EXISTS idx_ledger_created ON ledger_entries(created_at);

-- IMMUTABILITY TRIGGERS: Ledger entries can never be modified or deleted
CREATE TRIGGER IF NOT EXISTS trg_prevent_ledger_update
BEFORE UPDATE ON ledger_entries
BEGIN
    SELECT RAISE(ABORT, 'LEDGER_IMMUTABLE: ledger_entries cannot be modified once written');
END;

CREATE TRIGGER IF NOT EXISTS trg_prevent_ledger_delete
BEFORE DELETE ON ledger_entries
BEGIN
    SELECT RAISE(ABORT, 'LEDGER_IMMUTABLE: ledger_entries cannot be deleted once written');
END;

-- Refused Attempts table (Immutable refusal audit log)
CREATE TABLE IF NOT EXISTS refused_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id TEXT UNIQUE NOT NULL,
    idempotency_key TEXT,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    action TEXT NOT NULL CHECK (action IN ('DEPOSIT', 'WITHDRAWAL', 'TRANSFER')),
    attempted_amount INTEGER NOT NULL,
    reason TEXT NOT NULL,
    initiator_id TEXT NOT NULL REFERENCES users(id),
    current_balance INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_refused_account ON refused_attempts(account_id);
CREATE INDEX IF NOT EXISTS idx_refused_created ON refused_attempts(created_at);

-- Refused attempts are also immutable
CREATE TRIGGER IF NOT EXISTS trg_prevent_refused_update
BEFORE UPDATE ON refused_attempts
BEGIN
    SELECT RAISE(ABORT, 'AUDIT_IMMUTABLE: refused_attempts cannot be modified once written');
END;

CREATE TRIGGER IF NOT EXISTS trg_prevent_refused_delete
BEFORE DELETE ON refused_attempts
BEGIN
    SELECT RAISE(ABORT, 'AUDIT_IMMUTABLE: refused_attempts cannot be deleted once written');
END;

-- Idempotency tracking table
CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    endpoint TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'REFUSED')),
    response_code INTEGER,
    response_body TEXT,
    transaction_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_idempotency_user ON idempotency_keys(user_id);
