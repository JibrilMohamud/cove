-- Withdrawal is atomic with annotation/share changes, including non-HTTP writers.
CREATE TRIGGER trg_annotation_share_live_insert BEFORE INSERT ON social_annotation_shares BEGIN
  SELECT RAISE(ABORT,'Cannot share a missing, deleted, or foreign annotation')
    WHERE NOT EXISTS(SELECT 1 FROM annotations WHERE id=NEW.annotation_id AND user_id=NEW.user_id AND deleted_at IS NULL);
END;
CREATE TRIGGER trg_annotation_share_live_update BEFORE UPDATE ON social_annotation_shares BEGIN
  SELECT RAISE(ABORT,'Cannot share a missing, deleted, or foreign annotation')
    WHERE NOT EXISTS(SELECT 1 FROM annotations WHERE id=NEW.annotation_id AND user_id=NEW.user_id AND deleted_at IS NULL);
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
CREATE TRIGGER trg_annotation_share_audience_change AFTER UPDATE OF visibility,audience_group_id,share_note,progress ON social_annotation_shares BEGIN
  UPDATE social_events SET moderation_status='removed',payload_json='{}'
    WHERE event_type='shared_highlight' AND entity_id=NEW.annotation_id;
END;

-- Repair shares and historical feed copies left behind by earlier withdrawals.
DELETE FROM social_annotation_shares WHERE NOT EXISTS(
  SELECT 1 FROM annotations a WHERE a.id=social_annotation_shares.annotation_id
    AND a.user_id=social_annotation_shares.user_id AND a.deleted_at IS NULL
);
UPDATE social_events SET moderation_status='removed',payload_json='{}'
  WHERE event_type='shared_highlight' AND NOT EXISTS(
    SELECT 1 FROM social_annotation_shares s JOIN annotations a ON a.id=s.annotation_id
      WHERE s.annotation_id=social_events.entity_id AND s.user_id=social_events.user_id
        AND a.user_id=s.user_id AND a.deleted_at IS NULL AND s.moderation_status='visible'
        AND s.visibility IN ('public','followers')
  );
