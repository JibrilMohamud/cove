-- Give previously exhausted *transient* US network timeouts a bounded
-- recovery window. This never reopens quarantined items, missing assets,
-- oversized EPUBs, or copyright/permission-only exceptions.
-- The current retry policy allows up to twelve attempts for timeout errors.
UPDATE gutenberg_source_cache
SET epub_status='retry',
    epub_next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'),
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE source_id='pg_us'
  AND epub_status='failed'
  AND epub_attempts=8
  AND epub_last_error='The operation was aborted due to timeout'
  AND ingest_status='active'
  AND rights_status='public-domain';
