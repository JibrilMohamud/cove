-- Only owner-scoped completion markers are evidence for restart recovery.
-- Preserve them after issuance; historical unscoped publishing audit events
-- retain their existing behavior and cannot certify an owner command.
CREATE TRIGGER trg_owner_publication_completion_no_update
BEFORE UPDATE ON publishing_audit_events
WHEN OLD.action='published' AND json_type(OLD.metadata_json,'$.ownerCommandSha256')='text'
BEGIN SELECT RAISE(ABORT,'owner publication completion evidence is immutable'); END;
CREATE TRIGGER trg_owner_publication_completion_no_delete
BEFORE DELETE ON publishing_audit_events
WHEN OLD.action='published' AND json_type(OLD.metadata_json,'$.ownerCommandSha256')='text'
BEGIN SELECT RAISE(ABORT,'owner publication completion evidence is immutable'); END;
