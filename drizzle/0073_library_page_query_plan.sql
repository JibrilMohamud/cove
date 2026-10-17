-- Library membership checks must seek one user's entitlement for one product,
-- rather than scan that user's entire active library for every reading state.
CREATE INDEX IF NOT EXISTS idx_entitlements_library_access
  ON entitlements(user_id,product_id,status,starts_at,ends_at);

-- Tied timestamps are common in imports/restores. Keep the stable page order
-- in the index rather than sorting all of a reader's rows on every page.
CREATE INDEX IF NOT EXISTS idx_reading_states_library_page
  ON reading_states(user_id,in_library,updated_at DESC,product_id DESC);
