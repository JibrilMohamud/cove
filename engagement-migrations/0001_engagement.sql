-- Independent engagement database only. Never apply to the rights/commerce DB.
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS recommendation_events (
  id text PRIMARY KEY NOT NULL,
  user_id text,
  visitor_id text,
  session_id text,
  product_id text NOT NULL,
  event_type text NOT NULL,
  source_surface text NOT NULL DEFAULT '',
  recommendation_request_id text,
  position integer,
  value real,
  metadata_json text NOT NULL DEFAULT '{}',
  occurred_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rec_events_user_time ON recommendation_events(user_id,occurred_at);
CREATE INDEX IF NOT EXISTS idx_rec_events_product_time ON recommendation_events(product_id,occurred_at);
CREATE INDEX IF NOT EXISTS idx_rec_events_type_time ON recommendation_events(event_type,occurred_at);

CREATE TABLE IF NOT EXISTS recommendation_requests (
  id text PRIMARY KEY NOT NULL,
  user_id text,
  visitor_id text,
  surface text NOT NULL,
  anchor_product_id text,
  model_key text NOT NULL,
  model_version text NOT NULL,
  experiment_id text,
  experiment_variant text,
  algorithm text NOT NULL,
  consent_mode text NOT NULL,
  territory_code text NOT NULL,
  context_json text NOT NULL DEFAULT '{}',
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rec_requests_user_time ON recommendation_requests(user_id,created_at);
CREATE INDEX IF NOT EXISTS idx_rec_requests_surface_time ON recommendation_requests(surface,created_at);

CREATE TABLE IF NOT EXISTS recommendation_impressions (
  request_id text NOT NULL REFERENCES recommendation_requests(id) ON DELETE CASCADE,
  product_id text NOT NULL,
  position integer NOT NULL,
  score real NOT NULL,
  reason_code text NOT NULL,
  reason_text text NOT NULL,
  candidate_sources_json text NOT NULL DEFAULT '[]',
  impressed_at text,
  clicked_at text,
  PRIMARY KEY(request_id,product_id)
);
CREATE INDEX IF NOT EXISTS idx_rec_impressions_product ON recommendation_impressions(product_id,impressed_at);

CREATE TABLE IF NOT EXISTS recommendation_jobs (
  id text PRIMARY KEY NOT NULL,
  job_type text NOT NULL,
  entity_id text,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  last_error text NOT NULL DEFAULT '',
  queued_at text NOT NULL,
  available_at text NOT NULL,
  started_at text,
  locked_at text,
  lease_until text,
  finished_at text
);
CREATE INDEX IF NOT EXISTS idx_rec_jobs_queue ON recommendation_jobs(status,available_at,queued_at);
CREATE INDEX IF NOT EXISTS idx_rec_jobs_entity ON recommendation_jobs(job_type,entity_id,status);
ALTER TABLE recommendation_events ADD COLUMN event_key text;
CREATE UNIQUE INDEX idx_rec_event_key ON recommendation_events(event_key) WHERE event_key IS NOT NULL;

ALTER TABLE recommendation_requests ADD COLUMN candidate_count integer NOT NULL DEFAULT 0;
ALTER TABLE recommendation_requests ADD COLUMN latency_ms real NOT NULL DEFAULT 0;
ALTER TABLE recommendation_requests ADD COLUMN scorer_mode text NOT NULL DEFAULT 'local';
ALTER TABLE recommendation_requests ADD COLUMN fallback_reason text NOT NULL DEFAULT '';
ALTER TABLE recommendation_impressions ADD COLUMN feature_snapshot_json text NOT NULL DEFAULT '[]';

CREATE TABLE engagement_erased_users(user_id text PRIMARY KEY NOT NULL,erased_at text NOT NULL);
CREATE TABLE engagement_schema(version integer PRIMARY KEY CHECK(version=1));
INSERT INTO engagement_schema VALUES(1);

CREATE TABLE `search_query_events` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text,
  `query` text DEFAULT '' NOT NULL,
  `normalized_query` text DEFAULT '' NOT NULL,
  `filters_json` text DEFAULT '{}' NOT NULL,
  `sort` text DEFAULT 'relevance' NOT NULL,
  `result_count` integer DEFAULT 0 NOT NULL,
  `backend` text NOT NULL,
  `duration_ms` integer DEFAULT 0 NOT NULL,
  `corrected_query` text,
  `result_impressions_json` text DEFAULT '[]' NOT NULL,
  `created_at` text NOT NULL
);
CREATE INDEX `idx_search_events_recent` ON `search_query_events` (`created_at`);
CREATE INDEX `idx_search_events_query` ON `search_query_events` (`normalized_query`,`created_at`);

CREATE TABLE `search_click_events` (
  `query_id` text NOT NULL,
  `product_id` text NOT NULL,
  `position` integer NOT NULL,
  `created_at` text NOT NULL,
  PRIMARY KEY(`query_id`,`product_id`,`position`),
  FOREIGN KEY (`query_id`) REFERENCES `search_query_events`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `idx_search_clicks_product` ON `search_click_events` (`product_id`,`created_at`);

CREATE TABLE ops_http_requests (
  id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  actor_kind TEXT NOT NULL DEFAULT 'anonymous',
  storefront_country TEXT,
  error_class TEXT,
  sampled INTEGER NOT NULL DEFAULT 1 CHECK(sampled IN (0,1)),
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_ops_http_time ON ops_http_requests(occurred_at DESC);
CREATE INDEX idx_ops_http_route ON ops_http_requests(route,occurred_at DESC);
CREATE INDEX idx_ops_http_trace ON ops_http_requests(trace_id,occurred_at);

CREATE TABLE ops_trace_spans (
  id TEXT PRIMARY KEY NOT NULL,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  span_name TEXT NOT NULL,
  span_kind TEXT NOT NULL DEFAULT 'internal' CHECK(span_kind IN ('server','client','producer','consumer','internal')),
  status TEXT NOT NULL DEFAULT 'ok' CHECK(status IN ('ok','error')),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(trace_id,span_id)
);
CREATE INDEX idx_ops_trace_spans_trace ON ops_trace_spans(trace_id,started_at);

CREATE TABLE ops_metric_points (
  id TEXT PRIMARY KEY NOT NULL,
  metric_name TEXT NOT NULL,
  metric_type TEXT NOT NULL CHECK(metric_type IN ('counter','gauge','histogram')),
  value REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT '1',
  labels_json TEXT NOT NULL DEFAULT '{}',
  observed_at TEXT NOT NULL
);
CREATE INDEX idx_ops_metrics_name_time ON ops_metric_points(metric_name,observed_at DESC);
