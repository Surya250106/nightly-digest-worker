const { pool, appendJobActivityLog } = require('../db/pool');
const { enqueueDlqJob } = require('../queue/queues');

const SIMULATED_PROCESSING_DELAY_MS = 2000;

/**
 * Worker processor handling the complete lifecycle of a nightly digest job.
 * 
 * Successful Lifecycle:
 * pending -> started -> (2000ms delay) -> success
 * 
 * Injected Failure Lifecycle:
 * pending -> started -> (deterministic error) -> failed -> (enqueue DLQ) -> dead_letter
 */
async function processJob(job) {
  if (!job || !job.data || !job.data.jobId) {
    throw new Error('Invalid job: Missing job.data or jobId');
  }

  const { jobId, simulate_failure } = job.data;
  const startTime = Date.now();

  console.log(`[Worker] Starting processing for job: ${jobId} (simulate_failure: ${Boolean(simulate_failure)})`);

  // Idempotency check: avoid duplicate execution for already terminal jobs
  const jobCheck = await pool.query('SELECT current_state FROM jobs WHERE id = $1', [jobId]);
  if (jobCheck.rowCount > 0) {
    const currentState = jobCheck.rows[0].current_state;
    if (currentState === 'success' || currentState === 'dead_letter') {
      console.warn(`[Worker] Job ${jobId} already in terminal state '${currentState}'. Skipping re-execution.`);
      return { jobId, status: currentState, skipped: true };
    }
  }

  // 1. Transition to 'started'
  await appendJobActivityLog(jobId, 'started', 'Digest processing started');
  console.log(`[Worker] Job ${jobId} transitioned to 'started'`);

  // 2. Injected failure path
  if (simulate_failure) {
    try {
      // Deterministic fatal error simulation
      throw new Error('Injected failure encountered during digest generation');
    } catch (injectedError) {
      console.error(`[Worker] Job ${jobId} encountered fatal failure: ${injectedError.message}`);

      // Append 'failed' state preserving the exact error message
      await appendJobActivityLog(jobId, 'failed', injectedError.message);
      console.log(`[Worker] Job ${jobId} transitioned to 'failed'`);

      // Enqueue to Dead-Letter Queue (DLQ)
      try {
        await enqueueDlqJob({
          jobId,
          originalPayload: job.data,
          error: injectedError.message,
          failedAt: new Date().toISOString(),
        });
        console.log(`[Worker] Job ${jobId} successfully routed to DLQ`);
      } catch (dlqError) {
        console.error(`[Worker] Failed to enqueue job ${jobId} to DLQ:`, dlqError.message);
        // Do not claim dead_letter if DLQ enqueue failed
        throw dlqError;
      }

      // Append 'dead_letter' state after DLQ enqueue succeeds
      await appendJobActivityLog(jobId, 'dead_letter', 'Job routed to dead-letter queue');
      console.log(`[Worker] Job ${jobId} transitioned to 'dead_letter'`);

      return {
        jobId,
        status: 'dead_letter',
        durationMs: Date.now() - startTime,
        error: injectedError.message,
      };
    }
  }

  // 3. Successful job path: simulate digest generation with ~2000 ms delay
  console.log(`[Worker] Simulating digest generation (~${SIMULATED_PROCESSING_DELAY_MS}ms) for job ${jobId}...`);
  await new Promise((resolve) => setTimeout(resolve, SIMULATED_PROCESSING_DELAY_MS));

  // Append 'success' state
  await appendJobActivityLog(jobId, 'success', 'Digest generation completed successfully');
  const duration = Date.now() - startTime;
  console.log(`[Worker] Job ${jobId} completed successfully in ${duration}ms`);

  return {
    jobId,
    status: 'success',
    durationMs: duration,
  };
}

module.exports = {
  processJob,
  SIMULATED_PROCESSING_DELAY_MS,
};
