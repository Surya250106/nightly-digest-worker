-- PostgreSQL Schema for Nightly Digest Worker

CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    payload JSONB,
    current_state VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS job_activity_logs (
    id UUID PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    state VARCHAR(50) NOT NULL,
    message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance and query optimization
CREATE INDEX IF NOT EXISTS idx_jobs_current_state ON jobs(current_state);
CREATE INDEX IF NOT EXISTS idx_job_activity_logs_job_id ON job_activity_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_job_activity_logs_job_id_created_at ON job_activity_logs(job_id, created_at ASC);
