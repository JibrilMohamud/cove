-- Exact keyset for popular book discussions; stable under equal reaction totals.
-- Keep primary-D1 work bounded to the selected context and parent.
CREATE INDEX IF NOT EXISTS idx_social_book_threads_popular_recency ON social_posts(context_type,context_id,parent_id,reaction_count DESC,created_at DESC,id DESC) WHERE deleted_at IS NULL AND moderation_status='visible';
