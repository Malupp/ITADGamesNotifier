-- Run completion/recovery must inspect a single run, not every historical job.
CREATE INDEX scan_jobs_run_status ON scan_jobs(run_id,status);
CREATE INDEX key_scan_jobs_run_status ON key_scan_jobs(run_id,status);
-- Price pages update only their watched games, across owners.
CREATE INDEX key_alert_state_game ON key_alert_state(game_id);
-- Retention begins with old runs rather than scanning every job.
CREATE INDEX scan_runs_retention ON scan_runs(started_at,status);
CREATE INDEX key_scan_runs_retention ON key_scan_runs(started_at,status);
-- Each news cycle checks at most its own eight source jobs.
CREATE INDEX news_jobs_cycle_state ON news_jobs(cycle_at,status,attempts);
