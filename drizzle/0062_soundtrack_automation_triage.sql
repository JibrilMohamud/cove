-- Keep ambiguous or non-automatable recordings available to staff without
-- allowing them to exhaust the bounded automated-discovery queue.
ALTER TABLE soundtrack_recordings ADD COLUMN automated_triage_reason TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS soundtrack_automation_queue_idx
  ON soundtrack_recordings (status, automated_triage_reason, id);
