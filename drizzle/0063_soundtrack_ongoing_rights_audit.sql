-- Historical recording-level licenses can change after publication.
-- Check freshness independently of release metadata and hold transient outages.
ALTER TABLE soundtrack_recordings ADD COLUMN rights_checked_at TEXT NOT NULL DEFAULT '';
ALTER TABLE soundtrack_recordings ADD COLUMN rights_check_error TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS soundtrack_reaudit_due
  ON soundtrack_recordings(status,rights_checked_at,id);
