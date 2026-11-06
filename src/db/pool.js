const { Pool } = require('pg');
const dotenv = require('dotenv');
const crypto = require('crypto');

dotenv.config();

const connectionString = process.env.DATABASE_URL;

const poolConfig = connectionString
  ? { connectionString }
  : {
      host: process.env.PGHOST || 'localhost',
      port: parseInt(process.env.PGPORT || '5432', 10),
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || 'postgres',
      database: process.env.PGDATABASE || 'nightly_digest',
    };

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  // Prevent unhandled errors from breaking the process
  console.error('[Database Pool Error]:', err.message);
});

/**
 * Executes a query with error safety and credential protection
 */
async function query(text, params) {
  return pool.query(text, params);
}

/**
 * Creates a job record and its initial 'pending' activity log in a single transaction.
 */
async function createJobWithPendingLog({ id, name, payload, message = 'Job created via API trigger' }) {
  const jobId = id || crypto.randomUUID();
  const logId = crypto.randomUUID();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const jobQuery = `
      INSERT INTO jobs (id, name, payload, current_state, created_at)
      VALUES ($1, $2, $3, 'pending', NOW())
      RETURNING *;
    `;
    const jobRes = await client.query(jobQuery, [jobId, name, JSON.stringify(payload)]);

    const logQuery = `
      INSERT INTO job_activity_logs (id, job_id, state, message, created_at)
      VALUES ($1, $2, 'pending', $3, NOW())
      RETURNING *;
    `;
    const logRes = await client.query(logQuery, [logId, jobId, message]);

    await client.query('COMMIT');

    return {
      job: jobRes.rows[0],
      initialLog: logRes.rows[0],
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Appends a lifecycle state to job_activity_logs and updates jobs.current_state.
 * Runs atomically in a transaction.
 * Protects against duplicate terminal state transitions.
 */
async function appendJobActivityLog(jobId, state, message) {
  const client = await pool.connect();
  const logId = crypto.randomUUID();

  try {
    await client.query('BEGIN');

    // Lock the job row for update to prevent concurrent transition races
    const checkRes = await client.query('SELECT id, current_state FROM jobs WHERE id = $1 FOR UPDATE', [jobId]);
    if (checkRes.rowCount === 0) {
      throw new Error(`Job with id ${jobId} not found`);
    }

    const currentTerminal = checkRes.rows[0].current_state;
    // Prevent duplicate terminal state transitions
    if ((currentTerminal === 'success' || currentTerminal === 'dead_letter') && 
        (state === 'success' || state === 'dead_letter' || state === 'failed')) {
      console.warn(`[DB] Ignoring transition to ${state} for job ${jobId} already in terminal state ${currentTerminal}`);
      await client.query('COMMIT');
      return null;
    }

    // Update job current state
    await client.query(
      'UPDATE jobs SET current_state = $1 WHERE id = $2',
      [state, jobId]
    );

    // Append activity log
    const logRes = await client.query(
      `INSERT INTO job_activity_logs (id, job_id, state, message, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING *;`,
      [logId, jobId, state, message]
    );

    await client.query('COMMIT');
    return logRes.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Retrieves a job and all its activity logs ordered deterministically.
 */
async function getJobWithLogs(jobId) {
  const jobRes = await pool.query('SELECT * FROM jobs WHERE id = $1', [jobId]);
  if (jobRes.rowCount === 0) {
    return null;
  }

  const logsRes = await pool.query(
    'SELECT state, message, created_at FROM job_activity_logs WHERE job_id = $1 ORDER BY created_at ASC, id ASC',
    [jobId]
  );

  const job = jobRes.rows[0];
  const logs = logsRes.rows.map((row) => ({
    state: row.state,
    message: row.message,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  }));

  // Derive current_state from the latest activity log as required
  const derivedState = logs.length > 0 ? logs[logs.length - 1].state : job.current_state;

  return {
    job_id: job.id,
    current_state: derivedState,
    logs,
  };
}

module.exports = {
  pool,
  query,
  createJobWithPendingLog,
  appendJobActivityLog,
  getJobWithLogs,
};
