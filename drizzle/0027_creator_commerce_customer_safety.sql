-- Creator commerce customer-safety hardening.
-- Prevent duplicate active preorders under races, and make preorder event history append-only.

CREATE TRIGGER IF NOT EXISTS trg_preorders_no_duplicate_active_insert
BEFORE INSERT ON preorders
WHEN NEW.status IN ('reserved','payment_pending','paid_pending_release','cancellation_requested')
 AND EXISTS (
   SELECT 1 FROM preorders p
   WHERE p.user_id=NEW.user_id
     AND p.product_id=NEW.product_id
     AND p.status IN ('reserved','payment_pending','paid_pending_release','cancellation_requested')
 )
BEGIN
  SELECT RAISE(ABORT,'customer already has an active preorder for this product');
END;

CREATE TRIGGER IF NOT EXISTS trg_preorders_no_duplicate_active_update
BEFORE UPDATE OF user_id,product_id,status ON preorders
WHEN NEW.status IN ('reserved','payment_pending','paid_pending_release','cancellation_requested')
 AND EXISTS (
   SELECT 1 FROM preorders p
   WHERE p.id<>OLD.id
     AND p.user_id=NEW.user_id
     AND p.product_id=NEW.product_id
     AND p.status IN ('reserved','payment_pending','paid_pending_release','cancellation_requested')
 )
BEGIN
  SELECT RAISE(ABORT,'customer already has an active preorder for this product');
END;

CREATE TRIGGER IF NOT EXISTS trg_preorder_events_append_only_update
BEFORE UPDATE ON preorder_events
BEGIN SELECT RAISE(ABORT,'preorder events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_preorder_events_append_only_delete
BEFORE DELETE ON preorder_events
BEGIN SELECT RAISE(ABORT,'preorder events cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS trg_preorder_price_adjustments_append_only_update
BEFORE UPDATE ON preorder_price_adjustments
BEGIN SELECT RAISE(ABORT,'preorder price adjustments are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_preorder_price_adjustments_append_only_delete
BEFORE DELETE ON preorder_price_adjustments
BEGIN SELECT RAISE(ABORT,'preorder price adjustments cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS trg_promotion_campaign_events_append_only_update
BEFORE UPDATE ON promotion_campaign_events
BEGIN SELECT RAISE(ABORT,'promotion campaign events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_promotion_campaign_events_append_only_delete
BEFORE DELETE ON promotion_campaign_events
BEGIN SELECT RAISE(ABORT,'promotion campaign events cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS trg_promotion_attribution_events_append_only_update
BEFORE UPDATE ON promotion_attribution_events
BEGIN SELECT RAISE(ABORT,'promotion attribution events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_promotion_attribution_events_append_only_delete
BEFORE DELETE ON promotion_attribution_events
BEGIN SELECT RAISE(ABORT,'promotion attribution events cannot be deleted'); END;

ALTER TABLE promotion_attribution_events ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_promotion_attribution_dedupe
  ON promotion_attribution_events(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND dedupe_key<>'';
