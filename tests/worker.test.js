const mockCrypto = require('crypto');

// In-memory data store for testing
const mockJobs = new Map();
const mockLogs = new Map();
const mockDlqEntries = [];
let mockDlqEnqueueFail = false;

jest.mock('../src/db/pool', () => {
  const crypto = require('crypto');
  return {
    pool: {
      query: jest.fn(async (text, params) => {
        if (text.includes('SELECT current_state FROM jobs WHERE id = $1')) {
          const job = mockJobs.get(params[0]);
          return { rows: job ? [{ current_state: job.current_state }] : [], rowCount: job ? 1 : 0 };
        }
        return { rows: [], rowCount: 0 };
      }),
      end: jest.fn(async () => {}),
    },
    appendJobActivityLog: jest.fn(async (jobId, state, message) => {
      const job = mockJobs.get(jobId);
      if (!job) {
        throw new Error(`Job ${jobId} not found`);
      }
      // Duplicate terminal transition check
      if ((job.current_state === 'success' || job.current_state === 'dead_letter') &&
          (state === 'success' || state === 'dead_letter' || state === 'failed')) {
        return null;
      }
      job.current_state = state;
      const log = {
        id: crypto.randomUUID(),
        job_id: jobId,
        state,
        message,
        created_at: new Date(),
      };
      if (!mockLogs.has(jobId)) {
        mockLogs.set(jobId, []);
      }
      mockLogs.get(jobId).push(log);
      return log;
    }),
    createJobWithPendingLog: jest.fn(async ({ id, name, payload, message }) => {
      const cryptoMod = require('crypto');
      const jobId = id || cryptoMod.randomUUID();
      const job = {
        id: jobId,
        name,
        payload,
        current_state: 'pending',
        created_at: new Date(),
      };
      mockJobs.set(jobId, job);
      const log = {
        id: cryptoMod.randomUUID(),
        job_id: jobId,
        state: 'pending',
        message: message || 'Job created',
        created_at: new Date(),
      };
      mockLogs.set(jobId, [log]);
      return { job, initialLog: log };
    }),
  };
});

jest.mock('../src/queue/queues', () => {
  return {
    enqueueDigestJob: jest.fn(async (payload) => {
      return { id: `digest-${payload.jobId}`, data: payload };
    }),
    enqueueDlqJob: jest.fn(async (payload) => {
      if (mockDlqEnqueueFail) {
        throw new Error('DLQ Redis connection dropped');
      }
      mockDlqEntries.push(payload);
      return { id: `dlq-${payload.jobId}`, data: payload };
    }),
    closeQueues: jest.fn(async () => {}),
  };
});

jest.mock('../src/db/migrate', () => ({
  runMigrations: jest.fn(async () => true),
}));

const { processJob } = require('../src/worker/processor');
const { triggerScheduledDigest } = require('../src/scheduler/index');
const { enqueueDigestJob } = require('../src/queue/queues');

describe('Worker Processor and Lifecycle Execution Tests', () => {
  beforeEach(() => {
    mockJobs.clear();
    mockLogs.clear();
    mockDlqEntries.length = 0;
    mockDlqEnqueueFail = false;
    jest.clearAllMocks();
  });

  it('should execute exact successful lifecycle: pending -> started -> success with delay', async () => {
    const jobId = mockCrypto.randomUUID();
    // Simulate API job creation
    mockJobs.set(jobId, { id: jobId, current_state: 'pending' });
    mockLogs.set(jobId, [{
      id: mockCrypto.randomUUID(),
      job_id: jobId,
      state: 'pending',
      message: 'Job created via API trigger',
      created_at: new Date(),
    }]);

    const job = {
      id: `bull-${jobId}`,
      data: {
        jobId,
        type: 'nightly_digest',
        simulate_failure: false,
      },
    };

    const start = Date.now();
    const result = await processJob(job);
    const duration = Date.now() - start;

    expect(result.status).toBe('success');
    // Processing includes ~2000 ms simulated delay
    expect(duration).toBeGreaterThanOrEqual(1900);

    const logs = mockLogs.get(jobId);
    expect(logs).toHaveLength(3);
    expect(logs[0].state).toBe('pending');
    expect(logs[1].state).toBe('started');
    expect(logs[2].state).toBe('success');

    const jobRecord = mockJobs.get(jobId);
    expect(jobRecord.current_state).toBe('success');
  }, 10000);

  it('should execute exact injected-failure lifecycle: pending -> started -> failed -> dead_letter', async () => {
    const jobId = mockCrypto.randomUUID();
    // Simulate API job creation
    mockJobs.set(jobId, { id: jobId, current_state: 'pending' });
    mockLogs.set(jobId, [{
      id: mockCrypto.randomUUID(),
      job_id: jobId,
      state: 'pending',
      message: 'Job created via API trigger',
      created_at: new Date(),
    }]);

    const job = {
      id: `bull-${jobId}`,
      data: {
        jobId,
        type: 'nightly_digest',
        simulate_failure: true,
      },
    };

    const result = await processJob(job);

    expect(result.status).toBe('dead_letter');
    expect(result.error).toBe('Injected failure encountered during digest generation');

    const logs = mockLogs.get(jobId);
    expect(logs).toHaveLength(4);
    expect(logs.map((l) => l.state)).toEqual(['pending', 'started', 'failed', 'dead_letter']);

    // Check that failure message is preserved in failed activity log
    const failedLog = logs.find((l) => l.state === 'failed');
    expect(failedLog.message).toBe('Injected failure encountered during digest generation');

    // Check that DLQ entry was actually created with payload and error context
    expect(mockDlqEntries).toHaveLength(1);
    expect(mockDlqEntries[0].jobId).toBe(jobId);
    expect(mockDlqEntries[0].error).toBe('Injected failure encountered during digest generation');
    expect(mockDlqEntries[0].originalPayload).toEqual(job.data);

    // Check final state on jobs table
    const jobRecord = mockJobs.get(jobId);
    expect(jobRecord.current_state).toBe('dead_letter');
  });

  it('should not mark job as dead_letter if DLQ enqueue fails', async () => {
    mockDlqEnqueueFail = true;
    const jobId = mockCrypto.randomUUID();
    mockJobs.set(jobId, { id: jobId, current_state: 'pending' });
    mockLogs.set(jobId, [{
      id: mockCrypto.randomUUID(),
      job_id: jobId,
      state: 'pending',
      message: 'Job created via API trigger',
      created_at: new Date(),
    }]);

    const job = {
      id: `bull-${jobId}`,
      data: {
        jobId,
        type: 'nightly_digest',
        simulate_failure: true,
      },
    };

    await expect(processJob(job)).rejects.toThrow('DLQ Redis connection dropped');

    const logs = mockLogs.get(jobId);
    // Should have pending, started, failed, but NOT dead_letter
    expect(logs.map((l) => l.state)).toEqual(['pending', 'started', 'failed']);
    const jobRecord = mockJobs.get(jobId);
    expect(jobRecord.current_state).toBe('failed');
  });

  it('should ignore duplicate execution if job is already in a terminal state', async () => {
    const jobId = mockCrypto.randomUUID();
    mockJobs.set(jobId, { id: jobId, current_state: 'success' });
    mockLogs.set(jobId, [
      { id: '1', job_id: jobId, state: 'pending', created_at: new Date() },
      { id: '2', job_id: jobId, state: 'started', created_at: new Date() },
      { id: '3', job_id: jobId, state: 'success', created_at: new Date() },
    ]);

    const job = {
      id: `bull-${jobId}`,
      data: {
        jobId,
        type: 'nightly_digest',
        simulate_failure: false,
      },
    };

    const result = await processJob(job);
    expect(result.skipped).toBe(true);
    expect(result.status).toBe('success');

    // Verify no new activity logs were appended
    expect(mockLogs.get(jobId)).toHaveLength(3);
  });

  it('should verify scheduler creates DB record and enqueues using shared queue', async () => {
    const scheduledJobId = await triggerScheduledDigest();

    expect(scheduledJobId).toBeDefined();
    const jobRecord = mockJobs.get(scheduledJobId);
    expect(jobRecord).toBeDefined();
    expect(jobRecord.current_state).toBe('pending');
    expect(jobRecord.payload.triggered_by).toBe('scheduler');

    const logs = mockLogs.get(scheduledJobId);
    expect(logs).toHaveLength(1);
    expect(logs[0].state).toBe('pending');
    expect(logs[0].message).toBe('Job created via scheduled trigger');

    expect(enqueueDigestJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: scheduledJobId,
        type: 'nightly_digest',
        simulate_failure: false,
        triggered_by: 'scheduler',
      })
    );
  });
});
