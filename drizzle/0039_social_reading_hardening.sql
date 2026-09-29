PRAGMA foreign_keys=OFF;

-- Social-reading hardening: consented follower relationships, lifecycle/version controls,
-- auditability, scalable author fan-out, and notification support for social events.
ALTER TABLE social_profiles ADD COLUMN follow_policy TEXT NOT NULL DEFAULT 'open' CHECK(follow_policy IN ('open','request','closed'));
ALTER TABLE social_profiles ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE social_follow_requests (
  requester_user_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','canceled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT,
  PRIMARY KEY(requester_user_id,target_user_id),
  CHECK(requester_user_id<>target_user_id)
);
CREATE INDEX idx_social_follow_requests_target ON social_follow_requests(target_user_id,status,created_at DESC);

CREATE TABLE social_mutes (
  muter_user_id TEXT NOT NULL,
  muted_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(muter_user_id,muted_user_id),
  CHECK(muter_user_id<>muted_user_id)
);
CREATE INDEX idx_social_mutes_muted ON social_mutes(muted_user_id);

ALTER TABLE social_posts ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE social_posts ADD COLUMN edited_at TEXT;

CREATE TABLE social_post_revisions (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  passage_text TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL,
  spoiler INTEGER NOT NULL CHECK(spoiler IN (0,1)),
  changed_by_user_id TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK(change_type IN ('edit','delete','moderation')),
  created_at TEXT NOT NULL,
  UNIQUE(post_id,version)
);
CREATE INDEX idx_social_post_revisions_post ON social_post_revisions(post_id,version DESC);

ALTER TABLE social_lists ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE social_lists ADD COLUMN deleted_at TEXT;
ALTER TABLE reading_groups ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE reading_groups ADD COLUMN deleted_at TEXT;
ALTER TABLE reading_journeys ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE reading_journeys ADD COLUMN share_revoked_at TEXT;
ALTER TABLE annotations ADD COLUMN progress REAL CHECK(progress IS NULL OR (progress BETWEEN 0 AND 1));
ALTER TABLE author_social_posts ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE author_social_posts ADD COLUMN deleted_at TEXT;

CREATE TABLE social_audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_social_audit_subject ON social_audit_events(subject_type,subject_id,created_at DESC);
CREATE INDEX idx_social_audit_actor ON social_audit_events(actor_user_id,created_at DESC);

CREATE TABLE author_social_fanout_jobs (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES author_social_posts(id) ON DELETE CASCADE,
  contributor_id TEXT NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
  cursor_user_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  delivered_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  UNIQUE(post_id)
);
CREATE INDEX idx_author_social_fanout_queue ON author_social_fanout_jobs(status,available_at,created_at);

-- Social event types were added in application code after the original notifications table.
-- Rebuild the table so SQLite's CHECK constraint matches the current contract while preserving data.
CREATE TABLE notification_events_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'purchase_receipt','preorder_released','author_new_book','wishlist_price_drop',
    'subscription_billing','payment_failed','publisher_book_approved','publisher_book_rejected',
    'royalty_statement_ready','payout_sent','review_moderated','account_security_alert',
    'social_follow','social_reply','social_club_invite','author_social_post'
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
INSERT INTO notification_events_v2(id,user_id,event_type,topic,urgency,dedupe_key,subject_type,subject_id,product_id,title,body,action_url,payload_json,created_at)
SELECT id,user_id,event_type,topic,urgency,dedupe_key,subject_type,subject_id,product_id,title,body,action_url,payload_json,created_at FROM notification_events;
DROP TABLE notification_events;
ALTER TABLE notification_events_v2 RENAME TO notification_events;
CREATE INDEX idx_notification_events_user ON notification_events(user_id,created_at DESC);
CREATE INDEX idx_notification_events_type ON notification_events(event_type,created_at DESC);

PRAGMA foreign_keys=ON;
