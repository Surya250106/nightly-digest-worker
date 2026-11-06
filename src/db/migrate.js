const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');

const MIGRATION_LOCK_ID = 987654321;

/**
 * Executes database migrations idempotently with advisory locking to avoid startup race conditions.
 */
async function runMigrations(maxRetries = 15, retryDelayMs = 2000) {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  let retries = 0;
  while (retries < maxRetries) {
    let client;
    try {
      console.log(`[Migration] Connecting to database (attempt ${retries + 1}/${maxRetries})...`);
      client = await pool.connect();

      console.log('[Migration] Acquiring PostgreSQL advisory lock for migration...');
      await client.query('SELECT pg_advisory_lock($1);', [MIGRATION_LOCK_ID]);

      try {
        console.log('[Migration] Applying schema definitions...');
        await client.query('BEGIN');
        await client.query(schemaSql);
        await client.query('COMMIT');
        console.log('[Migration] Database schema initialized successfully.');
        return true;
      } finally {
        await client.query('SELECT pg_advisory_unlock($1);', [MIGRATION_LOCK_ID]);
      }
    } catch (err) {
      retries++;
      console.warn(`[Migration] Database connection or migration attempt failed: ${err.message}`);
      if (retries >= maxRetries) {
        console.error('[Migration] Exceeded maximum retries for database migration.');
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    } finally {
      if (client) {
        client.release();
      }
    }
  }
}

// Allow direct execution: node src/db/migrate.js
if (require.main === module) {
  runMigrations()
    .then(() => {
      console.log('[Migration] Standalone migration completed.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Migration Error]:', err);
      process.exit(1);
    });
}

module.exports = {
  runMigrations,
};
