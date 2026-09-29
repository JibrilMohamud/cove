-- Commercial author identity, review provenance/trust, Cove-native ranking, and retail analytics.
-- Retail telemetry is intentionally separate from private reading-session detail.

CREATE TABLE IF NOT EXISTS author_profiles (
  contributor_id TEXT PRIMARY KEY NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
  publishing_account_id TEXT REFERENCES publishing_accounts(id) ON DELETE SET NULL,
  pen_name_id TEXT REFERENCES publishing_pen_names(id) ON DELETE SET NULL,
  profile_status TEXT NOT NULL DEFAULT 'draft' CHECK(profile_status IN ('draft','submitted','active','suspended','retired')),
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK(verification_status IN ('unverified','pending','verified','rejected','revoked')),
  verification_method TEXT NOT NULL DEFAULT '',
  verification_reference TEXT NOT NULL DEFAULT '',
  verified_by_user_id TEXT,
  verified_at TEXT,
  badge_label TEXT NOT NULL DEFAULT 'Verified Author',
  biography TEXT NOT NULL DEFAULT '',
  photo_url TEXT NOT NULL DEFAULT '',
  publisher_id TEXT REFERENCES publishers(id) ON DELETE SET NULL,
  imprint_id TEXT REFERENCES imprints(id) ON DELETE SET NULL,
  locale TEXT NOT NULL DEFAULT 'en',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_author_profiles_account ON author_profiles(publishing_account_id,profile_status,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_author_profiles_verified ON author_profiles(verification_status,profile_status,updated_at DESC);

CREATE TABLE IF NOT EXISTS author_profile_links (
  id TEXT PRIMARY KEY NOT NULL,
  contributor_id TEXT NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL CHECK(link_type IN ('website','instagram','facebook','x','tiktok','youtube','bluesky','mastodon','other')),
  label TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  normalized_host TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending','active','rejected','removed')),
  policy_reason TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(contributor_id,url)
);
CREATE INDEX IF NOT EXISTS idx_author_profile_links_active ON author_profile_links(contributor_id,status,position,id);

CREATE TABLE IF NOT EXISTS author_profile_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  contributor_id TEXT NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL CHECK(revision_number>0),
  publishing_account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE RESTRICT,
  pen_name_id TEXT REFERENCES publishing_pen_names(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','rejected','superseded')),
  biography TEXT NOT NULL DEFAULT '',
  photo_url TEXT NOT NULL DEFAULT '',
  publisher_id TEXT REFERENCES publishers(id) ON DELETE SET NULL,
  imprint_id TEXT REFERENCES imprints(id) ON DELETE SET NULL,
  locale TEXT NOT NULL DEFAULT 'en',
  links_json TEXT NOT NULL DEFAULT '[]',
  content_sha256 TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  submitted_at TEXT,
  reviewed_by_user_id TEXT,
  reviewed_at TEXT,
  review_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(contributor_id,revision_number)
);
CREATE INDEX IF NOT EXISTS idx_author_profile_revisions_queue ON author_profile_revisions(status,submitted_at,contributor_id);
CREATE TRIGGER IF NOT EXISTS trg_author_profile_revision_no_delete BEFORE DELETE ON author_profile_revisions BEGIN SELECT RAISE(ABORT,'author profile revisions cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_author_profile_revision_submitted_content_immutable BEFORE UPDATE ON author_profile_revisions
WHEN OLD.status<>'draft' AND (OLD.biography<>NEW.biography OR OLD.photo_url<>NEW.photo_url OR COALESCE(OLD.publisher_id,'')<>COALESCE(NEW.publisher_id,'') OR COALESCE(OLD.imprint_id,'')<>COALESCE(NEW.imprint_id,'') OR OLD.locale<>NEW.locale OR OLD.links_json<>NEW.links_json OR OLD.content_sha256<>NEW.content_sha256)
BEGIN SELECT RAISE(ABORT,'submitted author profile revision content is immutable'); END;

CREATE TABLE IF NOT EXISTS author_profile_events (
  id TEXT PRIMARY KEY NOT NULL,
  contributor_id TEXT NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('created','updated','submitted','verified','rejected','revoked','suspended','restored','retired','link_reviewed')),
  actor_type TEXT NOT NULL CHECK(actor_type IN ('publisher','staff','automation')),
  actor_user_id TEXT,
  reason_code TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_author_profile_events_author ON author_profile_events(contributor_id,created_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_author_profile_events_append_only_update BEFORE UPDATE ON author_profile_events BEGIN SELECT RAISE(ABORT,'author profile events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_author_profile_events_append_only_delete BEFORE DELETE ON author_profile_events BEGIN SELECT RAISE(ABORT,'author profile events cannot be deleted'); END;

CREATE TABLE IF NOT EXISTS author_follow_preferences (
  user_id TEXT NOT NULL,
  contributor_id TEXT NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
  release_alerts INTEGER NOT NULL DEFAULT 1 CHECK(release_alerts IN (0,1)),
  preorder_alerts INTEGER NOT NULL DEFAULT 1 CHECK(preorder_alerts IN (0,1)),
  in_app INTEGER NOT NULL DEFAULT 1 CHECK(in_app IN (0,1)),
  email INTEGER NOT NULL DEFAULT 0 CHECK(email IN (0,1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id,contributor_id)
);

CREATE TABLE IF NOT EXISTS author_release_alert_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  contributor_id TEXT NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL CHECK(alert_type IN ('preorder_open','release')),
  event_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','dead')),
  cursor_user_id TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(contributor_id,product_id,alert_type,event_at)
);
CREATE INDEX IF NOT EXISTS idx_author_alert_jobs_queue ON author_release_alert_jobs(status,available_at,event_at);

CREATE TABLE IF NOT EXISTS author_alert_scan_state (
  id INTEGER PRIMARY KEY NOT NULL CHECK(id=1),
  last_scanned_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO author_alert_scan_state(id,last_scanned_at,updated_at) VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));

ALTER TABLE reviews ADD COLUMN provenance_type TEXT NOT NULL DEFAULT 'sideloaded_unverified';
ALTER TABLE reviews ADD COLUMN provenance_weight REAL NOT NULL DEFAULT 0.35;
ALTER TABLE reviews ADD COLUMN trust_score REAL NOT NULL DEFAULT 0.5;
ALTER TABLE reviews ADD COLUMN ranking_status TEXT NOT NULL DEFAULT 'eligible';
ALTER TABLE reviews ADD COLUMN product_id TEXT;

CREATE TABLE IF NOT EXISTS review_provenance_snapshots (
  review_id TEXT PRIMARY KEY NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  provenance_type TEXT NOT NULL CHECK(provenance_type IN ('verified_purchase','subscription_reader','free_promotional_copy','gifted','sideloaded_unverified','publisher_author_copy')),
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  entitlement_id TEXT REFERENCES entitlements(id) ON DELETE SET NULL,
  order_item_id TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  captured_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS trg_review_provenance_immutable_update BEFORE UPDATE ON review_provenance_snapshots BEGIN SELECT RAISE(ABORT,'review provenance snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_review_provenance_immutable_delete BEFORE DELETE ON review_provenance_snapshots BEGIN SELECT RAISE(ABORT,'review provenance snapshots cannot be deleted'); END;

CREATE TABLE IF NOT EXISTS retail_account_risk_links (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  linked_user_id TEXT NOT NULL,
  link_type TEXT NOT NULL CHECK(link_type IN ('device','network','payment','household','behavioral','manual')),
  confidence REAL NOT NULL CHECK(confidence>=0 AND confidence<=1),
  evidence_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','dismissed','confirmed_abuse')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(user_id<>linked_user_id),
  UNIQUE(user_id,linked_user_id,link_type)
);
CREATE INDEX IF NOT EXISTS idx_retail_risk_links_user ON retail_account_risk_links(user_id,status,confidence DESC);

CREATE TABLE IF NOT EXISTS review_abuse_signals (
  id TEXT PRIMARY KEY NOT NULL,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  product_id TEXT,
  signal_type TEXT NOT NULL CHECK(signal_type IN ('brigade_velocity','suspicious_cluster','vote_manipulation','promotional_review','spam','rating_burst','duplicate_text','sanctioned_account','publisher_relationship')),
  score REAL NOT NULL CHECK(score>=0 AND score<=100),
  model_version TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  disposition TEXT NOT NULL DEFAULT 'open' CHECK(disposition IN ('open','dismissed','confirmed','mitigated')),
  reviewed_by_user_id TEXT,
  reviewed_at TEXT,
  review_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_abuse_open ON review_abuse_signals(disposition,signal_type,score DESC,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_abuse_review ON review_abuse_signals(review_id,created_at DESC);

CREATE TABLE IF NOT EXISTS review_vote_signals (
  id TEXT PRIMARY KEY NOT NULL,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  voter_user_id TEXT NOT NULL,
  signal_type TEXT NOT NULL CHECK(signal_type IN ('velocity','cluster','reciprocity','self_interest')),
  score REAL NOT NULL CHECK(score>=0 AND score<=100),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  disposition TEXT NOT NULL DEFAULT 'open' CHECK(disposition IN ('open','dismissed','confirmed','mitigated')),
  reviewed_by_user_id TEXT,
  reviewed_at TEXT,
  review_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_vote_signals_vote ON review_vote_signals(review_id,voter_user_id,score DESC);

CREATE TABLE IF NOT EXISTS retail_events (
  id TEXT PRIMARY KEY NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('search_performed','search_result_clicked','product_viewed','sample_started','sample_completed','wishlist_added','wishlist_removed','cart_added','cart_removed','checkout_started','purchase_completed','refund_completed','book_opened','book_finished','review_submitted','review_hearted','promotion_impression','promotion_clicked')),
  user_id TEXT,
  anonymous_id TEXT,
  session_id TEXT,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  external_book_id TEXT,
  query_id TEXT,
  campaign_id TEXT,
  source_surface TEXT NOT NULL DEFAULT '',
  source_request_id TEXT,
  territory_code TEXT NOT NULL DEFAULT 'US',
  currency TEXT,
  amount_minor INTEGER,
  quantity REAL NOT NULL DEFAULT 1,
  properties_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  dedupe_key TEXT,
  event_origin TEXT NOT NULL DEFAULT 'server' CHECK(event_origin IN ('client','server','worker')),
  CHECK(user_id IS NOT NULL OR anonymous_id IS NOT NULL OR event_type IN ('purchase_completed','refund_completed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_retail_events_dedupe ON retail_events(dedupe_key) WHERE dedupe_key IS NOT NULL AND dedupe_key<>'';
CREATE INDEX IF NOT EXISTS idx_retail_events_product_time ON retail_events(product_id,event_type,occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_retail_events_user_time ON retail_events(user_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_retail_events_query ON retail_events(query_id,event_type,occurred_at DESC);

CREATE TABLE IF NOT EXISTS retail_event_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES retail_events(id) ON DELETE CASCADE,
  destination TEXT NOT NULL DEFAULT 'warehouse',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','delivered','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(event_id,destination)
);
CREATE INDEX IF NOT EXISTS idx_retail_event_outbox_queue ON retail_event_outbox(destination,status,available_at,created_at);

CREATE TABLE IF NOT EXISTS retail_daily_product_metrics (
  metric_date TEXT NOT NULL,
  territory_code TEXT NOT NULL DEFAULT 'US',
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  product_views INTEGER NOT NULL DEFAULT 0,
  search_clicks INTEGER NOT NULL DEFAULT 0,
  sample_starts INTEGER NOT NULL DEFAULT 0,
  sample_completions INTEGER NOT NULL DEFAULT 0,
  wishlist_adds INTEGER NOT NULL DEFAULT 0,
  wishlist_removes INTEGER NOT NULL DEFAULT 0,
  cart_adds INTEGER NOT NULL DEFAULT 0,
  checkout_starts INTEGER NOT NULL DEFAULT 0,
  purchases INTEGER NOT NULL DEFAULT 0,
  units REAL NOT NULL DEFAULT 0,
  gross_revenue_minor INTEGER NOT NULL DEFAULT 0,
  refunds INTEGER NOT NULL DEFAULT 0,
  refund_minor INTEGER NOT NULL DEFAULT 0,
  book_opens INTEGER NOT NULL DEFAULT 0,
  completions INTEGER NOT NULL DEFAULT 0,
  review_count INTEGER NOT NULL DEFAULT 0,
  verified_review_count INTEGER NOT NULL DEFAULT 0,
  weighted_rating_sum REAL NOT NULL DEFAULT 0,
  weighted_rating_weight REAL NOT NULL DEFAULT 0,
  subscription_units REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(metric_date,territory_code,product_id)
);
CREATE INDEX IF NOT EXISTS idx_retail_daily_metrics_product ON retail_daily_product_metrics(product_id,metric_date DESC,territory_code);

CREATE TABLE IF NOT EXISTS retail_ranking_policy_versions (
  id TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('draft','active','retired')),
  policy_json TEXT NOT NULL,
  policy_hash TEXT NOT NULL UNIQUE,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  created_by_user_id TEXT,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO retail_ranking_policy_versions(id,version,status,policy_json,policy_hash,effective_from,created_by_user_id,created_at)
VALUES('fore-ranking-v1',1,'active',
'{"bestselling":{"purchase":8,"revenueLog":2.5,"refund":-10,"decayHalfLifeDays":7},"trending":{"purchase":6,"wishlist":2,"sampleComplete":1.5,"searchClick":0.5,"conversion":4,"refund":-8,"decayHalfLifeDays":2},"mostRead":{"open":0.2,"completion":5,"subscription":2,"decayHalfLifeDays":14},"mostWishlisted":{"wishlist":1,"removal":-1,"decayHalfLifeDays":14},"topRated":{"priorMean":3.8,"priorWeight":10,"verifiedWeight":1,"subscriptionWeight":0.9,"promoWeight":0.65,"unverifiedWeight":0.35,"minReviews":3},"newNoteworthy":{"trending":0.5,"rating":0.3,"completion":0.2,"maxAgeDays":90}}',
'715833df100b74a8563dbb710ec93bffe98842a2006d1d486c9f4dd4fd7dac88','2026-09-25T00:00:00.000Z','system','2026-09-25T00:00:00.000Z');

CREATE TRIGGER IF NOT EXISTS trg_retail_ranking_policy_immutable_update BEFORE UPDATE ON retail_ranking_policy_versions BEGIN SELECT RAISE(ABORT,'retail ranking policy versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_retail_ranking_policy_immutable_delete BEFORE DELETE ON retail_ranking_policy_versions BEGIN SELECT RAISE(ABORT,'retail ranking policy versions cannot be deleted'); END;

CREATE TABLE IF NOT EXISTS retail_ranking_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  chart_key TEXT NOT NULL CHECK(chart_key IN ('bestselling','trending','most_read','most_wishlisted','new_noteworthy','top_rated')),
  territory_code TEXT NOT NULL DEFAULT 'US',
  category_key TEXT NOT NULL DEFAULT '',
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  policy_version_id TEXT NOT NULL REFERENCES retail_ranking_policy_versions(id) ON DELETE RESTRICT,
  generated_at TEXT NOT NULL,
  source_watermark_at TEXT NOT NULL,
  UNIQUE(chart_key,territory_code,category_key,generated_at)
);
CREATE INDEX IF NOT EXISTS idx_ranking_snapshots_latest ON retail_ranking_snapshots(chart_key,territory_code,category_key,generated_at DESC);

CREATE TABLE IF NOT EXISTS retail_ranking_entries (
  snapshot_id TEXT NOT NULL REFERENCES retail_ranking_snapshots(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL CHECK(rank>=1),
  score REAL NOT NULL,
  components_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(snapshot_id,product_id),
  UNIQUE(snapshot_id,rank)
);
CREATE INDEX IF NOT EXISTS idx_ranking_entries_product ON retail_ranking_entries(product_id,rank);

ALTER TABLE catalog_search_documents ADD COLUMN fore_bestseller_score REAL NOT NULL DEFAULT 0;
ALTER TABLE catalog_search_documents ADD COLUMN fore_trending_score REAL NOT NULL DEFAULT 0;
ALTER TABLE catalog_search_documents ADD COLUMN fore_read_score REAL NOT NULL DEFAULT 0;
ALTER TABLE catalog_search_documents ADD COLUMN fore_wishlist_score REAL NOT NULL DEFAULT 0;
ALTER TABLE catalog_search_documents ADD COLUMN fore_rating_score REAL NOT NULL DEFAULT 0;
ALTER TABLE catalog_search_documents ADD COLUMN fore_noteworthy_score REAL NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_search_fore_bestseller ON catalog_search_documents(fore_bestseller_score DESC);
CREATE INDEX IF NOT EXISTS idx_search_fore_trending ON catalog_search_documents(fore_trending_score DESC);
CREATE INDEX IF NOT EXISTS idx_search_fore_read ON catalog_search_documents(fore_read_score DESC);
CREATE INDEX IF NOT EXISTS idx_search_fore_wishlist ON catalog_search_documents(fore_wishlist_score DESC);
CREATE INDEX IF NOT EXISTS idx_search_fore_rating ON catalog_search_documents(fore_rating_score DESC);

INSERT OR IGNORE INTO staff_role_permissions(role_id,permission) VALUES
 ('role_trust_safety','authors.verify'),
 ('role_trust_safety','reviews.integrity.read'),
 ('role_trust_safety','reviews.integrity.manage'),
 ('role_finance_ops','analytics.operations.read'),
 ('role_finance_ops','analytics.operations.manage'),
 ('role_moderation_admin','authors.verify'),
 ('role_moderation_admin','reviews.integrity.read'),
 ('role_moderation_admin','reviews.integrity.manage'),
 ('role_moderation_admin','analytics.operations.read'),
 ('role_moderation_admin','analytics.operations.manage');
