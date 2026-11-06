const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const dotenv = require('dotenv');

dotenv.config();

const DIGEST_QUEUE_NAME = 'nightly_digest_queue';
const DIGEST_DLQ_NAME = 'nightly_digest_dlq';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

function createRedisConnection() {
  const client = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy(times) {
      return Math.min(times * 200, 2000);
    },
  });

  client.on('error', (err) => {
    // Avoid crashing on connection hiccups
    console.error('[Redis Client Error]:', err.message);
  });

  return client;
}

const queueRedisClient = createRedisConnection();
const dlqRedisClient = createRedisConnection();

const digestQueue = new Queue(DIGEST_QUEUE_NAME, {
  connection: queueRedisClient,
  defaultJobOptions: {
    attempts: 1, // Deterministic single execution for fatal injected failure assignment requirements
    removeOnComplete: false,
    removeOnFail: false,
  },
});

const digestDlq = new Queue(DIGEST_DLQ_NAME, {
  connection: dlqRedisClient,
  defaultJobOptions: {
    removeOnComplete: false,
    removeOnFail: false,
  },
});

/**
 * Enqueue a nightly digest job into the primary processing queue.
 */
async function enqueueDigestJob(payload) {
  if (!payload || !payload.jobId) {
    throw new Error('Payload must include a valid jobId');
  }

  console.log(`[Queue] Enqueueing job ${payload.jobId} to ${DIGEST_QUEUE_NAME} (simulate_failure: ${Boolean(payload.simulate_failure)})`);

  const job = await digestQueue.add('process_digest', payload, {
    jobId: payload.jobId,
    attempts: 1,
  });

  console.log(`[Queue] Successfully enqueued job ${payload.jobId} with BullMQ ID: ${job.id}`);
  return job;
}

/**
 * Enqueue a failed job into the separate Dead-Letter Queue (DLQ).
 */
async function enqueueDlqJob(payload) {
  if (!payload || !payload.jobId) {
    throw new Error('DLQ payload must include a valid jobId');
  }

  console.log(`[Queue] Routing failed job ${payload.jobId} to Dead-Letter Queue ${DIGEST_DLQ_NAME}`);

  const job = await digestDlq.add('dead_letter_digest', payload, {
    jobId: `dlq-${payload.jobId}`,
  });

  console.log(`[Queue] Successfully recorded in DLQ: ${job.id}`);
  return job;
}

/**
 * Gracefully close queue connections.
 */
async function closeQueues() {
  console.log('[Queue] Closing queue connections...');
  try {
    await digestQueue.close();
    await digestDlq.close();
    await queueRedisClient.quit();
    await dlqRedisClient.quit();
    console.log('[Queue] Queues and Redis connections closed successfully.');
  } catch (err) {
    console.error('[Queue Error during close]:', err.message);
  }
}

module.exports = {
  DIGEST_QUEUE_NAME,
  DIGEST_DLQ_NAME,
  createRedisConnection,
  digestQueue,
  digestDlq,
  enqueueDigestJob,
  enqueueDlqJob,
  closeQueues,
};
