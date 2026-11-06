const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { getDb, initDb } = require('../src/db');
const { seedDatabase } = require('../src/db/seed');
const { verifySystemReconciliation } = require('../src/services/ledgerService');

describe('Test 5: Ledger Immutability and Tamper Evidence', () => {
  beforeEach(() => {
    const db = getDb();
    initDb(db);
    seedDatabase(db);
  });

  test('Immutability Trigger: Direct SQL UPDATE on ledger_entries is blocked by database trigger', () => {
    const db = getDb();
    const firstEntry = db.prepare('SELECT id, amount FROM ledger_entries LIMIT 1').get();
    assert.ok(firstEntry);

    assert.throws(() => {
      db.prepare('UPDATE ledger_entries SET amount = 999999 WHERE id = ?').run(firstEntry.id);
    }, (err) => {
      return err.message.includes('LEDGER_IMMUTABLE');
    });
  });

  test('Immutability Trigger: Direct SQL DELETE on ledger_entries is blocked by database trigger', () => {
    const db = getDb();
    const firstEntry = db.prepare('SELECT id FROM ledger_entries LIMIT 1').get();
    assert.ok(firstEntry);

    assert.throws(() => {
      db.prepare('DELETE FROM ledger_entries WHERE id = ?').run(firstEntry.id);
    }, (err) => {
      return err.message.includes('LEDGER_IMMUTABLE');
    });
  });

  test('Immutability Trigger: Direct SQL UPDATE/DELETE on refused_attempts is blocked', () => {
    const db = getDb();
    const refusal = db.prepare('SELECT id FROM refused_attempts LIMIT 1').get();
    assert.ok(refusal);

    assert.throws(() => {
      db.prepare("UPDATE refused_attempts SET reason = 'Hacked' WHERE id = ?").run(refusal.id);
    }, (err) => {
      return err.message.includes('AUDIT_IMMUTABLE');
    });

    assert.throws(() => {
      db.prepare('DELETE FROM refused_attempts WHERE id = ?').run(refusal.id);
    }, (err) => {
      return err.message.includes('AUDIT_IMMUTABLE');
    });
  });

  test('Cryptographic Proof: If triggers are disabled and row is tampered, hash chain catches it mathematically', () => {
    const db = getDb();

    // Verify baseline chain is valid
    const initialReport = verifySystemReconciliation();
    assert.equal(initialReport.cryptographicLedgerChain.chainValid, true);

    // Simulate an attacker temporarily disabling triggers to tamper a ledger row
    db.exec('DROP TRIGGER IF EXISTS trg_prevent_ledger_update;');

    // Alter an entry's running balance or amount
    const entryToTamper = db.prepare('SELECT id, entry_id, amount FROM ledger_entries ORDER BY id ASC LIMIT 1 OFFSET 2').get();
    db.prepare('UPDATE ledger_entries SET amount = amount + 5000 WHERE id = ?').run(entryToTamper.id);

    // Re-run system verification
    const tamperedReport = verifySystemReconciliation();
    assert.equal(tamperedReport.cryptographicLedgerChain.chainValid, false);
    assert.equal(tamperedReport.overallIntegrityProven, false);
    assert.equal(tamperedReport.cryptographicLedgerChain.corruptedEntryId, entryToTamper.entry_id);

    // Re-enable trigger
    db.exec(`
      CREATE TRIGGER trg_prevent_ledger_update
      BEFORE UPDATE ON ledger_entries
      BEGIN
          SELECT RAISE(ABORT, 'LEDGER_IMMUTABLE: ledger_entries cannot be modified once written');
      END;
    `);
  });
});
