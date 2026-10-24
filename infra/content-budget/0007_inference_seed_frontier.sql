-- CONTENT_DB ONLY. Progress cursor is scheduling fairness, NOT rights authority.
-- A revoked/stale oldest prepared job must not starve later eligible books.
CREATE TABLE IF NOT EXISTS literary_inference_seed_frontier (
  id INTEGER PRIMARY KEY CHECK(id=1),
  after_updated_at TEXT NOT NULL DEFAULT '',
  after_id TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO literary_inference_seed_frontier(id,after_updated_at,after_id)
VALUES(1,'','');
