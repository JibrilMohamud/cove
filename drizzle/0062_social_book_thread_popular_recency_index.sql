-- Separate newest-first keyset index for book threads. Do not duplicate
-- 0061's popularity index: every redundant index raises primary D1 write cost.
CREATE INDEX IF NOT EXISTS idx_social_book_threads_recent ON social_posts(context_type,context_id,parent_id,created_at DESC,id DESC) WHERE deleted_at IS NULL AND moderation_status='visible';
