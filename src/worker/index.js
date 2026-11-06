const { Worker } = require('bullmq');
const { DIGEST_QUEUE_NAME, createRedisConnection, closeQueues } = require('../queue/queues');
const { processJob } = require('./processor');
const { runMigrations } = require('../db/migrate');
const { pool } = require('../db/pool');

let worker = null;
let redisClient = null;

async function startWorker() {
  console.log('[Worker Service] Initializing worker service...');

  // Ensure database schema is ready before consuming jobs
  try {
    await runMigrations();
  } catch (err) {
    console.error('[Worker Service] Database migration check failed:', err.message);
    process.exit(1);
  }

  redisClient = createRedisConnection();

  worker = new Worker(DIGEST_QUEUE_NAME, processJob, {
    connection: redisClient,
    concurrency: 5,
  });

  worker.on('ready', () => {
    console.log(`[Worker Service] Worker active and listening on queue: ${DIGEST_QUEUE_NAME}`);
  });

  worker.on('active', (job) => {
    console.log(`[Worker Service] Job ${job.id} (JobId: ${job.data.jobId}) is now active`);
  });

  worker.on('completed', (job, returnvalue) => {
    console.log(`[Worker Service] Job ${job.id} completed with status: ${returnvalue?.status}`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[Worker Service] Job ${job?.id} failed with error: ${err.message}`);
  });

  worker.on('error', (err) => {
    console.error('[Worker Service Error]:', err.message);
  });
}

async function shutdown(signal) {
  console.log(`[Worker Service] Received ${signal}, shutting down gracefully...`);
  try {
    if (worker) {
      await worker.close();
    }
    if (redisClient) {
      await redisClient.quit();
    }
    await closeQueues();
    await pool.end();
    console.log('[Worker Service] Graceful shutdown completed.');
    process.exit(0);
  } catch (err) {
    console.error('[Worker Service] Error during shutdown:', err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
  startWorker().catch((err) => {
    console.error('[Worker Service Startup Error]:', err);
    process.exit(1);
  });
}

module.exports = {
  startWorker,
  shutdown,
};
