-- Distributed claims and fencing for scheduled catalog work.
ALTER TABLE catalog_state ADD COLUMN lease_token TEXT;
ALTER TABLE catalog_state ADD COLUMN lease_until TEXT;
ALTER TABLE search_index_state ADD COLUMN sync_lease_token TEXT;
ALTER TABLE search_index_state ADD COLUMN sync_lease_until TEXT;
ALTER TABLE gutenberg_source_states ADD COLUMN epub_last_attempt_at TEXT;

-- Each outbox change gets a fresh token, including changes in the same second.
ALTER TABLE search_index_outbox ADD COLUMN change_token TEXT NOT NULL DEFAULT '';
CREATE TRIGGER trg_search_outbox_insert_token AFTER INSERT ON search_index_outbox BEGIN
  UPDATE search_index_outbox SET change_token=lower(hex(randomblob(16))) WHERE product_id=NEW.product_id;
END;
CREATE TRIGGER trg_search_outbox_update_token AFTER UPDATE OF operation,queued_at ON search_index_outbox BEGIN
  UPDATE search_index_outbox SET change_token=lower(hex(randomblob(16))) WHERE product_id=NEW.product_id;
END;
UPDATE search_index_outbox SET change_token=lower(hex(randomblob(16))) WHERE change_token='';
CREATE INDEX idx_search_outbox_queue ON search_index_outbox(queued_at,product_id);
CREATE INDEX idx_api_cache_expiry ON api_cache(expires_at);
