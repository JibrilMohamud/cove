-- Recommendation hardening: idempotent event ingestion, deployable models, request telemetry and offline evaluation.
ALTER TABLE recommendation_events ADD COLUMN event_key text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rec_events_event_key ON recommendation_events(event_key) WHERE event_key IS NOT NULL;

ALTER TABLE recommendation_requests ADD COLUMN candidate_count integer NOT NULL DEFAULT 0;
ALTER TABLE recommendation_requests ADD COLUMN latency_ms integer NOT NULL DEFAULT 0;
ALTER TABLE recommendation_requests ADD COLUMN scorer_mode text NOT NULL DEFAULT 'local';
ALTER TABLE recommendation_requests ADD COLUMN fallback_reason text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS recommendation_model_evaluations (
  id text PRIMARY KEY NOT NULL,
  model_key text NOT NULL,
  model_version text NOT NULL,
  surface text NOT NULL,
  window_days integer NOT NULL,
  requests integer NOT NULL DEFAULT 0,
  visible_impressions integer NOT NULL DEFAULT 0,
  clicks integer NOT NULL DEFAULT 0,
  unique_products integer NOT NULL DEFAULT 0,
  catalog_products integer NOT NULL DEFAULT 0,
  ctr real NOT NULL DEFAULT 0,
  catalog_coverage real NOT NULL DEFAULT 0,
  mean_position_clicked real,
  source_entropy real NOT NULL DEFAULT 0,
  generated_at text NOT NULL,
  UNIQUE(model_key,model_version,surface,window_days)
);
CREATE INDEX IF NOT EXISTS idx_rec_model_eval_lookup ON recommendation_model_evaluations(model_key,model_version,surface,generated_at DESC);

CREATE TABLE IF NOT EXISTS recommendation_model_audit (
  id text PRIMARY KEY NOT NULL,
  model_key text NOT NULL,
  version text NOT NULL,
  action text NOT NULL,
  previous_status text,
  next_status text NOT NULL,
  config_json text NOT NULL DEFAULT '{}',
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rec_model_audit_time ON recommendation_model_audit(created_at DESC);
