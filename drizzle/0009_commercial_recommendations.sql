-- Commercial recommendation platform: privacy, real-time interactions, features, candidates, explainability and operations.
CREATE TABLE IF NOT EXISTS recommendation_privacy (
  user_id text PRIMARY KEY NOT NULL,
  personalization_enabled integer NOT NULL DEFAULT 1,
  activity_personalization_enabled integer NOT NULL DEFAULT 1,
  personalized_search_enabled integer NOT NULL DEFAULT 1,
  consent_version text NOT NULL DEFAULT '2026-09',
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS recommendation_events (
  id text PRIMARY KEY NOT NULL,
  user_id text,
  visitor_id text,
  session_id text,
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS recommendation_user_features (
  user_id text NOT NULL,
  feature_type text NOT NULL,
  feature_key text NOT NULL,
  score real NOT NULL DEFAULT 0,
  positive_events integer NOT NULL DEFAULT 0,
  negative_events integer NOT NULL DEFAULT 0,
  last_event_at text,
  model_version text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY(user_id,feature_type,feature_key)
);
CREATE INDEX IF NOT EXISTS idx_rec_user_features_score ON recommendation_user_features(user_id,feature_type,score DESC);

CREATE TABLE IF NOT EXISTS recommendation_item_neighbors (
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  neighbor_product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  strategy text NOT NULL,
  score real NOT NULL,
  reason_json text NOT NULL DEFAULT '{}',
  model_version text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY(product_id,neighbor_product_id,strategy)
);
CREATE INDEX IF NOT EXISTS idx_rec_neighbors_lookup ON recommendation_item_neighbors(product_id,strategy,score DESC);

CREATE TABLE IF NOT EXISTS recommendation_item_metrics (
  product_id text PRIMARY KEY NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  views_7d integer NOT NULL DEFAULT 0,
  clicks_7d integer NOT NULL DEFAULT 0,
  library_adds_30d integer NOT NULL DEFAULT 0,
  completions_90d integer NOT NULL DEFAULT 0,
  wishlists integer NOT NULL DEFAULT 0,
  average_rating real NOT NULL DEFAULT 0,
  rating_count integer NOT NULL DEFAULT 0,
  popularity_score real NOT NULL DEFAULT 0,
  trend_score real NOT NULL DEFAULT 0,
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rec_metrics_trend ON recommendation_item_metrics(trend_score DESC,popularity_score DESC);

CREATE TABLE IF NOT EXISTS recommendation_models (
  id text PRIMARY KEY NOT NULL,
  model_key text NOT NULL,
  version text NOT NULL,
  status text NOT NULL,
  algorithm text NOT NULL,
  config_json text NOT NULL DEFAULT '{}',
  trained_at text,
  activated_at text,
  created_at text NOT NULL,
  UNIQUE(model_key,version)
);
INSERT OR IGNORE INTO recommendation_models(id,model_key,version,status,algorithm,config_json,trained_at,activated_at,created_at)
VALUES('rec_model_hybrid_v1','fore-hybrid','1','active','multi-candidate-hybrid',
'{"candidateGenerators":["content","collaborative","affinity","series","author","publisher","trending","followed-author","wishlist-price-drop","reread"],"diversity":true,"exploration":0.08}',datetime('now'),datetime('now'),datetime('now'));

CREATE TABLE IF NOT EXISTS recommendation_experiments (
  id text PRIMARY KEY NOT NULL,
  experiment_key text NOT NULL UNIQUE,
  surface text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  variants_json text NOT NULL DEFAULT '[{"key":"control","weight":100}]',
  starts_at text,
  ends_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rec_experiments_surface ON recommendation_experiments(surface,status,starts_at,ends_at);

CREATE TABLE IF NOT EXISTS recommendation_requests (
  id text PRIMARY KEY NOT NULL,
  user_id text,
  visitor_id text,
  surface text NOT NULL,
  anchor_product_id text REFERENCES products(id) ON DELETE SET NULL,
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
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS recommendation_feedback (
  user_id text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  action text NOT NULL,
  reason text NOT NULL DEFAULT '',
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY(user_id,entity_type,entity_id,action)
);
CREATE INDEX IF NOT EXISTS idx_rec_feedback_user ON recommendation_feedback(user_id,action);

CREATE TABLE IF NOT EXISTS author_follows (
  user_id text NOT NULL,
  contributor_id text NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
  created_at text NOT NULL,
  PRIMARY KEY(user_id,contributor_id)
);
CREATE INDEX IF NOT EXISTS idx_author_follows_contributor ON author_follows(contributor_id);

CREATE TABLE IF NOT EXISTS wishlist_items (
  user_id text NOT NULL,
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  added_at text NOT NULL,
  baseline_price_minor integer,
  last_seen_price_minor integer,
  last_notified_price_minor integer,
  PRIMARY KEY(user_id,product_id)
);
CREATE INDEX IF NOT EXISTS idx_wishlist_user_time ON wishlist_items(user_id,added_at DESC);

CREATE TABLE IF NOT EXISTS recommendation_cache (
  cache_key text PRIMARY KEY NOT NULL,
  payload_json text NOT NULL,
  model_version text NOT NULL,
  expires_at text NOT NULL,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rec_cache_expiry ON recommendation_cache(expires_at);

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

INSERT OR IGNORE INTO recommendation_item_metrics(product_id,average_rating,rating_count,popularity_score,trend_score,updated_at)
SELECT d.product_id,COALESCE(d.average_rating,0),COALESCE(d.review_count,0),COALESCE(d.download_count,0),COALESCE(d.sales_velocity,0),datetime('now')
FROM catalog_search_documents d JOIN products p ON p.id=d.product_id WHERE p.storefront_status='active';
