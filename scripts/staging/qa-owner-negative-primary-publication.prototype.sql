-- ISOLATED QA ONLY. DO NOT ADD TO drizzle/ OR APPLY TO PRODUCTION.
-- Primary D1 requires separate protected ownership and exact QA database UUID.
-- This creates a SEALED negative-only record; no SQL here can authorize a book.
-- The two real QA DB identities are documented in the source and release tests.
-- This fixture uses the paid full-schema QA D1 ID. Never reuse a production ID.
CREATE TABLE cove_qa_owner_primary_publication_fence (
  slot INTEGER PRIMARY KEY CHECK(slot=1),
  publication_schema TEXT NOT NULL CHECK(publication_schema='cove.qa.owner-primary-read-bracket.v1'),
  primary_id TEXT NOT NULL CHECK(primary_id='7c7ab994-f6b3-419d-a72d-71eb9ea22e7e'),
  owner_journal_version TEXT NOT NULL CHECK(length(owner_journal_version)=64),
  owner_mutation_epoch INTEGER NOT NULL CHECK(typeof(owner_mutation_epoch)='integer' AND owner_mutation_epoch>=0 AND owner_mutation_epoch<=9007199254740991),
  owner_rehearsal_revision TEXT NOT NULL CHECK(owner_rehearsal_revision IN ('A','B')),
  dirty INTEGER NOT NULL CHECK(dirty IN (0,1)),
  pending_withdrawals INTEGER NOT NULL CHECK(typeof(pending_withdrawals)='integer' AND pending_withdrawals>=0 AND pending_withdrawals<=9007199254740991),
  pending_writes INTEGER NOT NULL CHECK(typeof(pending_writes)='integer' AND pending_writes>=0 AND pending_writes<=9007199254740991),
  eligibility_valid_until_ms INTEGER NOT NULL CHECK(typeof(eligibility_valid_until_ms)='integer' AND eligibility_valid_until_ms>=0),
  publication_revision INTEGER NOT NULL CHECK(typeof(publication_revision)='integer' AND publication_revision>=0 AND publication_revision<=9007199254740991)
);
INSERT INTO cove_qa_owner_primary_publication_fence (
  slot,publication_schema,primary_id,owner_journal_version,owner_mutation_epoch,
  owner_rehearsal_revision,dirty,pending_withdrawals,pending_writes,
  eligibility_valid_until_ms,publication_revision
) VALUES (
  1,'cove.qa.owner-primary-read-bracket.v1',
  '7c7ab994-f6b3-419d-a72d-71eb9ea22e7e',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  0,'A',1,1,0,0,0
);
-- A complete producer would separately prove a virgin owner, historical
-- initial state, triggers and all legal mutations before opening a grant.
-- THIS PROTOTYPE NEVER OPENS A GRANT. A later positive D1 update is refused.
CREATE TRIGGER cove_qa_negative_publication_update
BEFORE UPDATE ON cove_qa_owner_primary_publication_fence
WHEN NOT (
  NEW.slot=OLD.slot
  AND NEW.publication_schema=OLD.publication_schema
  AND NEW.primary_id=OLD.primary_id
  AND NEW.owner_journal_version=OLD.owner_journal_version
  AND NEW.owner_rehearsal_revision=OLD.owner_rehearsal_revision
  AND NEW.owner_mutation_epoch>OLD.owner_mutation_epoch
  AND NEW.dirty=1
  AND NEW.pending_withdrawals=OLD.pending_withdrawals+1
  AND NEW.pending_writes=OLD.pending_writes
  AND NEW.eligibility_valid_until_ms=0
  AND NEW.publication_revision=OLD.publication_revision+1
)
BEGIN
  SELECT RAISE(ABORT,'qa_negative_only_owner_publication_required');
END;
CREATE TRIGGER cove_qa_negative_publication_insert
BEFORE INSERT ON cove_qa_owner_primary_publication_fence
BEGIN
  SELECT RAISE(ABORT,'qa_primary_publication_reenrollment_forbidden');
END;
CREATE TRIGGER cove_qa_negative_publication_delete
BEFORE DELETE ON cove_qa_owner_primary_publication_fence
BEGIN
  SELECT RAISE(ABORT,'qa_primary_publication_delete_forbidden');
END;
