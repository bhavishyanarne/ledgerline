const path = require('node:path');
require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  DB_PATH: process.env.DB_PATH || path.join(__dirname, '../data/ledger.db'),
  JWT_SECRET: process.env.JWT_SECRET || 'ledgerline-secret-key-production-grade-2026',
  JWT_EXPIRES_IN: '24h',
  SYSTEM_ACCOUNT_ID: 'acc_system_clearing',
  SYSTEM_USER_ID: 'usr_system',
  ROLES: {
    ADMIN: 'ADMIN',
    ACCOUNT_HOLDER: 'ACCOUNT_HOLDER',
    AUDITOR: 'AUDITOR'
  }
};
