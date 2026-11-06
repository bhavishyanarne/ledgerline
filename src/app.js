const express = require('express');
const cors = require('cors');
const path = require('node:path');

const authRoutes = require('./routes/authRoutes');
const accountRoutes = require('./routes/accountRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const reconciliationRoutes = require('./routes/reconciliationRoutes');
const auditRoutes = require('./routes/auditRoutes');

const app = express();

app.use(cors());
app.use(express.json());

// Serve static frontend assets
app.use(express.static(path.join(__dirname, '../public')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/reconciliation', reconciliationRoutes);
app.use('/api/audit', auditRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'UP', service: 'LedgerLine Core', timestamp: new Date().toISOString() });
});

// Fallback to index.html for single-page app
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Centralized JSON Error Handler
app.use((err, req, res, next) => {
  console.error('[LedgerLine Error]:', err.message);
  const status = err.statusCode || 500;
  res.status(status).json({
    error: err.message || 'Internal Server Error',
    code: err.code || 'INTERNAL_ERROR',
    details: err.details || null
  });
});

module.exports = app;
