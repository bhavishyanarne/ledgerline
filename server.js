const app = require('./src/app');
const config = require('./src/config');
const { getDb, initDb, closeDb } = require('./src/db');
const { seedDatabase } = require('./src/db/seed');

// Initialize database schema
const db = getDb();
initDb(db);

// Automatically seed if database is brand new (zero users)
const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get();
if (userCount.count === 0) {
  console.log('Database empty. Running initial seed...');
  seedDatabase(db);
}

const server = app.listen(config.PORT, () => {
  console.log(`=======================================================`);
  console.log(`  LedgerLine — Money Movement with a Ledger You Can Prove`);
  console.log(`  Server listening on port http://localhost:${config.PORT}`);
  console.log(`  Environment: ${config.NODE_ENV}`);
  console.log(`  Database: ${config.DB_PATH}`);
  console.log(`=======================================================`);
});

// Graceful shutdown handling
function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}. Gracefully shutting down LedgerLine...`);
  server.close(() => {
    console.log('HTTP server closed.');
    closeDb();
    console.log('Database connection closed.');
    process.exit(0);
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

module.exports = server;
