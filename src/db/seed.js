const bcrypt = require('bcryptjs');
const { getDb, initDb } = require('./index');
const { deposit, transfer, logRefusedAttempt } = require('../services/ledgerService');
const config = require('../config');

function seedDatabase(db) {
  const targetDb = db || getDb();

  // Clean reset: drop tables and recreate schema to reset immutability triggers
  targetDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS ledger_entries;
    DROP TABLE IF EXISTS refused_attempts;
    DROP TABLE IF EXISTS transactions;
    DROP TABLE IF EXISTS idempotency_keys;
    DROP TABLE IF EXISTS accounts;
    DROP TABLE IF EXISTS users;
    PRAGMA foreign_keys = ON;
  `);
  initDb(targetDb);

  // Hash seed passwords
  const adminHash = bcrypt.hashSync('AdminPass123!', 8);
  const aliceHash = bcrypt.hashSync('AlicePass123!', 8);
  const bobHash = bcrypt.hashSync('BobPass123!', 8);
  const auditorHash = bcrypt.hashSync('AuditorPass123!', 8);
  const systemHash = bcrypt.hashSync('SystemInternalPass123!', 8);

  // 1. Seed Users
  const insertUser = targetDb.prepare(`
    INSERT INTO users (id, name, email, password_hash, role)
    VALUES (?, ?, ?, ?, ?)
  `);

  insertUser.run(config.SYSTEM_USER_ID, 'System Settlement Core', 'system@ledgerline.internal', systemHash, 'ADMIN');
  insertUser.run('usr_admin', 'System Administrator', 'admin@ledgerline.internal', adminHash, 'ADMIN');
  insertUser.run('usr_alice', 'Alice Chen', 'alice@ledgerline.internal', aliceHash, 'ACCOUNT_HOLDER');
  insertUser.run('usr_bob', 'Bob Martinez', 'bob@ledgerline.internal', bobHash, 'ACCOUNT_HOLDER');
  insertUser.run('usr_auditor', 'Auditor Compliance', 'auditor@ledgerline.internal', auditorHash, 'AUDITOR');

  // 2. Seed Accounts
  const insertAccount = targetDb.prepare(`
    INSERT INTO accounts (id, account_number, user_id, name, currency, balance, is_system, status)
    VALUES (?, ?, ?, ?, ?, 0, ?, 'ACTIVE')
  `);

  // System Clearing Account
  insertAccount.run(
    config.SYSTEM_ACCOUNT_ID,
    'SYS-CLEARING-001',
    config.SYSTEM_USER_ID,
    'Federal Settlement & Clearinghouse',
    'USD',
    1
  );

  // Alice's Accounts
  insertAccount.run(
    'acc_alice_checking',
    'ACT-ALICE-CHK',
    'usr_alice',
    "Alice Checking Account",
    'USD',
    0
  );

  insertAccount.run(
    'acc_alice_savings',
    'ACT-ALICE-SAV',
    'usr_alice',
    "Alice High-Yield Savings",
    'USD',
    0
  );

  // Bob's Account
  insertAccount.run(
    'acc_bob_operating',
    'ACT-BOB-OPS',
    'usr_bob',
    "Bob Business Operating",
    'USD',
    0
  );

  // 3. Seed Money Movements via Ledger Service (Enforcing Double-Entry & Invariants)
  deposit({
    accountId: 'acc_alice_checking',
    amount: 100000, // $1,000.00
    description: 'Initial payroll direct deposit',
    initiatorId: 'usr_admin',
    idempotencyKey: 'seed_dep_alice_chk'
  });

  deposit({
    accountId: 'acc_alice_savings',
    amount: 50000, // $500.00
    description: 'Initial opening deposit',
    initiatorId: 'usr_admin',
    idempotencyKey: 'seed_dep_alice_sav'
  });

  deposit({
    accountId: 'acc_bob_operating',
    amount: 75000, // $750.00
    description: 'Initial business capitalization',
    initiatorId: 'usr_admin',
    idempotencyKey: 'seed_dep_bob_ops'
  });

  // Transfer from Alice Checking to Bob Operating: $200.00
  transfer({
    fromAccountId: 'acc_alice_checking',
    toAccountId: 'acc_bob_operating',
    amount: 20000, // $200.00
    description: 'Vendor payment for consulting services',
    initiatorId: 'usr_alice',
    idempotencyKey: 'seed_tx_alice_to_bob'
  });

  // Log a sample refused attempt to prove the refusal audit trail works out of the box
  logRefusedAttempt({
    accountId: 'acc_alice_checking',
    action: 'WITHDRAWAL',
    amount: 5000000, // Attempted $50,000.00
    reason: 'INSUFFICIENT_FUNDS: Requested 5000000 cents, available 80000 cents',
    initiatorId: 'usr_alice',
    idempotencyKey: 'seed_refusal_overdraft_attempt'
  });
}

if (require.main === module) {
  initDb();
  seedDatabase();
  console.log('✓ Database seeded successfully.');
}

module.exports = { seedDatabase };
