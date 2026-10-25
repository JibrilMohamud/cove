-- A queued external-search UPSERT has no immutable payload: the consumer
-- loads the latest *canonical* search document from primary D1 when it runs.
-- Replacing the same pending event on every popularity/price update generates
-- unnecessary serialized primary-D1 writes while Meilisearch is unconfigured.
--
-- A single pending UPSERT is sufficient while backend='d1' and no external
-- indexing lease is active. When a worker holds an indexing lease, or when
-- Meilisearch is the active backend, ALWAYS advance the event/change_token:
-- that fences any remotely committed but stale in-flight snapshot. Missing
-- state rows default to conservative write-through, never to suppression.
--
-- Preserve legal tombstones, *fresh* events, and legitimately reinstated
-- products. No consumer-rights or delivered-content authorization is cached.
DROP TRIGGER IF EXISTS `catalog_search_au_outbox`;
--> statement-breakpoint
CREATE TRIGGER `catalog_search_au_outbox` AFTER UPDATE ON `catalog_search_documents` BEGIN
  INSERT INTO search_index_outbox(product_id,operation,queued_at,attempts,last_error)
  VALUES(new.product_id,'upsert',datetime('now'),0,'')
  ON CONFLICT(product_id) DO UPDATE SET operation='upsert',
    queued_at=excluded.queued_at,attempts=0,last_error=''
  WHERE
    -- Pending legal deletion remains authoritative unless genuinely restored.
    (search_index_outbox.operation<>'delete'
      OR (old.suppressed=1 AND new.suppressed=0 AND new.availability='available'))
    AND
    -- An existing UPSERT has no stale payload: indexing reads CURRENT rows.
    -- Never suppress refresh during an active external indexing lease; the
    -- new token must fence the older in-flight remote publication.
    (search_index_outbox.operation<>'upsert'
      OR COALESCE((SELECT backend FROM search_index_state WHERE id=1),'unknown')<>'d1'
      OR EXISTS(SELECT 1 FROM search_index_state
        WHERE id=1 AND sync_lease_token IS NOT NULL));
END;
