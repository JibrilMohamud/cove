-- The original UNIQUE(user_id,product_id,entitlement_type) index caused
-- a second legitimate paid order to overwrite a previously REVOKED grant.
-- Revoked entitlement identities remain terminal under migration 0087.
-- Keep a single active entitlement per buyer/product/type while allowing
-- independent historical revoked records and fresh order-linked purchases.
DROP INDEX IF EXISTS idx_entitlements_user_product_type;

CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlements_current_user_product_type
ON entitlements(user_id,product_id,entitlement_type)
WHERE status='active';

-- A single paid order item cannot silently point to multiple entitlements.
-- The index is partial for legacy, gift and subscription entitlements.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlements_order_item_lineage
ON entitlements(order_item_id)
WHERE order_item_id IS NOT NULL;
