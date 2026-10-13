-- Distinguish newer private use even when two updates share a millisecond.
ALTER TABLE private_users ADD COLUMN activity_revision INTEGER NOT NULL DEFAULT 0;
