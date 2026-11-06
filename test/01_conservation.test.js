const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

const app = require('../src/app');
const { getDb, initDb } = require('../src/db');
const { seedDatabase } = require('../src/db/seed');
const { verifySystemReconciliation } = require('../src/services/ledgerService');

describe('Test 1: Conservation of Money and Double-Entry Invariants', () => {
  beforeEach(() => {
    const db = getDb();
    initDb(db);
    seedDatabase(db);
  });

  test('Internal transfers strictly conserve money (net change = 0)', async () => {
    // Check initial state
    const initialReport = verifySystemReconciliation();
    assert.equal(initialReport.moneyConservation.invariantHolds, true);
    const initialTotal = initialReport.moneyConservation.actualUserBalance;

    // Login Alice and transfer $150.00 to Bob
    const aliceLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@ledgerline.internal', password: 'AlicePass123!' });
    const aliceToken = aliceLogin.body.token;

    const transferRes = await request(app)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${aliceToken}`)
      .set('Idempotency-Key', `test_conserv_${uuidv4()}`)
      .send({
        fromAccountId: 'acc_alice_checking',
        toAccountId: 'acc_bob_operating',
        amount: 15000, // $150.00
        description: 'Test conservation transfer'
      });

    assert.equal(transferRes.status, 200);
    assert.equal(transferRes.body.status, 'POSTED');

    // Verify system invariant
    const updatedReport = verifySystemReconciliation();
    assert.equal(updatedReport.moneyConservation.invariantHolds, true);
    assert.equal(updatedReport.moneyConservation.actualUserBalance, initialTotal);
    assert.equal(updatedReport.moneyConservation.discrepancy, 0);
    assert.equal(updatedReport.doubleEntry.doubleEntryBalanced, true);
    assert.equal(updatedReport.doubleEntry.netDifference, 0);
  });

  test('External deposits increase total balances by exact deposit amount', async () => {
    const initialReport = verifySystemReconciliation();
    const initialTotal = initialReport.moneyConservation.actualUserBalance;
    const depositAmount = 25000; // $250.00

    const adminLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@ledgerline.internal', password: 'AdminPass123!' });

    const depositRes = await request(app)
      .post('/api/transactions/deposit')
      .set('Authorization', `Bearer ${adminLogin.body.token}`)
      .set('Idempotency-Key', `test_deposit_${uuidv4()}`)
      .send({
        accountId: 'acc_bob_operating',
        amount: depositAmount,
        description: 'Customer wire deposit'
      });

    assert.equal(depositRes.status, 200);

    const updatedReport = verifySystemReconciliation();
    assert.equal(updatedReport.moneyConservation.invariantHolds, true);
    assert.equal(updatedReport.moneyConservation.actualUserBalance, initialTotal + depositAmount);
    assert.equal(updatedReport.moneyConservation.discrepancy, 0);
  });

  test('External withdrawals decrease total balances by exact withdrawal amount', async () => {
    const initialReport = verifySystemReconciliation();
    const initialTotal = initialReport.moneyConservation.actualUserBalance;
    const withdrawAmount = 10000; // $100.00

    const aliceLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@ledgerline.internal', password: 'AlicePass123!' });

    const withdrawRes = await request(app)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${aliceLogin.body.token}`)
      .set('Idempotency-Key', `test_withdraw_${uuidv4()}`)
      .send({
        accountId: 'acc_alice_checking',
        amount: withdrawAmount,
        description: 'ATM Cash Withdrawal'
      });

    assert.equal(withdrawRes.status, 200);

    const updatedReport = verifySystemReconciliation();
    assert.equal(updatedReport.moneyConservation.invariantHolds, true);
    assert.equal(updatedReport.moneyConservation.actualUserBalance, initialTotal - withdrawAmount);
    assert.equal(updatedReport.moneyConservation.discrepancy, 0);
  });

  test('Multi-movement stress: 25 rapid transfers maintain 100% mathematical invariant', async () => {
    const aliceLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@ledgerline.internal', password: 'AlicePass123!' });
    const bobLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'bob@ledgerline.internal', password: 'BobPass123!' });

    for (let i = 0; i < 25; i++) {
      const isAliceSender = i % 2 === 0;
      const token = isAliceSender ? aliceLogin.body.token : bobLogin.body.token;
      const from = isAliceSender ? 'acc_alice_checking' : 'acc_bob_operating';
      const to = isAliceSender ? 'acc_bob_operating' : 'acc_alice_checking';
      const amount = 500 + (i * 10); // varied cents

      const res = await request(app)
        .post('/api/transactions/transfer')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', `stress_tx_${i}_${uuidv4()}`)
        .send({
          fromAccountId: from,
          toAccountId: to,
          amount,
          description: `Rapid stress transfer #${i}`
        });

      assert.equal(res.status, 200);

      // Verify invariant at every step
      const report = verifySystemReconciliation();
      assert.equal(report.moneyConservation.invariantHolds, true);
      assert.equal(report.moneyConservation.discrepancy, 0);
      assert.equal(report.doubleEntry.doubleEntryBalanced, true);
      assert.equal(report.cryptographicLedgerChain.chainValid, true);
    }
  });
});
