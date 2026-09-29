-- Harden retail telemetry, ranking reproducibility, and review-integrity policy versioning.
-- Client events remain useful for discovery analytics, but behavioral ranking uses capped/trusted inputs.

ALTER TABLE retail_events ADD COLUMN ranking_eligible INTEGER NOT NULL DEFAULT 1 CHECK(ranking_eligible IN (0,1));
ALTER TABLE retail_events ADD COLUMN ranking_weight REAL NOT NULL DEFAULT 1 CHECK(ranking_weight>=0 AND ranking_weight<=1);
ALTER TABLE retail_events ADD COLUMN quality_reason TEXT NOT NULL DEFAULT 'legacy_accepted';

CREATE TRIGGER IF NOT EXISTS trg_retail_events_append_only_update BEFORE UPDATE ON retail_events
BEGIN SELECT RAISE(ABORT,'retail events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_retail_events_append_only_delete BEFORE DELETE ON retail_events
BEGIN SELECT RAISE(ABORT,'retail events cannot be deleted'); END;

ALTER TABLE retail_daily_product_metrics ADD COLUMN unique_viewers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE retail_daily_product_metrics ADD COLUMN unique_search_clickers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE retail_daily_product_metrics ADD COLUMN unique_sample_readers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE retail_daily_product_metrics ADD COLUMN unique_wishlisters INTEGER NOT NULL DEFAULT 0;
ALTER TABLE retail_daily_product_metrics ADD COLUMN unique_wishlist_removers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE retail_daily_product_metrics ADD COLUMN unique_buyers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE retail_daily_product_metrics ADD COLUMN unique_readers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE retail_daily_product_metrics ADD COLUMN unique_finishers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE retail_daily_product_metrics ADD COLUMN trusted_event_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE retail_daily_product_metrics ADD COLUMN suppressed_event_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS review_integrity_policy_versions (
  id TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('active','retired')),
  policy_json TEXT NOT NULL,
  policy_hash TEXT NOT NULL UNIQUE,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  created_by_user_id TEXT,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO review_integrity_policy_versions(id,version,status,policy_json,policy_hash,effective_from,created_by_user_id,created_at)
VALUES(
  'fore-review-integrity-v1',1,'active',
  '{"reviewVelocity":{"windowMinutes":60,"count":8,"score":65},"productBurst":{"windowMinutes":60,"distinctUsers":12,"score":60},"accountCluster":{"confidence":0.8,"score":75},"publisherCopy":{"score":70},"promotionalCopy":{"score":30},"duplicateText":{"minimumCharacters":30,"score":70},"spam":{"urlThreshold":3,"hardUrlThreshold":5,"score":65,"hardScore":80},"activeSanction":{"score":85},"voteVelocity":{"windowMinutes":10,"count":20,"score":70},"voteCluster":{"confidence":0.75,"score":80},"voteReciprocity":{"minimumMutualHearts":3,"score":65},"ranking":{"limitedAt":60,"excludedAt":80,"trustDivisor":110}}',
  '0fd876fc37461ca17aefd544ab7fb0fcec1a117e99b1fd10470633a82946b763',
  '2026-09-25T00:00:00.000Z','system','2026-09-25T00:00:00.000Z'
);

CREATE TRIGGER IF NOT EXISTS trg_review_integrity_policy_immutable_update BEFORE UPDATE ON review_integrity_policy_versions
BEGIN SELECT RAISE(ABORT,'review integrity policy versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_integrity_policy_immutable_delete BEFORE DELETE ON review_integrity_policy_versions
BEGIN SELECT RAISE(ABORT,'review integrity policy versions cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS trg_retail_ranking_snapshots_immutable_update BEFORE UPDATE ON retail_ranking_snapshots
BEGIN SELECT RAISE(ABORT,'retail ranking snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_retail_ranking_snapshots_immutable_delete BEFORE DELETE ON retail_ranking_snapshots
BEGIN SELECT RAISE(ABORT,'retail ranking snapshots cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_retail_ranking_entries_immutable_update BEFORE UPDATE ON retail_ranking_entries
BEGIN SELECT RAISE(ABORT,'retail ranking entries are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_retail_ranking_entries_immutable_delete BEFORE DELETE ON retail_ranking_entries
BEGIN SELECT RAISE(ABORT,'retail ranking entries cannot be deleted'); END;

INSERT OR IGNORE INTO staff_role_permissions(role_id,permission) VALUES
 ('role_trust_safety','reviews.integrity.policy.manage'),
 ('role_moderation_admin','reviews.integrity.policy.manage');
