-- A highlight may be published to multiple independent audiences. Keep each publication
-- addressable and snapshot the exact note the owner explicitly chose to publish.
DROP TRIGGER IF EXISTS trg_annotation_share_live_insert;
DROP TRIGGER IF EXISTS trg_annotation_share_live_update;
DROP TRIGGER IF EXISTS trg_annotation_delete_withdraw;
DROP TRIGGER IF EXISTS trg_annotation_share_withdraw;
DROP TRIGGER IF EXISTS trg_annotation_share_audience_change;
DROP TRIGGER IF EXISTS trg_direct_highlight_insert;
DROP TRIGGER IF EXISTS trg_direct_highlight_update;
DROP TRIGGER IF EXISTS trg_direct_highlight_withdraw;
DROP TRIGGER IF EXISTS trg_group_highlight_insert;
DROP TRIGGER IF EXISTS trg_group_highlight_update;
DROP TRIGGER IF EXISTS trg_highlight_share_key_insert;
DROP TRIGGER IF EXISTS trg_highlight_share_key_update;

DROP INDEX IF EXISTS idx_annotation_shares_product;
DROP INDEX IF EXISTS idx_annotation_shares_work;
DROP INDEX IF EXISTS idx_highlight_recipient;

ALTER TABLE social_annotation_shares RENAME TO social_annotation_shares_v47;

CREATE TABLE social_annotation_shares (
  id TEXT PRIMARY KEY NOT NULL,
  annotation_id TEXT NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  work_id TEXT REFERENCES works(id) ON DELETE SET NULL,
  visibility TEXT NOT NULL CHECK(visibility IN ('public','followers','friends','group')),
  audience_group_id TEXT,
  recipient_user_id TEXT,
  share_key TEXT NOT NULL,
  share_note INTEGER NOT NULL DEFAULT 0 CHECK(share_note IN (0,1)),
  note_snapshot TEXT NOT NULL DEFAULT '',
  progress REAL NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 1),
  passage_hash TEXT NOT NULL,
  moderation_status TEXT NOT NULL DEFAULT 'visible' CHECK(moderation_status IN ('visible','limited','hidden','removed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  UNIQUE(annotation_id,share_key),
  CHECK((visibility='group' AND audience_group_id IS NOT NULL) OR (visibility<>'group' AND audience_group_id IS NULL)),
  CHECK(recipient_user_id IS NULL OR (visibility='friends' AND audience_group_id IS NULL)),
  CHECK(share_note=1 OR note_snapshot='')
);

INSERT INTO social_annotation_shares(
  id,annotation_id,user_id,product_id,work_id,visibility,audience_group_id,recipient_user_id,
  share_key,share_note,note_snapshot,progress,passage_hash,moderation_status,created_at,updated_at,version
)
SELECT
  'ashare_'||lower(hex(randomblob(16))),s.annotation_id,s.user_id,s.product_id,s.work_id,
  s.visibility,s.audience_group_id,s.recipient_user_id,
  CASE
    WHEN s.recipient_user_id IS NOT NULL THEN 'member:'||s.recipient_user_id
    WHEN s.visibility='group' THEN 'group:'||s.audience_group_id
    ELSE s.visibility
  END,
  s.share_note,CASE WHEN s.share_note=1 THEN COALESCE(a.note,'') ELSE '' END,
  s.progress,s.passage_hash,s.moderation_status,s.created_at,s.updated_at,s.version
FROM social_annotation_shares_v47 s
JOIN annotations a ON a.id=s.annotation_id AND a.user_id=s.user_id AND a.deleted_at IS NULL;

DROP TABLE social_annotation_shares_v47;

CREATE INDEX idx_annotation_shares_product ON social_annotation_shares(product_id,progress,visibility,moderation_status);
CREATE INDEX idx_annotation_shares_work ON social_annotation_shares(work_id,visibility,moderation_status);
CREATE INDEX idx_highlight_recipient ON social_annotation_shares(recipient_user_id,updated_at DESC,annotation_id,id);
CREATE INDEX idx_annotation_shares_annotation ON social_annotation_shares(annotation_id,user_id,updated_at DESC);

CREATE TRIGGER trg_annotation_share_live_insert BEFORE INSERT ON social_annotation_shares BEGIN
  SELECT RAISE(ABORT,'Cannot share a missing, deleted, or foreign annotation')
    WHERE NOT EXISTS(SELECT 1 FROM annotations WHERE id=NEW.annotation_id AND user_id=NEW.user_id AND deleted_at IS NULL);
END;
CREATE TRIGGER trg_annotation_share_live_update BEFORE UPDATE ON social_annotation_shares BEGIN
  SELECT RAISE(ABORT,'Cannot share a missing, deleted, or foreign annotation')
    WHERE NOT EXISTS(SELECT 1 FROM annotations WHERE id=NEW.annotation_id AND user_id=NEW.user_id AND deleted_at IS NULL);
END;

CREATE TRIGGER trg_highlight_share_key_insert BEFORE INSERT ON social_annotation_shares BEGIN
  SELECT RAISE(ABORT,'Invalid highlight audience key')
    WHERE NEW.share_key <> CASE
      WHEN NEW.recipient_user_id IS NOT NULL THEN 'member:'||NEW.recipient_user_id
      WHEN NEW.visibility='group' THEN 'group:'||NEW.audience_group_id
      ELSE NEW.visibility
    END;
END;
CREATE TRIGGER trg_highlight_share_key_update BEFORE UPDATE OF share_key,visibility,audience_group_id,recipient_user_id ON social_annotation_shares BEGIN
  SELECT RAISE(ABORT,'Invalid highlight audience key')
    WHERE NEW.share_key <> CASE
      WHEN NEW.recipient_user_id IS NOT NULL THEN 'member:'||NEW.recipient_user_id
      WHEN NEW.visibility='group' THEN 'group:'||NEW.audience_group_id
      ELSE NEW.visibility
    END;
END;

CREATE TRIGGER trg_direct_highlight_insert BEFORE INSERT ON social_annotation_shares WHEN NEW.recipient_user_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT,'Invalid direct highlight audience')
    WHERE NEW.visibility<>'friends' OR NEW.audience_group_id IS NOT NULL OR NEW.recipient_user_id=NEW.user_id
      OR NOT EXISTS(SELECT 1 FROM auth_accounts WHERE app_id=NEW.recipient_user_id AND username IS NOT NULL);
END;
CREATE TRIGGER trg_direct_highlight_update BEFORE UPDATE ON social_annotation_shares WHEN NEW.recipient_user_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT,'Invalid direct highlight audience')
    WHERE NEW.visibility<>'friends' OR NEW.audience_group_id IS NOT NULL OR NEW.recipient_user_id=NEW.user_id
      OR NOT EXISTS(SELECT 1 FROM auth_accounts WHERE app_id=NEW.recipient_user_id AND username IS NOT NULL);
END;
CREATE TRIGGER trg_group_highlight_insert BEFORE INSERT ON social_annotation_shares WHEN NEW.visibility='group' BEGIN
  SELECT RAISE(ABORT,'Reading-group highlights require an active group membership')
    WHERE NEW.audience_group_id IS NULL OR NOT EXISTS(
      SELECT 1 FROM reading_group_members WHERE group_id=NEW.audience_group_id AND user_id=NEW.user_id AND status='active'
    );
END;
CREATE TRIGGER trg_group_highlight_update BEFORE UPDATE OF visibility,audience_group_id ON social_annotation_shares WHEN NEW.visibility='group' BEGIN
  SELECT RAISE(ABORT,'Reading-group highlights require an active group membership')
    WHERE NEW.audience_group_id IS NULL OR NOT EXISTS(
      SELECT 1 FROM reading_group_members WHERE group_id=NEW.audience_group_id AND user_id=NEW.user_id AND status='active'
    );
END;

CREATE TRIGGER trg_annotation_delete_withdraw AFTER UPDATE OF deleted_at ON annotations WHEN NEW.deleted_at IS NOT NULL BEGIN
  DELETE FROM social_annotation_shares WHERE annotation_id=NEW.id;
  UPDATE social_events SET moderation_status='removed',payload_json='{}'
    WHERE event_type='shared_highlight' AND entity_id=NEW.id;
END;
CREATE TRIGGER trg_annotation_share_withdraw AFTER DELETE ON social_annotation_shares BEGIN
  UPDATE social_events SET moderation_status='removed',payload_json='{}'
    WHERE event_type='shared_highlight' AND entity_id=OLD.annotation_id;
END;
CREATE TRIGGER trg_annotation_share_audience_change AFTER UPDATE OF visibility,audience_group_id,share_note,note_snapshot,progress,recipient_user_id,share_key ON social_annotation_shares BEGIN
  UPDATE social_events SET moderation_status='removed',payload_json='{}'
    WHERE event_type='shared_highlight' AND entity_id=NEW.annotation_id;
END;
CREATE TRIGGER trg_direct_highlight_withdraw AFTER UPDATE OF recipient_user_id ON social_annotation_shares BEGIN
  UPDATE social_events SET moderation_status='removed',payload_json='{}'
    WHERE event_type='shared_highlight' AND entity_id=NEW.annotation_id;
END;
