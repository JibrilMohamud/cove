-- Explicit recipient grants override the legacy audience classification.
ALTER TABLE social_annotation_shares ADD COLUMN recipient_user_id TEXT;
ALTER TABLE social_annotation_shares ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version>0);
ALTER TABLE social_posts ADD COLUMN recipient_user_id TEXT;
ALTER TABLE social_profiles ADD COLUMN direct_sharing_policy TEXT NOT NULL DEFAULT 'members' CHECK(direct_sharing_policy IN ('members','following','mutuals','none'));
CREATE INDEX idx_highlight_recipient ON social_annotation_shares(recipient_user_id,updated_at DESC,annotation_id);
CREATE INDEX idx_margin_recipient ON social_posts(recipient_user_id,updated_at DESC,id) WHERE context_type='margin';
CREATE TRIGGER trg_direct_highlight_insert BEFORE INSERT ON social_annotation_shares WHEN NEW.recipient_user_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT,'Invalid direct highlight audience') WHERE NEW.visibility<>'friends' OR NEW.audience_group_id IS NOT NULL OR NEW.recipient_user_id=NEW.user_id OR NOT EXISTS(SELECT 1 FROM auth_accounts WHERE app_id=NEW.recipient_user_id AND username IS NOT NULL);
END;
CREATE TRIGGER trg_direct_highlight_update BEFORE UPDATE ON social_annotation_shares WHEN NEW.recipient_user_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT,'Invalid direct highlight audience') WHERE NEW.visibility<>'friends' OR NEW.audience_group_id IS NOT NULL OR NEW.recipient_user_id=NEW.user_id OR NOT EXISTS(SELECT 1 FROM auth_accounts WHERE app_id=NEW.recipient_user_id AND username IS NOT NULL);
END;
CREATE TRIGGER trg_direct_highlight_withdraw AFTER UPDATE OF recipient_user_id ON social_annotation_shares BEGIN
  UPDATE social_events SET moderation_status='removed',payload_json='{}' WHERE event_type='shared_highlight' AND entity_id=NEW.annotation_id;
END;
-- Never guess a group for older orphaned conversations.
UPDATE social_posts SET moderation_status='hidden' WHERE visibility='group' AND group_id IS NULL;
CREATE TRIGGER trg_margin_group_insert BEFORE INSERT ON social_posts WHEN NEW.visibility='group' BEGIN
  SELECT RAISE(ABORT,'Group conversations require a group') WHERE NEW.group_id IS NULL OR NOT EXISTS(SELECT 1 FROM reading_group_members WHERE group_id=NEW.group_id AND user_id=NEW.user_id AND status='active');
END;
CREATE TRIGGER trg_margin_group_update BEFORE UPDATE OF group_id,visibility ON social_posts WHEN NEW.visibility='group' BEGIN
  SELECT RAISE(ABORT,'Group conversations require a group') WHERE NEW.group_id IS NULL OR NOT EXISTS(SELECT 1 FROM reading_group_members WHERE group_id=NEW.group_id AND user_id=NEW.user_id AND status='active');
END;
CREATE TRIGGER trg_direct_margin_insert BEFORE INSERT ON social_posts WHEN NEW.recipient_user_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT,'Invalid direct discussion audience') WHERE NEW.context_type<>'margin' OR NEW.visibility<>'private' OR NEW.group_id IS NOT NULL OR NEW.recipient_user_id=NEW.user_id;
END;
CREATE TRIGGER trg_direct_margin_update BEFORE UPDATE OF recipient_user_id,visibility,group_id ON social_posts WHEN NEW.recipient_user_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT,'Invalid direct discussion audience') WHERE NEW.context_type<>'margin' OR NEW.visibility<>'private' OR NEW.group_id IS NOT NULL OR NEW.recipient_user_id=NEW.user_id;
END;
CREATE TRIGGER trg_margin_withdraw AFTER UPDATE OF deleted_at ON social_posts WHEN NEW.deleted_at IS NOT NULL BEGIN
  UPDATE social_events SET moderation_status='removed',payload_json='{}' WHERE event_type='discussion_started' AND entity_id=NEW.id;
  UPDATE social_posts SET deleted_at=COALESCE(deleted_at,NEW.deleted_at),body='[withdrawn]',passage_text='',updated_at=NEW.updated_at WHERE root_id=NEW.id OR parent_id=NEW.id;
END;
CREATE TRIGGER trg_margin_remove AFTER DELETE ON social_posts BEGIN
  UPDATE social_events SET moderation_status='removed',payload_json='{}' WHERE event_type='discussion_started' AND entity_id=OLD.id;
END;
UPDATE social_events SET moderation_status='removed',payload_json='{}' WHERE event_type='discussion_started' AND NOT EXISTS(SELECT 1 FROM social_posts p WHERE p.id=social_events.entity_id AND p.deleted_at IS NULL AND p.moderation_status='visible');
ALTER TABLE auth_accounts ADD COLUMN disabled_at TEXT;
ALTER TABLE account_deletion_requests ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE account_deletion_requests ADD COLUMN next_retry_at TEXT;
ALTER TABLE account_deletion_requests ADD COLUMN lease_expires_at TEXT;
ALTER TABLE account_deletion_requests ADD COLUMN lease_token TEXT;
ALTER TABLE account_deletion_requests ADD COLUMN last_error_code TEXT NOT NULL DEFAULT '';
ALTER TABLE account_deletion_requests ADD COLUMN cleanup_phase TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE account_deletion_requests ADD COLUMN object_keys_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE account_deletion_requests ADD COLUMN storage_erased_at TEXT;
ALTER TABLE account_deletion_requests ADD COLUMN database_erased_at TEXT;
ALTER TABLE account_deletion_requests ADD COLUMN identity_erased_at TEXT;
CREATE INDEX idx_erasure_retry ON account_deletion_requests(status,next_retry_at,lease_expires_at,execute_after);

-- Older completions did not prove external cleanup. Reconcile the legitimate requests.
UPDATE account_deletion_requests SET status='queued',completed_at=NULL,next_retry_at=NULL,cleanup_phase='pending' WHERE status='completed' AND user_id IN (SELECT app_id FROM auth_accounts);
