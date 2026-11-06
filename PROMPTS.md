# LedgerLine — AI Directives, Failure Analyses & Corrections (PROMPTS.md)

This log records five distinct instances where AI generation produced flawed, vulnerable, or suboptimal implementations, the specific risks identified upon code review, and the engineered solutions implemented to guarantee financial integrity and correctness.

---

### Entry 1 — 2026-11-06: Native C++ Build Failure vs Zero-Dependency `node:sqlite`
* **What I asked the tool to do**:
  "Set up the project database layer using `better-sqlite3` to achieve synchronous transaction locking and high-performance WAL mode."
* **What it produced**:
  A standard npm configuration pulling in `better-sqlite3` with an initialization script assuming prebuilt binaries would link seamlessly on Node 22.
* **What was specifically wrong with it**:
  `better-sqlite3` relies on native C++ addons compiled via `node-gyp`. When installing on Node v22.17.1, `node-gyp` attempted to download release header archives from nodejs.org, which failed with `ECONNRESET` and native compiler incompatibilities. For an assessment submission requiring clean cloning and reliable instant deployment on any evaluation environment, introducing brittle native build toolchains introduces severe operational risk.
* **What I did instead**:
  Pivoted to Node 22's built-in `node:sqlite` (`DatabaseSync`). It provides native SQLite3 integration with zero npm dependencies, zero C++ compilation steps, out-of-the-box cross-platform portability (Windows, macOS, Linux, Docker, Render), and synchronous ACID transaction support with `BEGIN IMMEDIATE`.
* **Commit**: `feat(db): migrate to zero-dependency node:sqlite DatabaseSync architecture`

---

### Entry 2 — 2026-11-06: Double-Entry Clearinghouse Invariant Clash with Balance Floor Constraint
* **What I asked the tool to do**:
  "Define database table constraints to guarantee that no account can ever go below zero under any condition."
* **What it produced**:
  A global SQL table constraint on `accounts`:
  ```sql
  CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
      is_system INTEGER NOT NULL DEFAULT 0
  );
  ```
* **What was specifically wrong with it (Money-Integrity Failure)**:
  In a double-entry ledger, money is conserved by routing external deposits and withdrawals through a designated clearinghouse/settlement account (`acc_system_clearing`). When a user deposits $1,000, the user account is credited (+1000) while the clearinghouse account is debited (-1000) to represent external inflow.
  The naive `CHECK (balance >= 0)` constraint applied uniformly across the entire table, causing the database engine to reject legitimate initial deposits with `CHECK constraint failed: balance >= 0`. This fundamentally broke double-entry accounting!
* **What I did instead**:
  Refactored the check constraint to explicitly scope the non-negative floor to customer accounts while permitting the double-entry clearinghouse to track external settlements:
  ```sql
  CONSTRAINT chk_user_account_balance_floor CHECK (is_system = 1 OR balance >= 0)
  ```
  And in `ledger_entries`:
  ```sql
  CONSTRAINT chk_customer_running_balance CHECK (account_id = 'acc_system_clearing' OR running_balance >= 0)
  ```
  This strictly preserves the $0.00 floor on all customer-facing accounts while maintaining double-entry mathematical conservation.
* **Commit**: `fix(ledger): scope non-negative balance constraint to non-system accounts for double-entry settlement`

---

### Entry 3 — 2026-11-06: In-Flight Idempotency Race Condition and Payload Mismatch
* **What I asked the tool to do**:
  "Implement idempotency middleware that checks if an idempotency key was previously submitted."
* **What it produced**:
  A naive key lookup:
  ```js
  const existing = db.prepare("SELECT * FROM idempotency_keys WHERE key = ?").get(key);
  if (existing) {
    return res.status(200).json(JSON.parse(existing.response_body));
  }
  // proceed to execute transaction...
  ```
* **What was specifically wrong with it (Concurrency & Security Failure)**:
  1. **In-Flight Race Window**: If two duplicate requests arrive simultaneously (e.g. within 2 milliseconds due to client double-click or network racing), both execute the `SELECT`, neither finds an existing completed record, and *both execute the transfer concurrently*, paying the recipient twice!
  2. **Key Smuggling / Payload Mismatch**: An attacker could reuse an existing idempotency key while altering the destination account or transfer amount. The naive implementation would return the old cached response while leaving the system blind to the malicious intent.
* **What I did instead**:
  Implemented an atomic reservation pattern:
  1. Immediately compute a deterministic SHA-256 hash of the request parameters (`hashPayload`).
  2. Attempt an atomic `INSERT` of `(key, user_id, endpoint, request_hash, 'IN_PROGRESS')`.
  3. If key exists:
     - Check `request_hash`: If mismatched, immediately reject with `422 Unprocessable Entity` (`IDEMPOTENCY_PAYLOAD_MISMATCH`).
     - Check `status`: If `'IN_PROGRESS'`, return `409 Conflict` (`IDEMPOTENCY_IN_FLIGHT`).
     - If `'COMPLETED'`, return the cached status and payload with `is_duplicate: true`.
  4. Only commit `COMPLETED` once the database transaction commits.
* **Commit**: `feat(idempotency): add atomic in-flight reservation and payload hash verification`

---

### Entry 4 — 2026-11-06: JWT Property Discrepancy Bypassing Account Ownership Authorization
* **What I asked the tool to do**:
  "Add account authorization middleware to ensure account holders can only move money from accounts they own."
* **What it produced**:
  In `authService.js`:
  ```js
  // Inside token generation:
  const tokenPayload = { userId: user.id, role: user.role };
  // Inside verifyAccountAuthorization:
  if (account.user_id !== user.id) {
    throw new AuthError("Access denied", 403);
  }
  ```
* **What was specifically wrong with it (Access Control Breakdown)**:
  The JWT generation code stored the user identifier in `userId` (`{ userId: user.id }`), whereas `verifyAccountAuthorization` checked `user.id`.
  Because JavaScript evaluates missing properties to `undefined`, `user.id` was always `undefined`.
  This meant `account.user_id !== undefined` evaluated to `true` for EVERY request, causing all legitimate account holders to be locked out with false 403 Forbidden errors when attempting transfers. Conversely, had a loose check been used, it could have allowed privilege escalation.
* **What I did instead**:
  Standardized property names across token generation, middleware extraction, and service authorization:
  ```js
  const tokenPayload = { id: user.id, userId: user.id, name: user.name, email: user.email, role: user.role };
  const currentUserId = user.id || user.userId;
  if (account.user_id !== currentUserId) {
    throw new AuthError("Access denied: You do not have permission to access this account", 403);
  }
  ```
  Verified with automated tests in `test/04_authorization.test.js`.
* **Commit**: `fix(auth): standardize user identifier across JWT claims and account ownership checks`

---

### Entry 5 — 2026-11-06: Database Immutability Triggers Colliding with Test Isolation
* **What I asked the tool to do**:
  "Reset the database state between test suites in `beforeEach` to ensure test independence."
* **What it produced**:
  ```js
  function seedDatabase(db) {
    db.exec("PRAGMA foreign_keys = OFF;");
    db.exec("DELETE FROM ledger_entries;");
    db.exec("DELETE FROM refused_attempts;");
    ...
  }
  ```
* **What was specifically wrong with it (Audit Immutability Interaction)**:
  Our database schema enforces strict append-only triggers on `ledger_entries` and `refused_attempts`:
  ```sql
  CREATE TRIGGER trg_prevent_ledger_delete
  BEFORE DELETE ON ledger_entries
  BEGIN
      SELECT RAISE(ABORT, 'LEDGER_IMMUTABLE: ledger_entries cannot be deleted once written');
  END;
  ```
  In SQLite, `PRAGMA foreign_keys = OFF` disables foreign key checks, but does NOT disable active SQL triggers! Consequently, running `DELETE FROM ledger_entries;` threw `ERR_SQLITE_ERROR: LEDGER_IMMUTABLE: ledger_entries cannot be deleted once written`, crashing the test runner during test isolation.
* **What I did instead**:
  Updated the reset mechanism to drop tables completely (`DROP TABLE IF EXISTS ...`) and recreate the schema afresh via `initDb()`. Dropping the table drops the associated immutability triggers atomically, allowing a fresh ledger state for testing without weakening the append-only guarantee in runtime application code.
* **Commit**: `fix(test): cleanly recreate schema on test reset avoiding immutable trigger aborts`
