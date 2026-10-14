-- Admission is atomic across overlapping schedules and deployments.
CREATE TABLE audio_compute_budgets (
  period TEXT PRIMARY KEY,
  reserved_seconds INTEGER NOT NULL DEFAULT 0 CHECK(reserved_seconds >= 0),
  runs INTEGER NOT NULL DEFAULT 0 CHECK(runs >= 0),
  next_run_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
