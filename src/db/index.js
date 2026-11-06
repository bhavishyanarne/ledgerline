const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

let dbInstance = null;

/**
 * Initializes and returns the SQLite database connection.
 * Configured with Write-Ahead Logging (WAL) and strict foreign keys.
 * 
 * @param {string} [customPath] - Path to the database file (or ':memory:')
 * @returns {DatabaseSync}
 */
function getDb(customPath) {
  if (dbInstance && !customPath) {
    return dbInstance;
  }

  const dbPath = customPath || config.DB_PATH;

  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new DatabaseSync(dbPath);

  // Enable WAL mode for high concurrency: readers never block writers, writers never block readers
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  if (!customPath) {
    dbInstance = db;
  }

  return db;
}

/**
 * Executes schema migration SQL to create tables, indexes, and triggers.
 * @param {DatabaseSync} [db]
 */
function initDb(db) {
  const targetDb = db || getDb();
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  targetDb.exec(schemaSql);
  return targetDb;
}

/**
 * Executes a function within an ACID transaction with BEGIN IMMEDIATE.
 * Guarantees serializability and eliminates race conditions.
 * Rolls back automatically if any exception is thrown.
 * 
 * @template T
 * @param {Function} fn - Work to execute within the transaction
 * @param {DatabaseSync} [db]
 * @returns {T}
 */
function transaction(fn, db) {
  const targetDb = db || getDb();
  targetDb.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(targetDb);
    targetDb.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      targetDb.exec('ROLLBACK');
    } catch (rollbackErr) {
      // Rollback might fail if connection was closed or already rolled back
    }
    throw error;
  }
}

/**
 * Closes the active database connection (useful for testing and graceful shutdown).
 */
function closeDb() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (e) {
      // ignore
    }
    dbInstance = null;
  }
}

module.exports = {
  getDb,
  initDb,
  transaction,
  closeDb
};
