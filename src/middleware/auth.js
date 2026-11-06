const { verifyToken, verifyAccountAuthorization, AuthError } = require('../services/authService');
const { logRefusedAttempt } = require('../services/ledgerService');

/**
 * Middleware: Verifies the JWT Bearer token and attaches user to request.
 */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({
      error: 'Authentication required: Missing Authorization header',
      code: 'AUTH_REQUIRED'
    });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({
      error: 'Invalid Authorization header format. Expected Bearer <token>',
      code: 'INVALID_AUTH_HEADER'
    });
  }

  try {
    const decoded = verifyToken(parts[1]);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      error: err.message || 'Invalid or expired token',
      code: err.code || 'TOKEN_INVALID'
    });
  }
}

/**
 * Middleware: Enforces that the authenticated user possesses one of the allowed roles.
 */
function requireRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthenticated', code: 'UNAUTHENTICATED' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Forbidden: User role '${req.user.role}' is not authorized. Required: ${allowedRoles.join(', ')}`,
        code: 'FORBIDDEN_ROLE'
      });
    }

    next();
  };
}

/**
 * Middleware: Enforces account-level authorization for reading or writing.
 * 
 * If a write operation is rejected, logs a refused attempt into the immutable audit table.
 */
function requireAccountPermission(accountIdExtractor, permission = 'READ') {
  return (req, res, next) => {
    const accountId = typeof accountIdExtractor === 'function' 
      ? accountIdExtractor(req) 
      : (req.params[accountIdExtractor] || req.body[accountIdExtractor]);

    if (!accountId) {
      return res.status(400).json({
        error: 'Missing account identifier in request',
        code: 'MISSING_ACCOUNT_ID'
      });
    }

    try {
      const { account } = verifyAccountAuthorization(req.user, accountId, permission);
      req.targetAccount = account;
      next();
    } catch (err) {
      // If unauthorized attempt to write / move money, log refusal
      if (permission === 'WRITE') {
        const attemptedAmount = req.body.amount || 0;
        const idempotencyKey = req.headers['idempotency-key'] || req.body.idempotencyKey || null;

        logRefusedAttempt({
          accountId,
          action: req.body.type || (req.path.includes('withdraw') ? 'WITHDRAWAL' : 'TRANSFER'),
          amount: attemptedAmount,
          reason: `UNAUTHORIZED_ACCOUNT_ACCESS: User ${req.user.name} (${req.user.email}, ${req.user.role}) attempted unauthorized movement`,
          initiatorId: req.user.userId,
          idempotencyKey
        });
      }

      return res.status(err.statusCode || 403).json({
        error: err.message,
        code: err.code || 'FORBIDDEN'
      });
    }
  };
}

module.exports = {
  authenticateToken,
  requireRoles,
  requireAccountPermission
};
