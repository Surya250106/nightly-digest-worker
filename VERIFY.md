# Acceptance Verification Checklist: Nightly Digest Worker

This document provides a systematic verification checklist for all functional and non-functional requirements of the Nightly Digest Worker project. It includes exact execution commands, expected outcomes, and current verification status.

---

## Verification Status Summary

| Category | Total Requirements | Verified / Passed | Pending Live Environment Verification |
|---|---|---|---|
| Database & Schema | 3 | 3 | 0 |
| REST API Endpoints | 4 | 4 | 0 |
| Worker & Lifecycle Logic | 4 | 4 | 0 |
| Scheduler & Queues | 2 | 2 | 0 |
| Configuration & Repo Readiness | 3 | 3 | 0 |
| Docker Compose Live Runtime | 1 | 0 | 1 (Docker engine pipe inactive on host) |

---

## 1. Automated Tests Execution

- **Command**:
  ```bash
  npm test
  ```
- **Expected Outcome**:
  All 18 tests in `tests/jobs.test.js` and `tests/worker.test.js` pass with 0 errors.
- **Verification Result**: `[PASSED]`
  ```
  Test Suites: 2 passed, 2 total
  Tests:       18 passed, 18 total
  Snapshots:   0 total
  Time:        4.59 s
  Ran all test suites.
  ```

---

## 2. Requirement-by-Requirement Verification Checklist

### 1. Database Schema & Automatic Idempotent Initialization
- **Requirement**: Schema defines `jobs` and `job_activity_logs` tables with UUID primary keys, timezone-aware timestamps, foreign key `job_id REFERENCES jobs(id) ON DELETE CASCADE`, indexes, and idempotent startup via advisory locks.
- **Verification Command**:
  ```bash
  npm test -- -t "Database Schema Definition Verification"
  ```
- **Expected Outcome**: Test confirms table definitions, foreign key reference, and indexes in `schema.sql`.
- **Status**: `[PASSED]`

---

### 2. HTTP 202 Trigger Endpoint & Prompt Response Time
- **Requirement**: `POST /api/jobs/trigger` accepts `nightly_digest` job type, validates payload, persists `pending` state atomically in PostgreSQL, enqueues to BullMQ, and returns HTTP 202 in < 500ms without waiting for digest completion.
- **Verification Command**:
  ```bash
  npm test -- -t "should accept valid trigger request, return HTTP 202 promptly, and create pending state"
  ```
- **Expected Outcome**:
  - HTTP 202 Accepted.
  - Returns `{ "job_id": "<uuid>", "message": "Job accepted for processing" }`.
  - Elapsed response time is well below 500 ms (measured at < 50 ms).
- **Status**: `[PASSED]`

---

### 3. Payload Validation & Error Handling
- **Requirement**: Malformed JSON, invalid job type, and invalid `simulate_failure` type are rejected with HTTP 400.
- **Verification Command**:
  ```bash
  npm test -- -t "should reject invalid or missing type with HTTP 400"
  npm test -- -t "should reject invalid simulate_failure value with HTTP 400"
  ```
- **Expected Outcome**: HTTP 400 with descriptive error messages.
- **Status**: `[PASSED]`

---

### 4. Ten Concurrent Trigger Requests
- **Requirement**: System processes 10 concurrent trigger requests without blocking the event loop or database.
- **Verification Command**:
  ```bash
  npm test -- -t "should handle multiple concurrent trigger requests without blocking"
  ```
- **Expected Outcome**: 10 parallel requests complete promptly, each returning HTTP 202 with unique UUIDs.
- **Status**: `[PASSED]`

---

### 5. Exact Successful Lifecycle: `pending -> started -> success`
- **Requirement**: When `simulate_failure: false`:
  1. Job starts with `pending`.
  2. Worker transitions to `started`.
  3. Worker simulates digest generation with ~2000 ms delay.
  4. Worker transitions to `success` and updates `jobs.current_state`.
- **Verification Command**:
  ```bash
  npm test -- -t "should execute exact successful lifecycle: pending -> started -> success with delay"
  ```
- **Expected Outcome**: Exactly 3 log entries (`pending`, `started`, `success`), execution duration >= 1900 ms, `current_state` set to `success`.
- **Status**: `[PASSED]`

---

### 6. Exact Injected-Failure Lifecycle: `pending -> started -> failed -> dead_letter`
- **Requirement**: When `simulate_failure: true`:
  1. Job starts with `pending`.
  2. Worker transitions to `started`.
  3. Processor immediately encounters deterministic error `"Injected failure encountered during digest generation"`.
  4. Appends `failed` state preserving the error message.
  5. Enqueues job payload and error context to BullMQ DLQ (`nightly_digest_dlq`).
  6. Appends `dead_letter` state and updates `jobs.current_state` to `dead_letter`.
- **Verification Command**:
  ```bash
  npm test -- -t "should execute exact injected-failure lifecycle: pending -> started -> failed -> dead_letter"
  ```
- **Expected Outcome**: Exactly 4 log entries (`pending`, `started`, `failed`, `dead_letter`), error message preserved, and DLQ entry recorded.
- **Status**: `[PASSED]`

---

### 7. Dead-Letter Queue Safety & Error Handling
- **Requirement**: If DLQ enqueue fails, worker must NOT mark job as `dead_letter`. The error must remain observable.
- **Verification Command**:
  ```bash
  npm test -- -t "should not mark job as dead_letter if DLQ enqueue fails"
  ```
- **Expected Outcome**: Rejection with DLQ error; activity logs end at `failed` and do not contain `dead_letter`.
- **Status**: `[PASSED]`

---

### 8. Duplicate Delivery Protection (Idempotency)
- **Requirement**: Re-delivery of a job already in terminal state (`success` or `dead_letter`) must not trigger duplicate transitions or append redundant terminal logs.
- **Verification Command**:
  ```bash
  npm test -- -t "should ignore duplicate execution if job is already in a terminal state"
  ```
- **Expected Outcome**: Worker detects terminal state, skips re-execution, and leaves log history intact.
- **Status**: `[PASSED]`

---

### 9. Activity Logs Retrieval & Ordering: `GET /api/jobs/:job_id/logs`
- **Requirement**: Returns all activity logs in chronological order with ISO 8601 timestamps. Validates UUID and returns HTTP 404 for non-existent IDs.
- **Verification Command**:
  ```bash
  npm test -- -t "should return full activity logs in chronological order with derived current_state"
  npm test -- -t "should return HTTP 404 when job does not exist"
  npm test -- -t "should reject invalid UUID with HTTP 400"
  ```
- **Expected Outcome**: Chronological log array, correct HTTP status codes.
- **Status**: `[PASSED]`

---

### 10. Scheduler Integration & Queue Enqueueing
- **Requirement**: `src/scheduler/index.js` configures `node-cron` with `CRON_SCHEDULE` and `TZ`, creates a `pending` DB record on trigger, and enqueues to the shared BullMQ queue.
- **Verification Command**:
  ```bash
  npm test -- -t "should verify scheduler creates DB record and enqueues using shared queue"
  ```
- **Expected Outcome**: Job record and `pending` log created with `triggered_by: "scheduler"`, enqueued to BullMQ.
- **Status**: `[PASSED]`

---

### 11. Health Endpoint Checks: `GET /health`
- **Requirement**: Active readiness checks for PostgreSQL and Redis. Returns HTTP 200 when both are operational, and HTTP 503 when either dependency is down.
- **Verification Command**:
  ```bash
  npm test -- -t "GET /health"
  ```
- **Expected Outcome**: HTTP 200 when healthy; HTTP 503 when DB or Redis fails.
- **Status**: `[PASSED]`

---

### 12. Environment and Submission Configuration
- **Requirement**:
  - `.env.example` includes all required keys (`NODE_ENV`, `PORT`, `API_PORT`, `DATABASE_URL`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `REDIS_URL`, `CRON_SCHEDULE`, `TZ`).
  - `submission.json` is valid JSON matching:
    ```json
    {
      "evaluationConfig": {
        "apiPort": 3000,
        "queueImplementation": "redis"
      }
    }
    ```
- **Verification Command**:
  ```powershell
  Get-Content submission.json | ConvertFrom-Json
  ```
- **Expected Outcome**: Valid JSON with `apiPort: 3000` and `queueImplementation: "redis"`.
- **Status**: `[PASSED]`

---

### 13. Docker Compose Live Runtime Verification
- **Requirement**:
  - `docker compose up --build -d` starts 5 containers (`db`, `redis`, `api`, `worker`, `scheduler`).
  - Containers start, pass health checks, and expose API on port 3000.
- **Verification Command**:
  ```bash
  docker compose up --build -d
  docker compose ps
  curl -X GET http://localhost:3000/health
  ```
- **Status**: `[UNVERIFIED IN CURRENT ENVIRONMENT]`
  - *Reason*: On the local host machine, Docker Desktop daemon engine pipe (`//./pipe/dockerDesktopLinuxEngine`) was stopped and inaccessible.
  - *Code Validation*: `Dockerfile` and `docker-compose.yml` have been strictly validated against specifications (service dependencies, healthcheck configs, Alpine base, environment variable bindings, named volumes).

---

## Manual Verification Steps for Live Docker Environment

When running in an environment with Docker Desktop / Docker Engine active:

1. **Start all services**:
   ```bash
   docker compose up --build -d
   ```
2. **Verify running containers**:
   ```bash
   docker compose ps
   ```
3. **Verify API health**:
   ```bash
   curl -i http://localhost:3000/health
   ```
4. **Trigger a successful job**:
   ```bash
   curl -i -X POST http://localhost:3000/api/jobs/trigger \
     -H "Content-Type: application/json" \
     -d '{"type":"nightly_digest","simulate_failure":false}'
   ```
5. **Poll job activity logs (observe pending -> started -> success)**:
   ```bash
   curl -i http://localhost:3000/api/jobs/<job_id>/logs
   ```
6. **Trigger an injected failure job**:
   ```bash
   curl -i -X POST http://localhost:3000/api/jobs/trigger \
     -H "Content-Type: application/json" \
     -d '{"type":"nightly_digest","simulate_failure":true}'
   ```
7. **Poll job activity logs (observe pending -> started -> failed -> dead_letter)**:
   ```bash
   curl -i http://localhost:3000/api/jobs/<job_id>/logs
   ```
8. **Inspect DLQ entries in Redis**:
   ```bash
   docker compose exec redis redis-cli keys "bull:nightly_digest_dlq:*"
   ```
