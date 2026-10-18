-- Index exact newest/added sort semantics, including fallback for any future
-- row missing product_created_at. The current 53k-row catalog has no NULLs,
-- but removing COALESCE from the application would silently reorder future
-- imported books. This additive index never changes rights, grants, or data.
-- See scripts/check-catalog-added-sort-index.mjs for migration and tie cases.
CREATE INDEX IF NOT EXISTS idx_search_added_effective_stable
  ON catalog_search_documents(
    COALESCE(product_created_at, first_ingested_at) DESC,
    external_book_id DESC,
    product_id ASC
  );
