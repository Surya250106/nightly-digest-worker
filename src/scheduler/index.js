const cron = require('node-cron');
const crypto = require('crypto');
const dotenv = require('dotenv');
const { createJobWithPendingLog, pool } = require('../db/pool');
const { enqueueDigestJob, closeQueues } = require('../queue/queues');
const { runMigrations } = require('../db/migrate');

dotenv.config();

let scheduledTask = null;

/**
 * Triggers a scheduled nightly digest job:
 * 1. Inserts job into PostgreSQL with 'pending' state
 * 2. Enqueues the job into BullMQ primary digest queue
 */
async function triggerScheduledDigest() {
  const jobId = crypto.randomUUID();
  console.log(`[Scheduler] Firing scheduled trigger for job ${jobId} at ${new Date().toISOString()}`);

  try {
    const payload = {
      jobId,
      type: 'nightly_digest',
      simulate_failure: false,
      triggered_by: 'scheduler',
      scheduled_at: new Date().toISOString(),
    };

    // Atomic DB record creation with initial 'pending' log
    await createJobWithPendingLog({
      id: jobId,
      name: 'nightly_digest',
      payload,
      message: 'Job created via scheduled trigger',
    });

    // Enqueue to shared BullMQ queue
    await enqueueDigestJob(payload);

    console.log(`[Scheduler] Successfully created and enqueued scheduled job: ${jobId}`);
    return jobId;
  } catch (err) {
    console.error(`[Scheduler Error] Failed to create or enqueue scheduled job ${jobId}:`, err.message);
    throw err;
  }
}

/**
 * Initializes and starts the cron scheduler.
 */
async function startScheduler(customSchedule = null, customTz = null) {
  const schedule = customSchedule || process.env.CRON_SCHEDULE || '0 0 * * *';
  const timezone = customTz || process.env.TZ || 'UTC';

  console.log('[Scheduler Service] Starting scheduler...');
  console.log(`[Scheduler Service] Configured CRON_SCHEDULE: "${schedule}"`);
  console.log(`[Scheduler Service] Configured Timezone (TZ): "${timezone}"`);

  if (!cron.validate(schedule)) {
    throw new Error(`Invalid cron expression: "${schedule}"`);
  }

  // Ensure database migrations are run
  try {
    await runMigrations();
  } catch (err) {
    console.error('[Scheduler Service] Database migration check failed:', err.message);
    process.exit(1);
  }

  scheduledTask = cron.schedule(
    schedule,
    async () => {
      try {
        await triggerScheduledDigest();
      } catch (err) {
        console.error('[Scheduler Task Error]:', err.message);
      }
    },
    {
      timezone,
    }
  );

  console.log('[Scheduler Service] Scheduler running and waiting for next scheduled run.');
  return scheduledTask;
}

async function shutdown(signal) {
  console.log(`[Scheduler Service] Received ${signal}, shutting down...`);
  if (scheduledTask) {
    scheduledTask.stop();
  }
  await closeQueues();
  await pool.end();
  console.log('[Scheduler Service] Scheduler shut down cleanly.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
  startScheduler().catch((err) => {
    console.error('[Scheduler Service Startup Error]:', err);
    process.exit(1);
  });
}

module.exports = {
  triggerScheduledDigest,
  startScheduler,
  shutdown,
};
