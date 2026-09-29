-- Commercial notifications, entitlement-aware EPUB delivery, and versioned customer ownership.

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id TEXT PRIMARY KEY NOT NULL,
  email_enabled INTEGER NOT NULL DEFAULT 1 CHECK(email_enabled IN (0,1)),
  in_app_enabled INTEGER NOT NULL DEFAULT 1 CHECK(in_app_enabled IN (0,1)),
  web_push_enabled INTEGER NOT NULL DEFAULT 0 CHECK(web_push_enabled IN (0,1)),
  mobile_push_enabled INTEGER NOT NULL DEFAULT 0 CHECK(mobile_push_enabled IN (0,1)),
  topic_preferences_json TEXT NOT NULL DEFAULT '{}',
  quiet_hours_json TEXT NOT NULL DEFAULT '{}',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_events (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'purchase_receipt','preorder_released','author_new_book','wishlist_price_drop',
    'subscription_billing','payment_failed','publisher_book_approved','publisher_book_rejected',
    'royalty_statement_ready','payout_sent','review_moderated','account_security_alert'
  )),
  topic TEXT NOT NULL,
  urgency TEXT NOT NULL DEFAULT 'normal' CHECK(urgency IN ('low','normal','high','critical')),
  dedupe_key TEXT NOT NULL,
  subject_type TEXT NOT NULL DEFAULT '',
  subject_id TEXT NOT NULL DEFAULT '',
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  action_url TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(user_id,dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_notification_events_user ON notification_events(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_events_type ON notification_events(event_type,created_at DESC);

CREATE TABLE IF NOT EXISTS notification_inbox (
  notification_id TEXT PRIMARY KEY NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  read_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_inbox_user ON notification_inbox(user_id,archived_at,read_at,created_at DESC);

CREATE TABLE IF NOT EXISTS notification_push_endpoints (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('web_push','mobile_push')),
  platform TEXT NOT NULL DEFAULT 'web',
  endpoint_hash TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL DEFAULT '',
  auth_secret TEXT NOT NULL DEFAULT '',
  provider_token TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(user_id,channel,endpoint_hash)
);
CREATE INDEX IF NOT EXISTS idx_notification_push_user ON notification_push_endpoints(user_id,channel,revoked_at,last_seen_at DESC);

CREATE TABLE IF NOT EXISTS notification_delivery_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  notification_id TEXT NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('email','web_push','mobile_push')),
  endpoint_id TEXT REFERENCES notification_push_endpoints(id) ON DELETE SET NULL,
  destination_ref TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','sent','retry','dead','suppressed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  leased_until TEXT,
  provider_message_id TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(notification_id,channel,endpoint_id)
);
CREATE INDEX IF NOT EXISTS idx_notification_delivery_queue ON notification_delivery_jobs(status,available_at,created_at);

CREATE TABLE IF NOT EXISTS notification_delivery_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  delivery_job_id TEXT NOT NULL REFERENCES notification_delivery_jobs(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  provider TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('sent','retry','failed','suppressed')),
  http_status INTEGER,
  provider_message_id TEXT,
  error_code TEXT NOT NULL DEFAULT '',
  error_detail TEXT NOT NULL DEFAULT '',
  attempted_at TEXT NOT NULL,
  UNIQUE(delivery_job_id,attempt_number)
);

-- Explicit durable ownership snapshot. This separates what a customer acquired from whatever
-- edition/version happens to be live on the storefront later.
CREATE TABLE IF NOT EXISTS entitlement_ownership_records (
  entitlement_id TEXT PRIMARY KEY NOT NULL REFERENCES entitlements(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  edition_id TEXT NOT NULL REFERENCES editions(id) ON DELETE RESTRICT,
  ownership_scope TEXT NOT NULL DEFAULT 'exact_edition' CHECK(ownership_scope IN ('exact_edition','work')),
  publication_version_id TEXT REFERENCES publishing_publication_versions(id) ON DELETE RESTRICT,
  owner_update_policy TEXT NOT NULL DEFAULT 'auto_update' CHECK(owner_update_policy IN ('auto_update','manual_opt_in','preserve_purchased_version')),
  redownload_policy TEXT NOT NULL DEFAULT 'preserve_for_owner' CHECK(redownload_policy IN ('preserve_for_owner','while_listed','disabled')),
  rights_expiry_policy TEXT NOT NULL DEFAULT 'preserve_for_owner' CHECK(rights_expiry_policy IN ('preserve_for_owner','block_delivery')),
  removal_policy TEXT NOT NULL DEFAULT 'preserve_for_owner' CHECK(removal_policy IN ('preserve_for_owner','block_delivery')),
  annotations_policy TEXT NOT NULL DEFAULT 'migrate_or_preserve' CHECK(annotations_policy IN ('migrate_or_preserve','preserve_per_version')),
  biosync_policy TEXT NOT NULL DEFAULT 'version_bound' CHECK(biosync_policy IN ('version_bound','disable_on_version_change')),
  acquired_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ownership_user_work ON entitlement_ownership_records(user_id,work_id,acquired_at DESC);
CREATE INDEX IF NOT EXISTS idx_ownership_product ON entitlement_ownership_records(product_id,acquired_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_entitlement_ownership_immutable_update BEFORE UPDATE ON entitlement_ownership_records BEGIN SELECT RAISE(ABORT,'ownership acquisition snapshots are immutable'); END;

CREATE TABLE IF NOT EXISTS commercial_delivery_policies (
  product_id TEXT PRIMARY KEY NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  require_device_registration INTEGER NOT NULL DEFAULT 0 CHECK(require_device_registration IN (0,1)),
  max_active_devices INTEGER NOT NULL DEFAULT 6 CHECK(max_active_devices BETWEEN 1 AND 100),
  max_downloads_per_entitlement INTEGER NOT NULL DEFAULT 50 CHECK(max_downloads_per_entitlement BETWEEN 1 AND 100000),
  token_ttl_seconds INTEGER NOT NULL DEFAULT 300 CHECK(token_ttl_seconds BETWEEN 30 AND 3600),
  token_max_uses INTEGER NOT NULL DEFAULT 2 CHECK(token_max_uses BETWEEN 1 AND 20),
  watermark_mode TEXT NOT NULL DEFAULT 'none' CHECK(watermark_mode IN ('none','license_marker')),
  encryption_mode TEXT NOT NULL DEFAULT 'none' CHECK(encryption_mode IN ('none','external_wrapped_key')),
  allow_browser_read INTEGER NOT NULL DEFAULT 1 CHECK(allow_browser_read IN (0,1)),
  allow_file_download INTEGER NOT NULL DEFAULT 1 CHECK(allow_file_download IN (0,1)),
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commercial_entitlement_devices (
  entitlement_id TEXT NOT NULL REFERENCES entitlements(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  activated_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  PRIMARY KEY(entitlement_id,device_id)
);
CREATE INDEX IF NOT EXISTS idx_entitlement_devices_product ON commercial_entitlement_devices(product_id,device_id);

CREATE TABLE IF NOT EXISTS commercial_entitlement_delivery_usage (
  entitlement_id TEXT PRIMARY KEY NOT NULL REFERENCES entitlements(id) ON DELETE CASCADE,
  download_count INTEGER NOT NULL DEFAULT 0 CHECK(download_count >= 0),
  last_download_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publication_version_distribution_controls (
  publication_version_id TEXT PRIMARY KEY NOT NULL REFERENCES publishing_publication_versions(id) ON DELETE RESTRICT,
  distribution_status TEXT NOT NULL DEFAULT 'distributable' CHECK(distribution_status IN ('distributable','owner_only','blocked','recalled')),
  allow_existing_owners INTEGER NOT NULL DEFAULT 1 CHECK(allow_existing_owners IN (0,1)),
  reason_code TEXT NOT NULL DEFAULT '',
  reason_detail TEXT NOT NULL DEFAULT '',
  effective_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT 'system',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publication_version_distribution_events (
  id TEXT PRIMARY KEY NOT NULL,
  publication_version_id TEXT NOT NULL REFERENCES publishing_publication_versions(id) ON DELETE RESTRICT,
  from_status TEXT,
  to_status TEXT NOT NULL,
  allow_existing_owners INTEGER NOT NULL,
  reason_code TEXT NOT NULL DEFAULT '',
  reason_detail TEXT NOT NULL DEFAULT '',
  actor_user_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_distribution_events_version ON publication_version_distribution_events(publication_version_id,created_at DESC);

CREATE TABLE IF NOT EXISTS commercial_delivery_grants (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  entitlement_id TEXT NOT NULL REFERENCES entitlements(id) ON DELETE RESTRICT,
  ownership_record_id TEXT NOT NULL REFERENCES entitlement_ownership_records(entitlement_id) ON DELETE RESTRICT,
  publication_version_id TEXT REFERENCES publishing_publication_versions(id) ON DELETE RESTRICT,
  asset_version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE RESTRICT,
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('read','download','offline_package')),
  watermark_id TEXT,
  wrapped_key TEXT,
  policy_snapshot_json TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','revoked','exhausted')),
  revoked_at TEXT,
  revocation_reason TEXT NOT NULL DEFAULT '',
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_delivery_grants_user ON commercial_delivery_grants(user_id,product_id,status,expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_grants_entitlement ON commercial_delivery_grants(entitlement_id,status,issued_at DESC);

CREATE TABLE IF NOT EXISTS commercial_download_audit (
  id TEXT PRIMARY KEY NOT NULL,
  grant_id TEXT REFERENCES commercial_delivery_grants(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  entitlement_id TEXT NOT NULL REFERENCES entitlements(id) ON DELETE RESTRICT,
  asset_version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE RESTRICT,
  publication_version_id TEXT REFERENCES publishing_publication_versions(id) ON DELETE RESTRICT,
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('grant_issued','stream_started','download_started','download_completed','denied','revoked')),
  bytes_served INTEGER NOT NULL DEFAULT 0,
  ip_country TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  reason_code TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_download_audit_user ON commercial_download_audit(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_download_audit_entitlement ON commercial_download_audit(entitlement_id,event_type,created_at DESC);

CREATE TABLE IF NOT EXISTS annotation_version_anchors (
  annotation_id TEXT PRIMARY KEY NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  publication_version_id TEXT REFERENCES publishing_publication_versions(id) ON DELETE SET NULL,
  asset_version_id TEXT REFERENCES asset_versions(id) ON DELETE SET NULL,
  cfi TEXT NOT NULL,
  quote_hash TEXT NOT NULL DEFAULT '',
  prefix_text TEXT NOT NULL DEFAULT '',
  suffix_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_annotation_version_product ON annotation_version_anchors(product_id,publication_version_id);

CREATE TABLE IF NOT EXISTS annotation_cfi_migrations (
  id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  from_publication_version_id TEXT NOT NULL REFERENCES publishing_publication_versions(id) ON DELETE RESTRICT,
  to_publication_version_id TEXT NOT NULL REFERENCES publishing_publication_versions(id) ON DELETE RESTRICT,
  annotation_id TEXT NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
  from_cfi TEXT NOT NULL,
  to_cfi TEXT,
  status TEXT NOT NULL CHECK(status IN ('exact','quote_match','manual_required','orphaned')),
  confidence_bps INTEGER NOT NULL DEFAULT 0 CHECK(confidence_bps BETWEEN 0 AND 10000),
  migration_detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(annotation_id,to_publication_version_id)
);
CREATE INDEX IF NOT EXISTS idx_annotation_migrations_target ON annotation_cfi_migrations(product_id,to_publication_version_id,status);

-- Existing legacy in-app commerce notifications remain readable; new commercial notifications use
-- the immutable event + inbox/outbox model above. No permanent signed commercial URLs are stored.
