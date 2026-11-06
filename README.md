# Nightly Digest Worker with Activity Logging

An enterprise-grade, asynchronous nightly digest worker built with **Node.js**, **Express.js**, **PostgreSQL**, **Redis**, and **BullMQ**. It features structured activity logging, deterministic lifecycle transitions, dead-letter queue (DLQ) isolation for fatal failures, and automated scheduling via **node-cron**.

---

## 1. Project Purpose

The Nightly Digest Worker automates the generation of daily/nightly user digests while maintaining an append-only, transactional audit trail in PostgreSQL. It decouples API ingestion from heavy background processing, ensuring client requests are acknowledged immediately (HTTP 202) while worker processes independently execute jobs and track state transitions.

---

## 2. Architecture & Component Responsibilities

```
                      +-------------------+
                      |   node-cron       |
                      |   Scheduler       |
                      +---------+---------+
                                | (cron tick)
                                v
+------------------+     +------+-----------+     +-------------------+
|  Client / HTTP   |---->|  Express API     |---->|  BullMQ Primary   |
|  Request         |<----+  (Port 3000)     |     |  Digest Queue     |
+------------------+ (202)+------+----------+     +---------+---------+
                                 |                          |
                                 | (create job              | (dequeue job)
                                 |  + pending log)          v
                                 |                +---------+---------+
                                 v                |  BullMQ Worker    |
                       +---------+-------+        |  Processor        |
                       |  PostgreSQL DB  |<-------+  (2000ms delay)   |
                       |  (jobs & logs)  |        +---------+---------+
                       +-----------------+                  |
                                                            | (on failure)
                                                            v
                                                  +---------+---------+
                                                  |  BullMQ Dead-     |
                                                  |  Letter Queue(DLQ)|
                                                  +-------------------+
```

- **API Process (`src/api/server.js`, `src/api/routes/jobs.js`)**:
  - Exposes `GET /health`, `POST /api/jobs/trigger`, and `GET /api/jobs/:job_id/logs`.
  - Atomically creates job records with initial `pending` state in PostgreSQL.
  - Enqueues jobs to BullMQ and responds with HTTP 202 Accepted promptly (< 50ms) without waiting for digest processing.
- **Worker Process (`src/worker/index.js`, `src/worker/processor.js`)**:
  - Consumes jobs asynchronously from the `nightly_digest_queue`.
  - Executes simulation (~2000 ms delay) or catches fatal injected errors.
  - Appends activity log entries and updates `jobs.current_state` atomically.
  - On injected failure, routes error details to the dedicated DLQ (`nightly_digest_dlq`).
- **Scheduler Process (`src/scheduler/index.js`)**:
  - Independent process running `node-cron` with timezone (`TZ`) support.
  - Enqueues jobs via the shared queue mechanism without running digest work synchronously.
- **PostgreSQL Database (`db`)**:
  - Stores persistent `jobs` and immutable `job_activity_logs`.
- **Redis (`redis`)**:
  - Powers BullMQ message brokering with AOF persistence.

---

## 3. Folder Structure

```
nightly-digest-worker/
├── docker-compose.yml
├── Dockerfile
├── .dockerignore
├── .gitignore
├── .env.example
├── package.json
├── package-lock.json
├── README.md
├── VERIFY.md
├── submission.json
├── src/
│   ├── api/
│   │   ├── server.js
│   │   └── routes/
│   │       └── jobs.js
│   ├── db/
│   │   ├── pool.js
│   │   ├── migrate.js
│   │   └── schema.sql
│   ├── queue/
│   │   └── queues.js
│   ├── worker/
│   │   ├── index.js
│   │   └── processor.js
│   └── scheduler/
│       └── index.js
└── tests/
    ├── jobs.test.js
    └── worker.test.js
```

---

## 4. Prerequisites

- **Node.js**: `v18.0.0` or higher (tested on Node.js v26)
- **npm**: `v9.0.0` or higher
- **Docker & Docker Compose**: v2.0+ (optional for containerized runtime)

---

## 5. Environment Setup

Copy `.env.example` to create your local `.env` file:

```bash
# Windows PowerShell
Copy-Item .env.example .env

# Windows Command Prompt / Bash
copy .env.example .env
```

Default configuration variables:

| Variable | Description | Default |
|---|---|---|
| `NODE_ENV` | Environment mode | `development` / `production` |
| `PORT` | API server port | `3000` |
| `API_PORT` | Exposed API port | `3000` |
| `DATABASE_URL` | PostgreSQL connection string | `postgres://postgres:postgres@db:5432/nightly_digest` |
| `POSTGRES_DB` | Database name | `nightly_digest` |
| `POSTGRES_USER` | Database username | `postgres` |
| `POSTGRES_PASSWORD`| Database password | `postgres` |
| `REDIS_URL` | Redis connection URL | `redis://redis:6379` |
| `CRON_SCHEDULE` | Cron expression for scheduler | `0 0 * * *` (midnight daily) |
| `TZ` | Timezone for scheduler | `UTC` |

---

## 6. Docker Startup and Shutdown Commands

### Starting the Application

To build and start all 5 services (`db`, `redis`, `api`, `worker`, `scheduler`) in the background:

```bash
docker compose up --build -d
```

### Checking Service Status

```bash
docker compose ps
```

### Viewing Logs

```bash
# Tail logs from all containers
docker compose logs -f

# Tail logs from specific services
docker compose logs -f api
docker compose logs -f worker
docker compose logs -f scheduler
```

### Shutting Down

```bash
docker compose down

# To also remove named volumes (resets database and Redis):
docker compose down -v
```

---

## 7. Health Endpoint Usage

### Endpoint: `GET /health`

Performs active readiness checks against PostgreSQL (`SELECT 1`) and Redis (`PING`).

#### Example Request:

```bash
curl -X GET http://localhost:3000/health
```

#### Example Response (Healthy - HTTP 200):

```json
{
  "status": "healthy",
  "timestamp": "2026-10-24T16:30:00.000Z",
  "services": {
    "database": "connected",
    "redis": "connected"
  }
}
```

#### Example Response (Degraded/Down - HTTP 503):

```json
{
  "status": "unhealthy",
  "timestamp": "2026-10-24T16:30:00.000Z",
  "services": {
    "database": "error",
    "redis": "connected"
  }
}
```

---

## 8. API Request & Response Examples

### Trigger a Job: `POST /api/jobs/trigger`

#### Headers:
- `Content-Type: application/json`

#### Request Payload (Standard Successful Job):

```json
{
  "type": "nightly_digest",
  "simulate_failure": false
}
```

#### Request Payload (Injected Failure Job):

```json
{
  "type": "nightly_digest",
  "simulate_failure": true
}
```

#### cURL Command:

```bash
curl -X POST http://localhost:3000/api/jobs/trigger \
  -H "Content-Type: application/json" \
  -d '{"type":"nightly_digest","simulate_failure":false}'
```

#### Response (HTTP 202 Accepted):

```json
{
  "job_id": "7f81cd00-8a05-4dd4-af89-2c8d04991872",
  "message": "Job accepted for processing"
}
```

---

### Fetch Job Activity Logs: `GET /api/jobs/:job_id/logs`

#### cURL Command:

```bash
curl -X GET http://localhost:3000/api/jobs/7f81cd00-8a05-4dd4-af89-2c8d04991872/logs
```

#### Response (HTTP 200 OK):

```json
{
  "job_id": "7f81cd00-8a05-4dd4-af89-2c8d04991872",
  "current_state": "success",
  "logs": [
    {
      "state": "pending",
      "message": "Job created via API trigger",
      "created_at": "2026-10-24T16:30:00.000Z"
    },
    {
      "state": "started",
      "message": "Digest processing started",
      "created_at": "2026-10-24T16:30:00.040Z"
    },
    {
      "state": "success",
      "message": "Digest generation completed successfully",
      "created_at": "2026-10-24T16:30:02.050Z"
    }
  ]
}
```

#### Non-existent Job ID (HTTP 404):

```json
{
  "error": "Job with ID 00000000-0000-0000-0000-000000000000 not found"
}
```

#### Malformed UUID (HTTP 400):

```json
{
  "error": "Invalid job_id format. Must be a valid UUID."
}
```

---

## 9. Job Lifecycles

### Successful Job Lifecycle
```
pending ──> started ──(2000ms delay)──> success
```
1. **pending**: Recorded in PostgreSQL within the API trigger transaction before enqueueing.
2. **started**: Recorded when worker dequeues the job.
3. **success**: Recorded after the 2000ms simulated digest generation completes.
- Final `current_state`: `success`.

### Injected Failure Lifecycle
```
pending ──> started ──(fatal error)──> failed ──(enqueue DLQ)──> dead_letter
```
1. **pending**: Recorded upon trigger.
2. **started**: Worker dequeues the job.
3. **failed**: Deterministic error (`Injected failure encountered during digest generation`) caught and persisted with the exact error message.
4. **dead_letter**: Worker enqueues the failure context into `nightly_digest_dlq`, then records `dead_letter`.
- Final `current_state`: `dead_letter`.

---

## 10. PostgreSQL Schema

Automatic schema creation runs idempotently via `src/db/migrate.js` using PostgreSQL advisory locks (`pg_advisory_lock`), preventing race conditions when containers start simultaneously.

### `jobs` Table
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | `PRIMARY KEY` | Unique job identifier |
| `name` | `VARCHAR(255)` | `NOT NULL` | Job type identifier (`nightly_digest`) |
| `payload` | `JSONB` | | Job payload arguments |
| `current_state` | `VARCHAR(50)` | | Latest lifecycle state |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | Timestamp of job creation |

### `job_activity_logs` Table
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | `PRIMARY KEY` | Log entry unique identifier |
| `job_id` | `UUID` | `NOT NULL REFERENCES jobs(id) ON DELETE CASCADE` | Foreign key referencing `jobs` |
| `state` | `VARCHAR(50)` | `NOT NULL` | Lifecycle state (`pending`, `started`, `success`, `failed`, `dead_letter`) |
| `message` | `TEXT` | | Human-readable event description |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | Immutable log timestamp |

Indexes:
- `idx_jobs_current_state` on `jobs(current_state)`
- `idx_job_activity_logs_job_id` on `job_activity_logs(job_id)`
- `idx_job_activity_logs_job_id_created_at` on `job_activity_logs(job_id, created_at ASC)`

---

## 11. Scheduler Configuration

The scheduler runs as an isolated process (`src/scheduler/index.js`) using `node-cron`.

### Changing the Schedule
Edit `CRON_SCHEDULE` and `TZ` in `.env` or `docker-compose.yml`:
```env
# Run every 5 minutes in Eastern Time
CRON_SCHEDULE=*/5 * * * *
TZ=America/New_York

# Default: Every midnight UTC
CRON_SCHEDULE=0 0 * * *
TZ=UTC
```

---

## 12. Automated Testing

The automated test suite runs via **Jest** and **Supertest**.

```bash
# Run all tests
npm test

# Run tests with code coverage
npm run test:coverage
```

### Coverage Highlights:
- **API Tests (`tests/jobs.test.js`)**:
  - `GET /health` active status reporting (healthy vs degraded 503).
  - Validation of request payload types and rejection with HTTP 400.
  - Verification that `POST /api/jobs/trigger` returns HTTP 202 in < 500ms before worker finishes.
  - Validation of UUID path parameter and HTTP 404 behavior.
  - Chronological ordering and ISO 8601 timestamps.
  - Concurrent trigger requests handling 10 requests in parallel.
  - Schema definition verification for UUIDs, foreign keys, and indexes.
- **Worker Tests (`tests/worker.test.js`)**:
  - Exact successful lifecycle: `pending` -> `started` -> `success` with ~2000ms delay.
  - Exact failure lifecycle: `pending` -> `started` -> `failed` -> `dead_letter`.
  - Preservation of error message in `failed` log.
  - Creation of dead-letter queue (DLQ) entries.
  - Duplicate delivery prevention on terminal jobs.
  - Scheduler integration with shared BullMQ queue enqueueing.

---

## 13. Troubleshooting

### 1. Database Connection Refused
- Cause: PostgreSQL container not healthy yet.
- Solution: Ensure Docker healthcheck passed. `src/db/migrate.js` has built-in retry backoff (15 retries, 2s delay).

### 2. Redis Connection Refused
- Cause: Redis service not running or port 6379 blocked.
- Solution: Verify `docker compose ps` shows `nightly_digest_redis` running.

### 3. Port 3000 Already in Use
- Cause: Another application is listening on port 3000.
- Solution: Set `API_PORT=3001` in `.env`.

---

## 14. GitHub Submission Steps

To push the repository to GitHub:

```bash
# 1. Review status to ensure no .env or sensitive files are staged
git status

# 2. Stage all project files
git add .

# 3. Commit changes
git commit -m "feat: complete nightly digest worker with activity logging, BullMQ, and PostgreSQL"

# 4. Set main branch and push to origin
git branch -M main
git push -u origin main
```
