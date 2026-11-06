const express = require('express');
const crypto = require('crypto');
const { createJobWithPendingLog, appendJobActivityLog, getJobWithLogs } = require('../../db/pool');
const { enqueueDigestJob } = require('../../queue/queues');

const router = express.Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * POST /api/jobs/trigger
 * Triggers a nightly digest job asynchronously.
 */
router.post('/trigger', async (req, res) => {
  const body = req.body;

  // Validate body presence
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({
      error: 'Invalid request body. Expected a JSON object.',
    });
  }

  // Validate type
  if (body.type !== 'nightly_digest') {
    return res.status(400).json({
      error: "Invalid or missing job type. Must be 'nightly_digest'.",
    });
  }

  // Validate simulate_failure if provided
  let simulateFailure = false;
  if ('simulate_failure' in body) {
    if (typeof body.simulate_failure !== 'boolean') {
      return res.status(400).json({
        error: "Invalid value for 'simulate_failure'. Must be a boolean (true or false).",
      });
    }
    simulateFailure = body.simulate_failure;
  }

  const jobId = crypto.randomUUID();

  // Create job in PostgreSQL with initial 'pending' activity log
  try {
    await createJobWithPendingLog({
      id: jobId,
      name: 'nightly_digest',
      payload: {
        type: 'nightly_digest',
        simulate_failure: simulateFailure,
        triggered_at: new Date().toISOString(),
      },
      message: 'Job created via API trigger',
    });
  } catch (dbError) {
    console.error(`[API] Failed to persist job ${jobId} in database:`, dbError.message);
    return res.status(500).json({
      error: 'Failed to create job in database',
    });
  }

  // Enqueue job via BullMQ
  try {
    await enqueueDigestJob({
      jobId,
      type: 'nightly_digest',
      simulate_failure: simulateFailure,
      triggered_at: new Date().toISOString(),
    });
  } catch (queueError) {
    console.error(`[API] Failed to enqueue job ${jobId}:`, queueError.message);
    // Mark as failed in DB to prevent leaving it in orphaned pending state
    try {
      await appendJobActivityLog(jobId, 'failed', `Failed to enqueue job: ${queueError.message}`);
    } catch (updateErr) {
      console.error(`[API] Failed to record enqueue failure for ${jobId}:`, updateErr.message);
    }

    return res.status(500).json({
      error: 'Failed to enqueue job for processing',
    });
  }

  // Return HTTP 202 promptly without waiting for the 2000ms processor simulation
  return res.status(202).json({
    job_id: jobId,
    message: 'Job accepted for processing',
  });
});

/**
 * GET /api/jobs/:job_id/logs
 * Retrieves the full activity logs and latest lifecycle state for a given job.
 */
router.get('/:job_id/logs', async (req, res) => {
  const { job_id } = req.params;

  // Validate UUID format
  if (!UUID_REGEX.test(job_id)) {
    return res.status(400).json({
      error: 'Invalid job_id format. Must be a valid UUID.',
    });
  }

  try {
    const jobData = await getJobWithLogs(job_id);

    if (!jobData) {
      return res.status(404).json({
        error: `Job with ID ${job_id} not found`,
      });
    }

    return res.status(200).json(jobData);
  } catch (err) {
    console.error(`[API] Error fetching logs for job ${job_id}:`, err.message);
    return res.status(500).json({
      error: 'Failed to fetch job activity logs',
    });
  }
});

module.exports = router;
