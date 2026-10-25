-- Only checkout-time, opt-in referral context is stored, never click events.
-- An independent daily report joins canonical paid/refunded orders.
-- The station is self-reported by the browser, but payment status is not.
CREATE TABLE IF NOT EXISTS commerce_sounds_purchase_attribution (
  order_id TEXT PRIMARY KEY NOT NULL REFERENCES commerce_orders(id) ON DELETE CASCADE,
  station_slug TEXT NOT NULL,
  recording_id TEXT,
  captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS commerce_sounds_purchase_attribution_captured
  ON commerce_sounds_purchase_attribution(captured_at, station_slug);
