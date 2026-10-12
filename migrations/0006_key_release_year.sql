ALTER TABLE key_games ADD COLUMN release_year INTEGER;
-- Legacy workers do not set this field, even if they refresh a Steam mapping during rollout.
ALTER TABLE key_games ADD COLUMN release_checked_at INTEGER NOT NULL DEFAULT 0;
