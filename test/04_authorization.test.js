const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

const app = require('../src/app');
const { getDb, initDb } = require('../src/db');
const { seedDatabase } = require('../src/db/seed');

describe('Test 4: Authorization and Role-Based Access Control', () => {
  beforeEach(() => {
    const db = getDb();
    initDb(db);
    seedDatabase(db);
  });

  test('Attack: Alice cannot move money out of Bob’s account (403 Forbidden)', async () => {
    // Login Alice
    const aliceLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@ledgerline.internal', password: 'AlicePass123!' });
    const aliceToken = aliceLogin.body.token;

    // Alice attempts to initiate a transfer with Bob's account as source
    const attackRes = await request(app)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${aliceToken}`)
      .set('Idempotency-Key', `attack_auth_${uuidv4()}`)
      .send({
        fromAccountId: 'acc_bob_operating', // Bob's account!
        toAccountId: 'acc_alice_checking',
        amount: 30000,
        description: 'Unauthorized theft attempt'
      });

    assert.equal(attackRes.status, 403);
    assert.equal(attackRes.body.code, 'UNAUTHORIZED_ACCOUNT_ACCESS');

    // Verify the refused attempt was logged to the audit table
    const auditorLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'auditor@ledgerline.internal', password: 'AuditorPass123!' });

    const auditRes = await request(app)
      .get('/api/audit/refused')
      .set('Authorization', `Bearer ${auditorLogin.body.token}`);

    assert.equal(auditRes.status, 200);
    const theftAttempt = auditRes.body.refusals.find(r => r.account_id === 'acc_bob_operating' && r.reason.includes('UNAUTHORIZED_ACCOUNT_ACCESS'));
    assert.ok(theftAttempt, 'The unauthorized attempt must be permanently recorded in refused attempts');
    assert.equal(theftAttempt.initiator_email, 'alice@ledgerline.internal');
  });

  test('Auditor is strictly read-only and cannot move money (403 Forbidden)', async () => {
    const auditorLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'auditor@ledgerline.internal', password: 'AuditorPass123!' });
    const auditorToken = auditorLogin.body.token;

    // Auditor attempts to transfer
    const transferRes = await request(app)
      .post('/api/transactions/transfer')
      .set('Authorization', `Bearer ${auditorToken}`)
      .set('Idempotency-Key', `auditor_move_${uuidv4()}`)
      .send({
        fromAccountId: 'acc_alice_checking',
        toAccountId: 'acc_bob_operating',
        amount: 1000,
        description: 'Auditor illegal move'
      });

    assert.equal(transferRes.status, 403);

    // Auditor attempts to withdraw
    const withdrawRes = await request(app)
      .post('/api/transactions/withdraw')
      .set('Authorization', `Bearer ${auditorToken}`)
      .set('Idempotency-Key', `auditor_withdraw_${uuidv4()}`)
      .send({
        accountId: 'acc_alice_checking',
        amount: 1000,
        description: 'Auditor illegal withdrawal'
      });

    assert.equal(withdrawRes.status, 403);

    // Auditor CAN read statements and system reconciliation
    const statementRes = await request(app)
      .get('/api/accounts/acc_alice_checking/statement')
      .set('Authorization', `Bearer ${auditorToken}`);

    assert.equal(statementRes.status, 200);
    assert.ok(Array.isArray(statementRes.body.statement));

    const reconRes = await request(app)
      .get('/api/reconciliation')
      .set('Authorization', `Bearer ${auditorToken}`);

    assert.equal(reconRes.status, 200);
    assert.equal(reconRes.body.overallIntegrityProven, true);
  });

  test('Privacy: Alice cannot view statements of accounts owned by Bob', async () => {
    const aliceLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@ledgerline.internal', password: 'AlicePass123!' });

    const snoopRes = await request(app)
      .get('/api/accounts/acc_bob_operating/statement')
      .set('Authorization', `Bearer ${aliceLogin.body.token}`);

    assert.equal(snoopRes.status, 403);
    assert.equal(snoopRes.body.code, 'UNAUTHORIZED_ACCOUNT_ACCESS');
  });

  test('Unauthenticated calls to protected routes are rejected with 401', async () => {
    const res = await request(app)
      .get('/api/accounts');

    assert.equal(res.status, 401);
  });
});
