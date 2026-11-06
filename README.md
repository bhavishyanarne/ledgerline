# LedgerLine — Money Movement with a Ledger You Can Prove

> **"Move money so the books always balance and the same request never pays twice."**  
> Built for zero-drift financial integrity, strict concurrency serialization, exactly-once idempotency, and cryptographic tamper-evidence.

---

## 🚀 Live Demo & Repository Links

* **GitHub Repository**: [https://github.com/bhavishyanarne/ledgerline](https://github.com/bhavishyanarne/ledgerline)
* **Live Deployment URL**: [https://ledgerline-core.onrender.com](https://ledgerline-core.onrender.com) *(or run locally in 5 seconds via `npm start`)*

---

## 🔑 Seed Accounts & Credentials

The system automatically initializes and seeds four accounts covering all required roles on first boot:

| Role | Name | Email | Password | Primary Capabilities |
| :--- | :--- | :--- | :--- | :--- |
| **Administrator** | System Administrator | `admin@ledgerline.internal` | `AdminPass123!` | Create accounts, view system-wide balances, inspect audit trail, freeze/unfreeze accounts. |
| **Account Holder** | Alice Chen | `alice@ledgerline.internal` | `AlicePass123!` | View owned accounts (Checking & Savings), initiate transfers, deposits, withdrawals, and inspect own statement. |
| **Account Holder** | Bob Martinez | `bob@ledgerline.internal` | `BobPass123!` | View owned account (Business Operating), initiate transfers, and inspect own statement. |
| **Auditor** | Auditor Compliance | `auditor@ledgerline.internal` | `AuditorPass123!` | **Strictly Read-Only**. Full visibility into all customer accounts, ledger journal entries, refused attempts, and cryptographic proofs. Blocked from moving money. |

*(The web interface includes an instant 1-click **Persona Switcher** in the header so evaluators can switch between roles immediately without retyping credentials).*

---

## 🏛️ Core Architectural Foundations

### 1. The Double-Entry Ledger & Money Conservation
Every financial movement consists of balanced journal entries where debits strictly equal credits.
* **Internal Transfer ($150.00 from Alice to Bob)**:
  * `DEBIT` Alice Checking (-$150.00)
  * `CREDIT` Bob Operating (+$150.00)
  * Net change across user accounts = **$0.00**
* **External Deposit ($500.00 into Alice Checking)**:
  * `DEBIT` Federal Clearinghouse Settlement Account (-$500.00)
  * `CREDIT` Alice Checking (+$500.00)
  * Net user balance changes by **+$500.00**
* **System Conservation Invariant**:
  $$\sum \text{User Account Balances} \equiv \sum \text{External Deposits} - \sum \text{External Withdrawals}$$
  $$\sum \text{Debits} \equiv \sum \text{Credits}$$
  This invariant is continuously verified and surfaced in real-time via `GET /api/reconciliation`.

### 2. Multi-Layered Concurrency Safety (Zero Overdraft Guarantee)
To guarantee that two racing requests can never overdraw an account, LedgerLine employs a 3-tier defense:
1. **Serialized Write Transactions**: Handled with SQLite WAL mode using `BEGIN IMMEDIATE`. Writers are strictly serialized at write time, eliminating dirty reads and race windows.
2. **Atomic SQL Predicate**:
   ```sql
   UPDATE accounts 
   SET balance = balance - @amount, updated_at = datetime('now')
   WHERE id = @accountId AND balance >= @amount;
   ```
   If two requests race, only one matches `balance >= @amount`. The other sees `changes === 0`, rolls back, and logs an `INSUFFICIENT_FUNDS` refusal.
3. **Storage Engine Floor Constraint**:
   ```sql
   CONSTRAINT chk_user_account_balance_floor CHECK (is_system = 1 OR balance >= 0)
   ```
   Enforced directly in the database engine. Even if application code were bypassed, the database aborts any transaction attempting to write a negative balance.

### 3. Exactly-Once Idempotency Engine
Every mutating request carries an `Idempotency-Key` header (e.g., UUID v4).
1. **Atomic In-Flight Reservation**: The key is atomically inserted into `idempotency_keys` with `status = 'IN_PROGRESS'`. If a concurrent duplicate arrives while the first is executing, it immediately receives `409 Conflict`.
2. **Deterministic Payload Hashing**: Computes SHA-256 of request parameters. If an attacker reuses a key with altered parameters, the server rejects it with `422 Unprocessable Entity` (`IDEMPOTENCY_PAYLOAD_MISMATCH`).
3. **Cached Replay**: Once completed, identical requests return the cached response with header `Idempotent-Replayed: true` and payload `is_duplicate: true` without executing a second debit.

### 4. Append-Only Ledger & Cryptographic Block Hash Chaining
A ledger that can be silently edited is not a record. LedgerLine guarantees immutability through two mechanisms:
1. **SQLite Database Triggers**:
   `BEFORE UPDATE` and `BEFORE DELETE` triggers on `ledger_entries` and `refused_attempts` call `RAISE(ABORT, 'LEDGER_IMMUTABLE')`, preventing any modification or deletion.
2. **Cryptographic SHA-256 Hash Chaining**:
   Every ledger entry contains:
   $$\text{entry\_hash} = \text{SHA256}(\text{prev\_hash} : \text{entry\_id} : \text{tx\_id} : \text{account\_id} : \text{entry\_type} : \text{amount} : \text{running\_bal} : \text{created\_at})$$
   Any modification of past rows breaks the mathematical chain, which is instantly caught and reported by `GET /api/reconciliation`.

### 5. Comprehensive Statement & Refusal Audit Trail
Every account statement seamlessly unifies:
* Successful postings (`DEBIT` / `CREDIT`) with resulting running balances.
* **Every Refused Attempt**: Overdraft attempts, unauthorized moves, inactive accounts, and invalid parameters are permanently recorded with the initiator, requested amount, refusal reason, and timestamp.

---

## 📡 API Documentation

All mutating requests require header `Idempotency-Key: <unique-uuid>` and `Authorization: Bearer <token>`.

| Method | Endpoint | Allowed Roles | Description & Money Impact |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/auth/login` | Public | Authenticates credentials and returns JWT token + user profile. |
| `GET` | `/api/auth/me` | Authenticated | Returns profile and permissions of authenticated user. |
| `GET` | `/api/accounts` | All | Lists accounts. Admins/Auditors see all accounts; Account Holders see only their own accounts. |
| `GET` | `/api/accounts/:id` | Account Owner, Admin, Auditor | Retrieves account details and current balance. |
| `POST` | `/api/accounts` | Account Holder, Admin | Provisions new account with $0.00 balance. Initial funding must occur via double-entry deposit. |
| `GET` | `/api/accounts/:id/statement` | Account Owner, Admin, Auditor | Retrieves chronological statement including debits, credits, running balances, and refused attempts. |
| `POST` | `/api/transactions/transfer` | Account Owner, Admin | Moves money between two accounts. Debits source, credits destination. Net system balance: **$0.00**. |
| `POST` | `/api/transactions/deposit` | Account Owner, Admin | External deposit. Debits system clearing, credits target account. Increases total balances by **+$amount**. |
| `POST` | `/api/transactions/withdraw` | Account Owner | External withdrawal. Debits target account, credits system clearing. Decreases total balances by **-$amount**. |
| `GET` | `/api/reconciliation` | All | Verifies mathematical conservation ($\Delta = 0$), double-entry equality ($\Sigma D = \Sigma C$), and SHA-256 ledger hash chain. |
| `GET` | `/api/audit/refused` | Admin, Auditor | Lists all refused attempts with initiator identity and refusal reason. |
| `GET` | `/api/audit/idempotency`| Admin, Auditor | Lists idempotency records and replayed requests. |
| `GET` | `/api/audit/ledger` | Admin, Auditor | Lists raw append-only ledger entries with SHA-256 block hashes. |

---

## 🧪 Automated Test Suite (18 Tests, 0 Failures)

The test suite runs using Node.js's native test runner (`node --test`) with zero external test framework bloat:

```bash
# Run all tests
npm test

# Run tests with verbose spec reporter
npm run test:verbose
```

### Verified Test Suites:
1. `test/01_conservation.test.js`: Proves money conservation across transfers, deposits, withdrawals, and 25 rapid stress movements.
2. `test/02_concurrency_race.test.js`: Fires 15 concurrent withdrawals against an $800 balance. Exactly 8 succeed ($800 total), 7 fail with `INSUFFICIENT_FUNDS`, balance ends at $0.00, never negative!
3. `test/03_idempotency.test.js`: Proves sequential replay returns identical results without double-debiting, 5 simultaneous concurrent replays only move money once, and payload tampering is rejected with 422.
4. `test/04_authorization.test.js`: Proves Alice cannot debit Bob's account (403), Auditor cannot initiate transfers/withdrawals (403), and unauthorized attempts are logged to the refusal audit trail.
5. `test/05_tamper_proof.test.js`: Proves SQLite triggers block direct SQL `UPDATE` and `DELETE`, and altering a row breaks the SHA-256 block hash chain.

---

## 🛠️ Local Development & Quick Start

### Prerequisites
* Node.js v22+ (uses Node 22 native built-in `node:sqlite` — zero native compilation dependencies!)

### 1. Clone & Install
```bash
git clone https://github.com/bhavishyanarne/ledgerline.git
cd ledgerline
npm install
```

### 2. Run Tests
```bash
npm test
```

### 3. Start Application
```bash
npm start
```
Open **[http://localhost:3000](http://localhost:3000)** in your browser to interact with the dashboard, run live double-click simulations, and execute concurrent race condition attacks!

---

## 🚢 Deployment (Render / Docker)

### 1-Click Deploy on Render:
1. Push repository to GitHub.
2. In Render Dashboard, click **New > Blueprint** and connect the repository (using `render.yaml`).
3. Deploy for free with zero credit card required!

### Docker Deploy:
```bash
docker build -t ledgerline .
docker run -p 3000:3000 ledgerline
```

---

## 📂 Project Structure
```
ledgerline/
├── package.json              # Project dependencies (zero-native pure JS)
├── server.js                 # Server entrypoint with auto-seed on boot
├── Dockerfile                # Multi-platform Node 22 alpine container
├── render.yaml               # Render cloud deployment blueprint
├── THREATS.md                # Threat model and security mitigations
├── PROMPTS.md                # 5 dated AI failure analyses & corrections
├── README.md                 # Complete documentation & credentials
├── src/
│   ├── config.js             # Environment variables & constants
│   ├── app.js                # Express app, static routing, error handling
│   ├── db/
│   │   ├── index.js          # SQLite connection, WAL mode, BEGIN IMMEDIATE transactions
│   │   ├── schema.sql        # Tables, foreign keys, triggers, CHECK constraints
│   │   └── seed.js           # Default users, accounts, and initial double-entry journal
│   ├── middleware/
│   │   ├── auth.js           # JWT verification, RBAC, account-level permission enforcement
│   │   └── idempotency.js    # Idempotency header extraction and replay caching
│   ├── services/
│   │   ├── authService.js    # Password hashing (bcrypt) and token generation
│   │   ├── idempotencyService.js # In-flight locking and SHA-256 payload validation
│   │   └── ledgerService.js  # Double-entry engine, hash chaining, reconciliation proofs
│   └── routes/
│       ├── authRoutes.js     # /api/auth
│       ├── accountRoutes.js  # /api/accounts
│       ├── transactionRoutes.js # /api/transactions
│       ├── reconciliationRoutes.js # /api/reconciliation
│       └── auditRoutes.js    # /api/audit
├── public/                   # Sleek single-page dashboard UI
│   ├── index.html            # Persona switcher, statement table, race simulator
│   ├── style.css             # Modern dark fintech stylesheet
│   └── app.js                # Interactive client-side application logic
└── test/                     # Automated test suites
    ├── helpers.js            # In-memory test context & token generator
    ├── 01_conservation.test.js
    ├── 02_concurrency_race.test.js
    ├── 03_idempotency.test.js
    ├── 04_authorization.test.js
    └── 05_tamper_proof.test.js
```
