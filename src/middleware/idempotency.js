const {
  acquireOrCheckKey,
  completeKey,
  releaseInProgressKey,
  IdempotencyError
} = require('../services/idempotencyService');

/**
 * Middleware: Enforces client-supplied idempotency key for money movements.
 * Prevents double-spend on network timeouts, replayed requests, or double-clicks.
 */
function requireIdempotency(req, res, next) {
  const key = req.headers['idempotency-key'] || 
              req.headers['x-idempotency-key'] || 
              req.body.idempotencyKey;

  if (!key) {
    return res.status(400).json({
      error: 'Missing required Idempotency-Key header or property. Money-moving endpoints require an idempotency key',
      code: 'MISSING_IDEMPOTENCY_KEY'
    });
  }

  const userId = req.user ? req.user.userId : 'anonymous';
  const endpoint = `${req.method} ${req.baseUrl}${req.path}`;
  const payload = req.body;

  try {
    const result = acquireOrCheckKey(key, userId, endpoint, payload);

    if (result.isDuplicate) {
      res.setHeader('Idempotent-Replayed', 'true');
      res.setHeader('X-Idempotency-Key', key);
      return res.status(result.statusCode).json(result.responseBody);
    }

    req.idempotencyKey = key;

    // Intercept response to store result upon completion
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const statusCode = res.statusCode || 200;
      const transactionId = body && body.transactionId ? body.transactionId : null;
      completeKey(key, statusCode, body, transactionId);
      res.setHeader('X-Idempotency-Key', key);
      return originalJson(body);
    };

    next();
  } catch (err) {
    if (err instanceof IdempotencyError) {
      return res.status(err.statusCode).json({
        error: err.message,
        code: err.code,
        details: err.details
      });
    }

    releaseInProgressKey(key);
    return res.status(500).json({
      error: 'Idempotency processing failure',
      code: 'IDEMPOTENCY_INTERNAL_ERROR'
    });
  }
}

module.exports = {
  requireIdempotency
};
