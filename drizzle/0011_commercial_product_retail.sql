-- Commercial product detail, protected previews, commerce wishlist and pre-checkout cart.
CREATE TABLE IF NOT EXISTS product_rankings (
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  ranking_scope text NOT NULL,
  ranking_key text NOT NULL DEFAULT '',
  rank integer NOT NULL,
  score real NOT NULL DEFAULT 0,
  window text NOT NULL DEFAULT 'current',
  updated_at text NOT NULL,
  PRIMARY KEY(product_id, ranking_scope, ranking_key, window)
);
CREATE INDEX IF NOT EXISTS idx_product_rankings_lookup ON product_rankings(ranking_scope, ranking_key, window, rank);

CREATE TABLE IF NOT EXISTS preview_policies (
  edition_id text PRIMARY KEY REFERENCES editions(id) ON DELETE CASCADE,
  enabled integer NOT NULL DEFAULT 1,
  mode text NOT NULL DEFAULT 'percent' CHECK(mode IN ('percent','chapters')),
  limit_value integer NOT NULL DEFAULT 10,
  max_percentage integer NOT NULL DEFAULT 20,
  version integer NOT NULL DEFAULT 1,
  starts_at text,
  ends_at text,
  updated_by text NOT NULL DEFAULT 'system',
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CHECK(limit_value > 0),
  CHECK(max_percentage BETWEEN 1 AND 50)
);

CREATE TABLE IF NOT EXISTS preview_derivatives (
  id text PRIMARY KEY,
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  asset_version_id text NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
  policy_version integer NOT NULL,
  object_key text NOT NULL,
  spine_items integer NOT NULL DEFAULT 0,
  size_bytes integer,
  sha256 text,
  created_at text NOT NULL,
  UNIQUE(product_id, asset_version_id, policy_version)
);
CREATE INDEX IF NOT EXISTS idx_preview_derivatives_product ON preview_derivatives(product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS preview_states (
  user_id text NOT NULL,
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  cfi text NOT NULL DEFAULT '',
  sample_progress real NOT NULL DEFAULT 0,
  started_at text NOT NULL,
  updated_at text NOT NULL,
  converted_at text,
  PRIMARY KEY(user_id, product_id),
  CHECK(sample_progress BETWEEN 0 AND 1)
);

CREATE TABLE IF NOT EXISTS wishlist_profiles (
  user_id text PRIMARY KEY,
  share_enabled integer NOT NULL DEFAULT 0,
  share_token text,
  title text NOT NULL DEFAULT 'My wishlist',
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wishlist_profiles_share_token ON wishlist_profiles(share_token) WHERE share_token IS NOT NULL;

ALTER TABLE wishlist_items ADD COLUMN currency text;
ALTER TABLE wishlist_items ADD COLUMN alert_price_drop integer NOT NULL DEFAULT 1;
ALTER TABLE wishlist_items ADD COLUMN alert_sale integer NOT NULL DEFAULT 1;
ALTER TABLE wishlist_items ADD COLUMN alert_release integer NOT NULL DEFAULT 1;
ALTER TABLE wishlist_items ADD COLUMN alert_preorder integer NOT NULL DEFAULT 1;
ALTER TABLE wishlist_items ADD COLUMN source_surface text NOT NULL DEFAULT '';
ALTER TABLE wishlist_items ADD COLUMN source_request_id text;
ALTER TABLE wishlist_items ADD COLUMN converted_at text;
ALTER TABLE wishlist_items ADD COLUMN updated_at text;
UPDATE wishlist_items SET updated_at=COALESCE(updated_at,added_at) WHERE updated_at IS NULL;

CREATE TABLE IF NOT EXISTS wishlist_events (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  source_surface text NOT NULL DEFAULT '',
  source_request_id text,
  metadata_json text NOT NULL DEFAULT '{}',
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wishlist_events_user ON wishlist_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wishlist_events_product ON wishlist_events(product_id, event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS commerce_notifications (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  product_id text REFERENCES products(id) ON DELETE CASCADE,
  notification_type text NOT NULL,
  dedupe_key text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  payload_json text NOT NULL DEFAULT '{}',
  read_at text,
  created_at text NOT NULL,
  UNIQUE(user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_commerce_notifications_user ON commerce_notifications(user_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS shopping_carts (
  id text PRIMARY KEY,
  user_id text NOT NULL UNIQUE,
  currency text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS shopping_cart_items (
  cart_id text NOT NULL REFERENCES shopping_carts(id) ON DELETE CASCADE,
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  offer_id text,
  quantity integer NOT NULL DEFAULT 1,
  price_snapshot_minor integer,
  currency text,
  source_surface text NOT NULL DEFAULT '',
  source_request_id text,
  added_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY(cart_id, product_id),
  CHECK(quantity=1)
);
CREATE INDEX IF NOT EXISTS idx_cart_items_product ON shopping_cart_items(product_id);

-- Public-domain titles can expose a sample, though customers can still obtain the full free edition.
INSERT OR IGNORE INTO preview_policies(edition_id,enabled,mode,limit_value,max_percentage,version,updated_by,created_at,updated_at)
SELECT id,1,'percent',15,20,1,'migration',datetime('now'),datetime('now') FROM editions WHERE id LIKE 'ed_gutenberg_%';
