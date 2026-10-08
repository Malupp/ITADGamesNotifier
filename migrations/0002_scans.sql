CREATE TABLE scan_runs(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('giveaways','prices')),started_at INTEGER NOT NULL,baseline INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'running',finished_at INTEGER);
CREATE UNIQUE INDEX one_active_scan ON scan_runs(kind) WHERE status='running';
CREATE TABLE scan_jobs(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',due_at INTEGER NOT NULL,lease_until INTEGER,lease_token TEXT,attempts INTEGER NOT NULL DEFAULT 0);
CREATE INDEX scan_jobs_due ON scan_jobs(status,due_at,lease_until);
