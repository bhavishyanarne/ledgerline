const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const config = require('../src/config');
const { getDb } = require('../src/db');

function createTestContext() {
  // Use in-memory SQLite for fast, isolated, deterministic tests
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');

  const schemaPath = path.join(__dirname, '../src/db/schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schemaSql);

  // Seed baseline users
  const adminHash = bcrypt.hashSync('AdminPass123!', 8);
  const aliceHash = bcrypt.hashSync('AlicePass123!', 8);
  const bobHash = bcrypt.hashSync('BobPass123!', 8);
  const auditorHash = bcrypt.hashSync('AuditorPass123!', 8);
  const systemHash = bcrypt.hashSync('SystemInternalPass123!', 8);

  const insertUser = db.prepare('INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)');
  insertUser.run(config.SYSTEM_USER_ID, 'System Settlement Core', 'system@ledgerline.internal', systemHash, 'ADMIN');
  insertUser.run('usr_admin', 'System Administrator', 'admin@ledgerline.internal', adminHash, 'ADMIN');
  insertUser.run('usr_alice', 'Alice Chen', 'alice@ledgerline.internal', aliceHash, 'ACCOUNT_HOLDER');
  insertUser.run('usr_bob', 'Bob Martinez', 'bob@ledgerline.internal', bobHash, 'ACCOUNT_HOLDER');
  insertUser.run('usr_auditor', 'Auditor Compliance', 'auditor@ledgerline.internal', auditorHash, 'AUDITOR');

  // Seed baseline accounts
  const insertAccount = db.prepare('INSERT INTO accounts (id, account_number, user_id, name, currency, balance, is_system, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insertAccount.run(config.SYSTEM_ACCOUNT_ID, 'SYS-CLEARING-001', config.SYSTEM_USER_ID, 'Federal Settlement & Clearinghouse', 'USD', 0, 1, 'ACTIVE');
  insertAccount.run('acc_alice_chk', 'ACT-ALICE-CHK', 'usr_alice', "Alice Checking", 'USD', 100000, 0, 'ACTIVE'); // $1,000.00
  insertAccount.run('acc_bob_ops', 'ACT-BOB-OPS', 'usr_bob', "Bob Operating", 'USD', 50000, 0, 'ACTIVE'); // $500.00

  // Generate tokens for testing
  const tokens = {
    admin: jwt.sign({ userId: 'usr_admin', name: 'System Administrator', email: 'admin@ledgerline.internal', role: 'ADMIN' }, config.JWT_SECRET),
    alice: jwt.sign({ userId: 'usr_alice', name: 'Alice Chen', email: 'alice@ledgerline.internal', role: 'ACCOUNT_HOLDER' }, config.JWT_SECRET),
    bob: jwt.sign({ userId: 'usr_bob', name: 'Bob Martinez', email: 'bob@ledgerline.internal', role: 'ACCOUNT_HOLDER' }, config.JWT_SECRET),
    auditor: jwt.sign({ userId: 'usr_auditor', name: 'Auditor Compliance', email: 'auditor@ledgerline.internal', role: 'AUDITOR' }, config.JWT_SECRET)
  };

  return { db, tokens };
}

module.exports = {
  createTestContext
};
