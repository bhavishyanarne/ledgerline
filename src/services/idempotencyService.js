const crypto = require('node:crypto');
const { getDb } = require('../db');

class IdempotencyError extends Error {
  constructor(message, code, statusCode = 400, details = {}) {
    super(message);
    this.name = 'IdempotencyError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

/**
 * Computes deterministic hash of request parameters.
 */
function hashPayload(payload) {
  const normalized = JSON.stringify(payload, Object.keys(payload).sort());
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Initiates idempotency check.
 * Guarantees atomic reservation of key.
 * 
 * Returns:
 * - { isNew: true } if caller has acquired the lock to process
 * - { isNew: false, statusCode, responseBody, isDuplicate: true } if already completed
 * 
 * Throws:
 * - 409 Conflict if request is currently IN_PROGRESS (concurrent retry)
 * - 422 Unprocessable Entity if key was previously used with different parameters
 */
function acquireOrCheckKey(key, userId, endpoint, payload) {
  const db = getDb();
  const requestHash = hashPayload(payload);
  const now = new Date().toISOString();

  // Check if key already exists
  const existing = db.prepare('SELECT * FROM idempotency_keys WHERE key = ?').get(key);

  if (existing) {
    // 1. Verify payload match
    if (existing.request_hash !== requestHash) {
      throw new IdempotencyError(
        'Idempotency key payload mismatch: This key was previously submitted with different parameters',
        'IDEMPOTENCY_PAYLOAD_MISMATCH',
        422,
        { key }
      );
    }

    // 2. Check in-flight status
    if (existing.status === 'IN_PROGRESS') {
      throw new IdempotencyError(
        'A request with this idempotency key is currently processing. Please wait before retrying',
        'IDEMPOTENCY_IN_FLIGHT',
        409,
        { key }
      );
    }

    // 3. Return cached response
    let parsedBody = {};
    try {
      parsedBody = JSON.parse(existing.response_body);
    } catch (e) {
      parsedBody = { raw: existing.response_body };
    }

    return {
      isNew: false,
      isDuplicate: true,
      statusCode: existing.response_code || 200,
      responseBody: {
        ...parsedBody,
        idempotentReplay: true,
        replayedAt: now,
        originalCreatedAt: existing.created_at
      }
    };
  }

  // Key does not exist: attempt atomic insert
  try {
    db.prepare(`
      INSERT INTO idempotency_keys (
        key, user_id, endpoint, request_hash, status, created_at
      ) VALUES (?, ?, ?, ?, 'IN_PROGRESS', ?)
    `).run(key, userId, endpoint, requestHash, now);

    return { isNew: true, isDuplicate: false };
  } catch (err) {
    // If another thread raced and inserted between SELECT and INSERT
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return acquireOrCheckKey(key, userId, endpoint, payload);
    }
    throw err;
  }
}

/**
 * Commits the cached response for an idempotency key.
 */
function completeKey(key, statusCode, responseBody, transactionId = null) {
  const db = getDb();
  const now = new Date().toISOString();
  const status = statusCode >= 400 ? 'REFUSED' : 'COMPLETED';

  db.prepare(`
    UPDATE idempotency_keys
    SET 
      status = ?,
      response_code = ?,
      response_body = ?,
      transaction_id = ?,
      completed_at = ?
    WHERE key = ?
  `).run(status, statusCode, JSON.stringify(responseBody), transactionId, now, key);
}

/**
 * Releases/cleans up an in-progress key on unexpected system crash.
 */
function releaseInProgressKey(key) {
  try {
    const db = getDb();
    db.prepare(`
      DELETE FROM idempotency_keys WHERE key = ? AND status = 'IN_PROGRESS'
    `).run(key);
  } catch (e) {
    // ignore
  }
}

/**
 * Lists idempotency records for audit review.
 */
function listIdempotencyRecords(limit = 50) {
  const db = getDb();
  return db.prepare(`
    SELECT 
      ik.key,
      ik.user_id,
      u.name AS user_name,
      u.email AS user_email,
      ik.endpoint,
      ik.status,
      ik.response_code,
      ik.transaction_id,
      ik.created_at,
      ik.completed_at
    FROM idempotency_keys ik
    LEFT JOIN users u ON ik.user_id = u.id
    ORDER BY ik.created_at DESC
    LIMIT ?
  `).all(limit);
}

module.exports = {
  IdempotencyError,
  hashPayload,
  acquireOrCheckKey,
  completeKey,
  releaseInProgressKey,
  listIdempotencyRecords
};
