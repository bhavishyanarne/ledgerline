const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

const app = require('../src/app');
const { getDb, initDb } = require('../src/db');
const { seedDatabase } = require('../src/db/seed');
const { verifySystemReconciliation, getAccountStatement } = require('../src/services/ledgerService');

describe('Test 2: Concurrency Safety and Race Condition Resistance', () => {
  beforeEach(() => {
    const db = getDb();
    initDb(db);
    seedDatabase(db);
  });

  test('Race Attack: 15 concurrent withdrawals of $100 against an $800 balance: exactly 8 succeed, 7 fail, balance never drops below zero', async () => {
    const aliceLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@ledgerline.internal', password: 'AlicePass123!' });
    const token = aliceLogin.body.token;

    // Verify starting balance: Alice checking is $800.00 (80000 cents)
    const initialStatement = getAccountStatement('acc_alice_checking');
    assert.equal(initialStatement.account.balance, 80000);

    // Launch 15 concurrent withdrawal requests simultaneously via Promise.all
    const concurrentRequestsCount = 15;
    const withdrawalAmount = 10000; // $100.00 each = $1,500.00 total requested

    const promises = Array.from({ length: concurrentRequestsCount }).map((_, index) => {
      const idempotencyKey = `race_withdraw_${index}_${uuidv4()}`;
      return request(app)
        .post('/api/transactions/withdraw')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          accountId: 'acc_alice_checking',
          amount: withdrawalAmount,
          description: `Concurrent race withdrawal attempt #${index}`
        });
    });

    const responses = await Promise.all(promises);

    let succeeded = 0;
    let failedInsufficientFunds = 0;

    for (const res of responses) {
      if (res.status === 200) {
        succeeded++;
      } else if (res.status === 400 && res.body.code === 'INSUFFICIENT_FUNDS') {
        failedInsufficientFunds++;
      }
    }

    // Exactly 8 must succeed (8 * $100 = $800) and 7 must fail
    assert.equal(succeeded, 8, `Expected exactly 8 requests to succeed, got ${succeeded}`);
    assert.equal(failedInsufficientFunds, 7, `Expected exactly 7 requests to fail with INSUFFICIENT_FUNDS, got ${failedInsufficientFunds}`);

    // Verify final account balance is exactly $0.00, NEVER negative
    const finalStatement = getAccountStatement('acc_alice_checking');
    assert.equal(finalStatement.account.balance, 0);
    assert.equal(finalStatement.account.balanceFormatted, '$0.00');

    // Verify system reconciliation invariant holds completely
    const report = verifySystemReconciliation();
    assert.equal(report.moneyConservation.invariantHolds, true);
    assert.equal(report.moneyConservation.discrepancy, 0);
    assert.equal(report.doubleEntry.doubleEntryBalanced, true);
    assert.equal(report.cryptographicLedgerChain.chainValid, true);
  });

  test('Race Attack: 10 concurrent transfers racing to drain account cannot overdraw or corrupt ledger', async () => {
    const bobLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'bob@ledgerline.internal', password: 'BobPass123!' });
    const token = bobLogin.body.token;

    // Bob Operating starting balance is $950.00 (95000 cents)
    const initialStatement = getAccountStatement('acc_bob_operating');
    const startBal = initialStatement.account.balance;
    assert.equal(startBal, 95000);

    // Fire 10 concurrent transfers of $200.00 each ($2,000.00 total)
    const promises = Array.from({ length: 10 }).map((_, index) => {
      return request(app)
        .post('/api/transactions/transfer')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', `race_transfer_${index}_${uuidv4()}`)
        .send({
          fromAccountId: 'acc_bob_operating',
          toAccountId: 'acc_alice_checking',
          amount: 20000, // $200.00
          description: `Race transfer #${index}`
        });
    });

    const responses = await Promise.all(promises);

    const succeeded = responses.filter(r => r.status === 200).length;
    const failed = responses.filter(r => r.status === 400).length;

    // $950 / $200 = 4 can succeed ($800 total transferred), remaining 6 must be refused
    assert.equal(succeeded, 4);
    assert.equal(failed, 6);

    const finalBob = getAccountStatement('acc_bob_operating');
    assert.equal(finalBob.account.balance, 15000); // exactly $150.00 left

    const finalAlice = getAccountStatement('acc_alice_checking');
    assert.equal(finalAlice.account.balance, 80000 + (4 * 20000)); // $800 + $800 = $1,600.00

    const report = verifySystemReconciliation();
    assert.equal(report.overallIntegrityProven, true);
    assert.equal(report.moneyConservation.discrepancy, 0);
  });
});
