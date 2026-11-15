-- COVE SYNTHETIC D1 ONLY: e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3
-- NO PRODUCTION DATABASE OR WRITER IS AUTHORIZED TO EXECUTE THIS FILE.
-- A deterministic, idempotent retail catalog fixture. Existing 50k products,
-- title/ranking and existing rights rows are unchanged. One CURRENT retail offer
-- per top-96 candidate; inactive and expired offers are negative witnesses.
-- The SQL deliberately does not create entitlements, purchases or payment data.
INSERT OR IGNORE INTO offers
  (id, product_id, offer_type, currency, amount_minor, active,
   starts_at, ends_at, created_at, updated_at, sales_channel)
WITH ranked AS MATERIALIZED (
  SELECT d.product_id,
    ROW_NUMBER() OVER (
      ORDER BY d.fore_bestseller_score DESC,d.external_book_id ASC,d.product_id ASC
    ) AS ordinal
  FROM catalog_search_documents d INDEXED BY idx_search_popular_stable
  ORDER BY d.fore_bestseller_score DESC,d.external_book_id ASC,d.product_id ASC
  LIMIT 96
)
SELECT
  'perf-retail-active-' || product_id,
  product_id,'purchase','USD',
  CASE ordinal % 5 WHEN 0 THEN 0 WHEN 1 THEN 399
    WHEN 2 THEN 999 WHEN 3 THEN 1499 ELSE 2399 END,
  1,'2025-01-01 00:00:00',NULL,'2026-01-01 00:00:00',
  '2026-01-01 00:00:00','retail'
FROM ranked;

INSERT OR IGNORE INTO offers
  (id, product_id, offer_type, currency, amount_minor, active,
   starts_at, ends_at, created_at, updated_at, sales_channel)
WITH ranked AS MATERIALIZED (
  SELECT d.product_id,
    ROW_NUMBER() OVER (
      ORDER BY d.fore_bestseller_score DESC,d.external_book_id ASC,d.product_id ASC
    ) AS ordinal
  FROM catalog_search_documents d INDEXED BY idx_search_popular_stable
  ORDER BY d.fore_bestseller_score DESC,d.external_book_id ASC,d.product_id ASC
  LIMIT 96
)
SELECT
  'perf-retail-inactive-' || product_id,
  product_id,'purchase','USD',19999,0,
  '2025-01-01 00:00:00',NULL,'2026-06-01 00:00:00',
  '2026-06-01 00:00:00','retail'
FROM ranked WHERE ordinal % 8 = 0;

INSERT OR IGNORE INTO offers
  (id, product_id, offer_type, currency, amount_minor, active,
   starts_at, ends_at, created_at, updated_at, sales_channel)
WITH ranked AS MATERIALIZED (
  SELECT d.product_id,
    ROW_NUMBER() OVER (
      ORDER BY d.fore_bestseller_score DESC,d.external_book_id ASC,d.product_id ASC
    ) AS ordinal
  FROM catalog_search_documents d INDEXED BY idx_search_popular_stable
  ORDER BY d.fore_bestseller_score DESC,d.external_book_id ASC,d.product_id ASC
  LIMIT 96
)
SELECT
  'perf-retail-expired-' || product_id,
  product_id,'purchase','USD',29999,1,
  '2025-01-01 00:00:00','2025-06-01 00:00:00',
  '2026-07-01 00:00:00','2026-07-01 00:00:00','retail'
FROM ranked WHERE ordinal % 8 = 0;
