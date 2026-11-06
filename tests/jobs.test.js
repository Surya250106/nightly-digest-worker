const request = require('supertest');
const fs = require('fs');
const path = require('path');
const mockCrypto = require('crypto');

// Mock dependencies for deterministic unit testing
const mockJobs = new Map();
const mockLogs = new Map();
let mockDbHealthy = true;
let mockRedisHealthy = true;
let mockEnqueueFail = false;

jest.mock('../src/db/pool', () => {
  const crypto = require('crypto');
  return {
    pool: {
      query: jest.fn(async (text, params) => {
        if (!mockDbHealthy) {
          throw new Error('Database connection failed');
        }
        return { rows: [{ result: 1 }], rowCount: 1 };
      }),
      end: jest.fn(async () => {}),
    },
    query: jest.fn(async (text, params) => {
      if (!mockDbHealthy) {
        throw new Error('Database connection failed');
      }
      return { rows: [{ result: 1 }], rowCount: 1 };
    }),
    createJobWithPendingLog: jest.fn(async ({ id, name, payload, message }) => {
      if (!mockDbHealthy) {
        throw new Error('Database connection failed');
      }
      const jobId = id || crypto.randomUUID();
      const job = {
        id: jobId,
        name,
        payload,
        current_state: 'pending',
        created_at: new Date(),
      };
      mockJobs.set(jobId, job);

      const log = {
        id: crypto.randomUUID(),
        job_id: jobId,
        state: 'pending',
        message: message || 'Job created via API trigger',
        created_at: new Date(),
      };
      if (!mockLogs.has(jobId)) {
        mockLogs.set(jobId, []);
      }
      mockLogs.get(jobId).push(log);

      return { job, initialLog: log };
    }),
    appendJobActivityLog: jest.fn(async (jobId, state, message) => {
      const job = mockJobs.get(jobId);
      if (!job) {
        throw new Error(`Job with id ${jobId} not found`);
      }
      // Check for duplicate terminal state
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
      mockLogs.get(jobId).push(log);
      return log;
    }),
    getJobWithLogs: jest.fn(async (jobId) => {
      const job = mockJobs.get(jobId);
      if (!job) {
        return null;
      }
      const logs = (mockLogs.get(jobId) || []).map((l) => ({
        state: l.state,
        message: l.message,
        created_at: l.created_at.toISOString(),
      }));
      const currentState = logs.length > 0 ? logs[logs.length - 1].state : job.current_state;
      return {
        job_id: job.id,
        current_state: currentState,
        logs,
      };
    }),
  };
});

jest.mock('../src/queue/queues', () => {
  return {
    createRedisConnection: jest.fn(() => ({
      ping: jest.fn(async () => {
        if (!mockRedisHealthy) {
          throw new Error('Redis connection failed');
        }
        return 'PONG';
      }),
      quit: jest.fn(async () => {}),
      on: jest.fn(),
    })),
    enqueueDigestJob: jest.fn(async (payload) => {
      if (mockEnqueueFail) {
        throw new Error('Redis queue connection refused');
      }
      return { id: `bullmq-${payload.jobId}` };
    }),
    closeQueues: jest.fn(async () => {}),
  };
});

jest.mock('../src/db/migrate', () => ({
  runMigrations: jest.fn(async () => true),
}));

const { app } = require('../src/api/server');

describe('API Endpoints and Behavior Tests', () => {
  beforeEach(() => {
    mockJobs.clear();
    mockLogs.clear();
    mockDbHealthy = true;
    mockRedisHealthy = true;
    mockEnqueueFail = false;
  });

  describe('GET /health', () => {
    it('should return HTTP 200 when database and Redis are healthy', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('healthy');
      expect(res.body.services.database).toBe('connected');
      expect(res.body.services.redis).toBe('connected');
    });

    it('should return HTTP 503 when database is unhealthy', async () => {
      mockDbHealthy = false;
      const res = await request(app).get('/health');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unhealthy');
      expect(res.body.services.database).toBe('error');
    });

    it('should return HTTP 503 when Redis is unhealthy', async () => {
      mockRedisHealthy = false;
      const res = await request(app).get('/health');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unhealthy');
      expect(res.body.services.redis).toBe('error');
    });
  });

  describe('POST /api/jobs/trigger', () => {
    it('should reject invalid or missing type with HTTP 400', async () => {
      const res1 = await request(app)
        .post('/api/jobs/trigger')
        .send({ type: 'invalid_type' });
      expect(res1.status).toBe(400);
      expect(res1.body.error).toContain("Must be 'nightly_digest'");

      const res2 = await request(app)
        .post('/api/jobs/trigger')
        .send({});
      expect(res2.status).toBe(400);
    });

    it('should reject invalid simulate_failure value with HTTP 400', async () => {
      const res = await request(app)
        .post('/api/jobs/trigger')
        .send({ type: 'nightly_digest', simulate_failure: 'not_a_boolean' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Must be a boolean");
    });

    it('should accept valid trigger request, return HTTP 202 promptly, and create pending state', async () => {
      const start = Date.now();
      const res = await request(app)
        .post('/api/jobs/trigger')
        .send({ type: 'nightly_digest', simulate_failure: false });
      const elapsed = Date.now() - start;

      // Verify prompt response (well under 500ms, not waiting for 2000ms processor)
      expect(elapsed).toBeLessThan(500);
      expect(res.status).toBe(202);
      expect(res.body.job_id).toBeDefined();
      expect(res.body.message).toBe('Job accepted for processing');

      // Verify initial pending activity log was created in DB
      const job = mockJobs.get(res.body.job_id);
      expect(job).toBeDefined();
      expect(job.current_state).toBe('pending');

      const logs = mockLogs.get(res.body.job_id);
      expect(logs).toHaveLength(1);
      expect(logs[0].state).toBe('pending');
      expect(logs[0].message).toBe('Job created via API trigger');
    });

    it('should default simulate_failure to false when omitted', async () => {
      const res = await request(app)
        .post('/api/jobs/trigger')
        .send({ type: 'nightly_digest' });

      expect(res.status).toBe(202);
      const job = mockJobs.get(res.body.job_id);
      expect(job.payload.simulate_failure).toBe(false);
    });

    it('should record terminal failed state and return HTTP 500 when enqueue fails', async () => {
      mockEnqueueFail = true;
      const res = await request(app)
        .post('/api/jobs/trigger')
        .send({ type: 'nightly_digest' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Failed to enqueue job for processing');

      // Verify state was marked failed so it is not left looking pending
      const jobsArray = Array.from(mockJobs.values());
      expect(jobsArray.length).toBe(1);
      expect(jobsArray[0].current_state).toBe('failed');
    });

    it('should handle multiple concurrent trigger requests without blocking', async () => {
      const requestCount = 10;
      const promises = Array.from({ length: requestCount }).map((_, i) =>
        request(app)
          .post('/api/jobs/trigger')
          .send({ type: 'nightly_digest', simulate_failure: i % 2 === 0 })
      );

      const start = Date.now();
      const responses = await Promise.all(promises);
      const elapsed = Date.now() - start;

      // All 10 requests should complete promptly in parallel
      expect(elapsed).toBeLessThan(1000);
      responses.forEach((res) => {
        expect(res.status).toBe(202);
        expect(res.body.job_id).toBeDefined();
      });
      expect(mockJobs.size).toBe(requestCount);
    });
  });

  describe('GET /api/jobs/:job_id/logs', () => {
    it('should reject invalid UUID with HTTP 400', async () => {
      const res = await request(app).get('/api/jobs/not-a-valid-uuid/logs');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Must be a valid UUID');
    });

    it('should return HTTP 404 when job does not exist', async () => {
      const randomUuid = mockCrypto.randomUUID();
      const res = await request(app).get(`/api/jobs/${randomUuid}/logs`);
      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });

    it('should return full activity logs in chronological order with derived current_state', async () => {
      const jobId = mockCrypto.randomUUID();
      mockJobs.set(jobId, {
        id: jobId,
        name: 'nightly_digest',
        current_state: 'success',
        created_at: new Date('2026-10-24T12:00:00.000Z'),
      });

      mockLogs.set(jobId, [
        {
          id: mockCrypto.randomUUID(),
          job_id: jobId,
          state: 'pending',
          message: 'Job created via API trigger',
          created_at: new Date('2026-10-24T12:00:00.000Z'),
        },
        {
          id: mockCrypto.randomUUID(),
          job_id: jobId,
          state: 'started',
          message: 'Digest processing started',
          created_at: new Date('2026-10-24T12:00:01.000Z'),
        },
        {
          id: mockCrypto.randomUUID(),
          job_id: jobId,
          state: 'success',
          message: 'Digest generation completed successfully',
          created_at: new Date('2026-10-24T12:00:03.000Z'),
        },
      ]);

      const res = await request(app).get(`/api/jobs/${jobId}/logs`);
      expect(res.status).toBe(200);
      expect(res.body.job_id).toBe(jobId);
      expect(res.body.current_state).toBe('success');
      expect(res.body.logs).toHaveLength(3);
      expect(res.body.logs[0].state).toBe('pending');
      expect(res.body.logs[1].state).toBe('started');
      expect(res.body.logs[2].state).toBe('success');
      expect(res.body.logs[0].created_at).toBe('2026-10-24T12:00:00.000Z');
      expect(res.body.logs[2].created_at).toBe('2026-10-24T12:00:03.000Z');
    });
  });

  describe('Database Schema Definition Verification', () => {
    it('should verify schema.sql defines required tables, UUID keys, and foreign keys', () => {
      const schemaPath = path.join(__dirname, '../src/db/schema.sql');
      const schemaSql = fs.readFileSync(schemaPath, 'utf8');

      // Verify jobs table requirements
      expect(schemaSql).toMatch(/CREATE TABLE IF NOT EXISTS jobs/i);
      expect(schemaSql).toMatch(/id UUID PRIMARY KEY/i);
      expect(schemaSql).toMatch(/name VARCHAR\(255\) NOT NULL/i);
      expect(schemaSql).toMatch(/payload JSONB/i);
      expect(schemaSql).toMatch(/current_state VARCHAR\(50\)/i);
      expect(schemaSql).toMatch(/created_at TIMESTAMPTZ/i);

      // Verify job_activity_logs table requirements
      expect(schemaSql).toMatch(/CREATE TABLE IF NOT EXISTS job_activity_logs/i);
      expect(schemaSql).toMatch(/job_id UUID NOT NULL REFERENCES jobs\(id\)/i);
      expect(schemaSql).toMatch(/state VARCHAR\(50\) NOT NULL/i);
      expect(schemaSql).toMatch(/message TEXT/i);
    });
  });
});
