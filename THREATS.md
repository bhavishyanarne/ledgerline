# LedgerLine — Threat Model & Security Defenses (THREATS.md)

This document details the threat model for LedgerLine: the potential failure modes, attack vectors against money integrity and ledger reliability, the countermeasures implemented to close each vulnerability, and the architectural trade-offs accepted.

---

## Threat Matrix & Mitigation Summary

| Threat ID | Threat Category | Attack Vector / Scenario | Implemented Mitigation | Residual Risk & Accepted Trade-off |
| :--- | :--- | :--- | :--- | :--- |
| **THREAT-01** | **Concurrency & Overdraft** | Multiple simultaneous withdrawals/transfers exploit read-modify-write race windows to drive balance below zero. | Multi-tier defense: SQLite `BEGIN IMMEDIATE` ACID serialization, atomic `UPDATE ... WHERE balance >= amount` predicate, and database-level `CHECK (balance >= 0)` constraint. | Accepted for single-node / primary writer architecture. On distributed active-active clusters, distributed locks (e.g., Redlock) or partitioned leader election would be required. |
| **THREAT-02** | **Double-Spend & Replay** | Network timeout causes client retry, or user double-clicks payment button, moving funds twice. | Atomic idempotency reservation with `IN_PROGRESS` state lock, cached payload responses (`COMPLETED`), and deterministic payload SHA-256 hash validation (`422` on collision). | Replay cache retention duration. Stored permanently in SQLite; in ultra-high volume production, old keys would transition to cold archive storage after 90 days. |
| **THREAT-03** | **Unauthorized Debit** | Malicious user passes another customer's `accountId` as the debit source in a transfer or withdrawal request. | Strict account-level authorization (`verifyAccountAuthorization`) verifying authenticated JWT subject matches the account owner. Write attempts by unauthorized users or Auditors return `403 Forbidden` and log to `refused_attempts`. | Compromised user credentials (stolen JWT). Mitigated by 24h token expiry and secure credential hashing (bcrypt). |
| **THREAT-04** | **Ledger Tampering & Deletion** | Rogue employee or compromised application modifies or deletes a row in `ledger_entries` or `refused_attempts` to conceal embezzlement. | Database-level SQLite triggers (`BEFORE UPDATE` and `BEFORE DELETE`) aborting with `RAISE(ABORT, 'LEDGER_IMMUTABLE')`. Cryptographic SHA-256 block hash chaining (`prev_hash` + `entry_hash`) verifies mathematical integrity on demand. | Physical direct disk access or OS root access with SQLite binary editing. Mitigated by append-only database triggers, offsite write-once-read-many (WORM) audit mirrors, and periodic hash anchoring. |
| **THREAT-05** | **Money Creation / Destruction** | Transfer debits source account, but destination credit fails midway, destroying money. Or deposits/withdrawals do not balance. | Strict double-entry accounting. Every movement consists of balanced journal entries where `Σ Debits == Σ Credits`. Wrapped inside an atomic database transaction (`db.transaction()`) with automatic rollback on any failure. | None. Invariant holds at all times: `Total Balances == Total Deposits - Total Withdrawals`. |
| **THREAT-06** | **Floating Point Rounding Leaks** | Standard IEEE 754 floating point arithmetic (`0.1 + 0.2 = 0.30000000000000004`) causes fractional cent leaks over thousands of transactions. | All currency values are stored, calculated, and enforced strictly as 64-bit integers in minor currency units (cents/paise). Floating point numbers are strictly forbidden in business logic. | Zero rounding loss. Currencies with non-decimal subunits (e.g., BHD with 3 decimals) would require configurable scaling factors. |
| **THREAT-07** | **In-Flight Idempotency Race** | Two concurrent identical requests arrive at the exact same millisecond before either completes. | Atomic key reservation: first thread inserts `IN_PROGRESS` key. Second thread catches duplicate key collision and immediately yields `409 Conflict` ("Request currently processing; please retry"). | Client must handle 409 by backing off briefly until the primary request resolves. |

---

## Detailed Threat Analyses & Proofs

### 1. Concurrency Race Condition Attack (THREAT-01)
* **The Vulnerability**: In a naive CRUD application:
  ```js
  // NAIVE (VULNERABLE) CODE:
  const account = await db.get("SELECT balance FROM accounts WHERE id = ?", id);
  if (account.balance >= amount) {
    // RACE WINDOW OCCURS HERE
    await db.run("UPDATE accounts SET balance = balance - ? WHERE id = ?", amount, id);
  }
  ```
  If two requests arrive concurrently with an account balance of $100 and both request $100:
  - Request A reads balance = $100 (Passes check)
  - Request B reads balance = $100 (Passes check)
  - Request A executes update: balance = $0
  - Request B executes update: balance = -$100 (OVERDRAWN!)
* **LedgerLine Defense**:
  1. **Serialized Write Transactions**: In SQLite WAL mode, `transaction()` executes `BEGIN IMMEDIATE`, immediately acquiring a reserved lock so concurrent writers are serialized rather than interleaving dirty reads.
  2. **Atomic SQL Predicate**:
     ```sql
     UPDATE accounts 
     SET balance = balance - @amount, updated_at = datetime('now')
     WHERE id = @accountId AND balance >= @amount;
     ```
     Even if two statements were executed concurrently, only the first statement matches the `balance >= @amount` condition. The second statement finds 0 matching rows (`changes === 0`), causing LedgerLine to abort and log a refused attempt.
  3. **Database Engine Floor Constraint**:
     ```sql
     CONSTRAINT chk_user_account_balance_floor CHECK (is_system = 1 OR balance >= 0)
     ```
     Even if application code were compromised, SQLite itself enforces the invariant at the storage engine level.
* **Automated Proof**: Tested in `test/02_concurrency_race.test.js` where 15 concurrent requests race against an $800 balance: exactly 8 succeed, exactly 7 fail with `INSUFFICIENT_FUNDS`, and ending balance is precisely $0.00.

---

### 2. Double-Spend & Duplicate Replay (THREAT-02)
* **The Vulnerability**: Mobile networks drop connection before receiving the HTTP 200 response. The client retries the request. If the server does not recognize the duplicate, it debits the payer and credits the payee a second time.
* **LedgerLine Defense**:
  1. Every mutating request carries an `Idempotency-Key` HTTP header.
  2. When request arrives, `acquireOrCheckKey` computes SHA-256 hash of payload.
  3. If key is unseen, it is atomically inserted into `idempotency_keys` with `status = 'IN_PROGRESS'`.
  4. Upon transaction success, response body and status code are committed to the key record.
  5. If the request is replayed, LedgerLine intercepts it, adds header `Idempotent-Replayed: true`, and returns the cached response with `isDuplicate: true` without moving any funds.
  6. If an attacker attempts to reuse an existing key with altered parameters (e.g., trying to change the recipient or amount), LedgerLine computes the hash mismatch and returns `422 Unprocessable Entity` (`IDEMPOTENCY_PAYLOAD_MISMATCH`).
* **Automated Proof**: Tested in `test/03_idempotency.test.js` covering both sequential replays and 5-way simultaneous race replays with identical keys.

---

### 3. Ledger Immutability & Audit Trail Concealment (THREAT-04)
* **The Vulnerability**: A database administrator or rogue service updates a ledger row (`UPDATE ledger_entries SET amount = 0 WHERE id = 42`) or deletes a refusal record to hide evidence.
* **LedgerLine Defense**:
  1. **Database Triggers**:
     ```sql
     CREATE TRIGGER trg_prevent_ledger_update
     BEFORE UPDATE ON ledger_entries
     BEGIN
         SELECT RAISE(ABORT, 'LEDGER_IMMUTABLE: ledger_entries cannot be modified once written');
     END;

     CREATE TRIGGER trg_prevent_ledger_delete
     BEFORE DELETE ON ledger_entries
     BEGIN
         SELECT RAISE(ABORT, 'LEDGER_IMMUTABLE: ledger_entries cannot be deleted once written');
     END;
     ```
  2. **Cryptographic SHA-256 Hash Chaining**:
     Every ledger entry records:
     - `prev_hash`: Hash of the preceding block in the table.
     - `entry_hash`: `SHA256(prev_hash : entry_id : tx_id : account_id : entry_type : amount : running_balance : created_at)`
  3. **Live Mathematical & Cryptographic Proof**:
     `GET /api/reconciliation` recalculates the hash chain from block 1 to block N and tests money conservation across the entire ledger. If any row was altered by an external tool that bypassed triggers, `chainValid` immediately reports `false` and identifies the `corruptedEntryId`.
* **Automated Proof**: Tested in `test/05_tamper_proof.test.js`, verifying trigger rejection and mathematical tamper detection.

---

### 4. Cross-Tenant Money Movement & Authorization Bypass (THREAT-03)
* **The Vulnerability**: Account holder Alice attempts to initiate a transfer specifying Bob's account ID as `fromAccountId`.
* **LedgerLine Defense**:
  1. `requireAccountPermission` middleware extracts `fromAccountId` and executes `verifyAccountAuthorization`.
  2. The server compares the account's `user_id` against the cryptographic JWT claims (`req.user.id`).
  3. Non-owners are immediately rejected with `403 Forbidden` (`UNAUTHORIZED_ACCOUNT_ACCESS`).
  4. The rejected attempt is written to `refused_attempts` audit table, recording the unauthorized user ID, target account ID, requested amount, and timestamp.
  5. The `AUDITOR` role has full read access to statements and reconciliation proofs, but is blocked from executing any money movements (`403 Forbidden`).
* **Automated Proof**: Tested in `test/04_authorization.test.js`.

---

## Known Accepted Risks & Architectural Boundaries

1. **Single-Writer SQLite Concurrency Ceiling**:
   * *Risk*: SQLite allows only one writer transaction at any given microsecond. Under thousands of concurrent writes per second, lock contention can result in `SQLITE_BUSY` timeouts.
   * *Why Accepted*: For a proven, self-contained double-entry ledger with zero external infrastructure dependencies, SQLite with WAL mode (`PRAGMA journal_mode = WAL;`) easily handles 1,000+ financial transactions per second on modest hardware with absolute serializability.
   * *Production Migration Path*: In a multi-region distributed system, PostgreSQL with partitioned row locks (`SELECT ... FOR UPDATE`) or a distributed state machine (e.g., Raft/TigerBeetle) would be adopted.

2. **Idempotency Key Storage Growth**:
   * *Risk*: Unbounded growth of `idempotency_keys` table over years of operation.
   * *Why Accepted*: High-cardinality keys are essential for historical dispute resolution.
   * *Production Mitigation*: Move keys older than 90 days to cold read-only storage while maintaining hot indexes for active transaction windows.
