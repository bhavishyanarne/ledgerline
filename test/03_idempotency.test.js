const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

const app = require('../src/app');
const { getDb, initDb } = require('../src/db');
const { seedDatabase } = require('../src/db/seed');
const { getAccountStatement } = require('../src/services/ledgerService');

describe('Test 3: Idempotency and Exactly-Once Semantics', () => {
  beforeEach(() => {
    const db = getDb();
    initDb(db);
    seedDatabase(db);
  });

  test('Sequential replay: Resubmitting identical request with same key returns original result and does not move money twice', async () => {
    const aliceLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@ledgerline.internal', password: 'AlicePass123!' });
    const token = aliceLogin.body.token;

    const key = `idem_seq_${uuidv4()}`;
    const payload = {
      fromAccountId: 'acc_alice_checking',
      toAccountId: 'acc_bob_operating',
      amount: 10000, // $100.00
      description: 'Vendor payment invoice #1001'
    };

    // First attempt: executes normally
    const firstRes = await request(app)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(payload);

    assert.equal(firstRes.status, 200);
    assert.equal(firstRes.body.status, 'POSTED');
    const originalTxId = firstRes.body.transactionId;
    assert.ok(originalTxId);

    // Balance after first transfer
    const aliceBalAfterFirst = getAccountStatement('acc_alice_checking').account.balance;

    // Second attempt: identical key and payload (network retry simulation)
    const secondRes = await request(app)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(payload);

    assert.equal(secondRes.status, 200);
    assert.equal(secondRes.headers['idempotent-replayed'], 'true');
    assert.equal(secondRes.body.transactionId, originalTxId);
    assert.equal(secondRes.body.idempotentReplay, true);

    // Third attempt
    const thirdRes = await request(app)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(payload);

    assert.equal(thirdRes.status, 200);
    assert.equal(thirdRes.headers['idempotent-replayed'], 'true');
    assert.equal(thirdRes.body.transactionId, originalTxId);

    // Balance must NOT have moved again
    const aliceBalAfterThird = getAccountStatement('acc_alice_checking').account.balance;
    assert.equal(aliceBalAfterThird, aliceBalAfterFirst);
  });

  test('Concurrent replay: 5 simultaneous requests with the SAME key move money only once', async () => {
    const aliceLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@ledgerline.internal', password: 'AlicePass123!' });
    const token = aliceLogin.body.token;

    const startBal = getAccountStatement('acc_alice_checking').account.balance;
    const sameKey = `idem_concurrent_${uuidv4()}`;
    const transferAmount = 15000; // $150.00

    const promises = Array.from({ length: 5 }).map(() => {
      return request(app)
        .post('/api/transactions/transfer')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', sameKey)
        .send({
          fromAccountId: 'acc_alice_checking',
          toAccountId: 'acc_bob_operating',
          amount: transferAmount,
          description: 'Double click simultaneous test'
        });
    });

    const responses = await Promise.all(promises);

    // All successful responses (either original or replayed) or 409 in-flight
    const successfulResponses = responses.filter(r => r.status === 200);
    assert.ok(successfulResponses.length >= 1, 'At least 1 request succeeded');

    // Every successful response references the EXACT same transactionId
    const txIds = new Set(successfulResponses.map(r => r.body.transactionId));
    assert.equal(txIds.size, 1, 'All successful responses must share the exact same transactionId');

    // The account balance decreased by EXACTLY one transfer amount ($150.00), not 5x!
    const endBal = getAccountStatement('acc_alice_checking').account.balance;
    assert.equal(endBal, startBal - transferAmount);
  });

  test('Payload mismatch: Reusing an idempotency key with different parameters is rejected with 422', async () => {
    const aliceLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@ledgerline.internal', password: 'AlicePass123!' });
    const token = aliceLogin.body.token;

    const key = `idem_mismatch_${uuidv4()}`;

    // First request: transfer $50.00
    const firstRes = await request(app)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({
        fromAccountId: 'acc_alice_checking',
        toAccountId: 'acc_bob_operating',
        amount: 5000,
        description: 'First payload'
      });
    assert.equal(firstRes.status, 200);

    // Second request: same key, but different amount ($200.00)
    const secondRes = await request(app)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({
        fromAccountId: 'acc_alice_checking',
        toAccountId: 'acc_bob_operating',
        amount: 20000, // Different amount!
        description: 'Modified payload'
      });

    assert.equal(secondRes.status, 422);
    assert.equal(secondRes.body.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
  });

  test('Audit Trail can show which requests were duplicates', async () => {
    const aliceLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@ledgerline.internal', password: 'AlicePass123!' });

    const key = `audit_idem_${uuidv4()}`;
    await request(app)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${aliceLogin.body.token}`)
      .set('Idempotency-Key', key)
      .send({
        fromAccountId: 'acc_alice_checking',
        toAccountId: 'acc_bob_operating',
        amount: 2500,
        description: 'Audit idempotency test transfer'
      });

    const adminLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@ledgerline.internal', password: 'AdminPass123!' });

    const auditRes = await request(app)
      .get('/api/audit/idempotency')
      .set('Authorization', `Bearer ${adminLogin.body.token}`);

    assert.equal(auditRes.status, 200);
    assert.ok(Array.isArray(auditRes.body.records));
    assert.ok(auditRes.body.records.length > 0);
    const recordedKey = auditRes.body.records.find(r => r.key === key);
    assert.ok(recordedKey, 'The idempotency key must be present in the audit records');
    assert.equal(recordedKey.status, 'COMPLETED');
  });
});
