-- ISOLATED QA ONLY. This schema MUST NEVER be applied to production D1.
-- It is separate from the sealed, negative-only cove_qa_owner_primary_publication_fence.
-- The QA owner currently has NO positive certificate route; no production grant
-- or storefront read is authorized by passing this SQLite fixture.
CREATE TABLE products(id TEXT PRIMARY KEY,storefront_status TEXT NOT NULL);
CREATE TABLE rights_grants(product_id TEXT NOT NULL,territory TEXT NOT NULL,
 status TEXT NOT NULL,decision TEXT NOT NULL);
CREATE VIEW retail_product_availability_rows AS
 SELECT p.id product_id,g.territory territory_code
 FROM products p JOIN rights_grants g ON g.product_id=p.id
 WHERE p.storefront_status='active' AND g.status='active' AND g.decision='allow'
   AND NOT EXISTS(SELECT 1 FROM rights_grants d
     WHERE d.product_id=g.product_id AND d.territory=g.territory
       AND d.status='active' AND d.decision='deny');

CREATE TABLE cove_qa_owner_positive_source_revision(
 slot INTEGER PRIMARY KEY CHECK(slot=1),
 revision INTEGER NOT NULL CHECK(revision>=1),
 dirty INTEGER NOT NULL CHECK(dirty IN (0,1))
);
INSERT INTO cove_qa_owner_positive_source_revision VALUES(1,7,0);

CREATE TABLE cove_qa_owner_positive_publication_fence(
 slot INTEGER PRIMARY KEY CHECK(slot=1),
 publication_schema TEXT NOT NULL CHECK(publication_schema='cove.qa.owner-positive-generation.v1'),
 primary_id TEXT NOT NULL CHECK(primary_id='7c7ab994-f6b3-419d-a72d-71eb9ea22e7e'),
 owner_journal_version TEXT NOT NULL CHECK(length(owner_journal_version)=64),
 owner_mutation_epoch INTEGER NOT NULL CHECK(owner_mutation_epoch>=0),
 owner_rehearsal_revision TEXT NOT NULL CHECK(owner_rehearsal_revision IN ('A','B')),
 source_revision INTEGER NOT NULL CHECK(source_revision>=0),
 active_generation INTEGER NOT NULL CHECK(active_generation>=0),
 manifest_sha256 TEXT NOT NULL,
 dirty INTEGER NOT NULL CHECK(dirty IN (0,1)),
 pending_withdrawals INTEGER NOT NULL CHECK(pending_withdrawals>=0),
 pending_writes INTEGER NOT NULL CHECK(pending_writes>=0),
 eligibility_valid_until_ms INTEGER NOT NULL CHECK(eligibility_valid_until_ms>=0),
 publication_revision INTEGER NOT NULL CHECK(publication_revision>=0)
);
INSERT INTO cove_qa_owner_positive_publication_fence VALUES (
 1,'cove.qa.owner-positive-generation.v1',
 '7c7ab994-f6b3-419d-a72d-71eb9ea22e7e',
 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
 4,'A',0,0,'',1,1,0,0,0
);
CREATE TABLE cove_qa_owner_positive_candidate(
 generation INTEGER PRIMARY KEY CHECK(generation>0),
 primary_id TEXT NOT NULL,
 owner_journal_version TEXT NOT NULL,
 owner_epoch INTEGER NOT NULL,
 owner_rehearsal_revision TEXT NOT NULL,
 source_revision INTEGER NOT NULL,
 manifest_sha256 TEXT NOT NULL,
 territory TEXT NOT NULL CHECK(territory='US'),
 catalog_rows INTEGER NOT NULL,
 allow_rows INTEGER NOT NULL,
 deny_rows INTEGER NOT NULL,
 eligibility_valid_until_ms INTEGER NOT NULL,
 sealed INTEGER NOT NULL CHECK(sealed IN (0,1)),
 dirty INTEGER NOT NULL CHECK(dirty IN (0,1))
);
CREATE TABLE cove_qa_owner_positive_candidate_products(
 generation INTEGER NOT NULL,
 product_id TEXT NOT NULL,
 territory TEXT NOT NULL,
 allowed INTEGER NOT NULL CHECK(allowed IN (0,1)),
 proof_sha256 TEXT NOT NULL CHECK(length(proof_sha256)=64),
 PRIMARY KEY(generation,product_id,territory)
) WITHOUT ROWID;
INSERT INTO products VALUES('p1','active'),('p2','active'),('p3','active');
INSERT INTO rights_grants VALUES('p1','US','active','allow'),('p2','US','active','allow'),
 ('p3','US','suspended','allow');
INSERT INTO cove_qa_owner_positive_candidate_products VALUES
 (9,'p1','US',1,'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'),
 (9,'p2','US',1,'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),
 (9,'p3','US',0,'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
INSERT INTO cove_qa_owner_positive_candidate VALUES(
 9,'7c7ab994-f6b3-419d-a72d-71eb9ea22e7e',
 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
 5,'A',7,
 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
 'US',3,2,1,9999999999999,1,0
);
-- Sealed candidates cannot be edited after positive owner verification.
CREATE TRIGGER cove_qa_positive_candidate_immutable
 BEFORE UPDATE ON cove_qa_owner_positive_candidate
 BEGIN SELECT RAISE(ABORT,'qa_candidate_sealed'); END;
CREATE TRIGGER cove_qa_positive_candidate_no_delete
 BEFORE DELETE ON cove_qa_owner_positive_candidate
 BEGIN SELECT RAISE(ABORT,'qa_candidate_sealed'); END;
CREATE TRIGGER cove_qa_positive_row_immutable
 BEFORE UPDATE ON cove_qa_owner_positive_candidate_products
 BEGIN SELECT RAISE(ABORT,'qa_candidate_sealed'); END;
CREATE TRIGGER cove_qa_positive_row_no_delete
 BEFORE DELETE ON cove_qa_owner_positive_candidate_products
 BEGIN SELECT RAISE(ABORT,'qa_candidate_sealed'); END;
CREATE TRIGGER cove_qa_positive_row_no_append
 BEFORE INSERT ON cove_qa_owner_positive_candidate_products
 WHEN EXISTS(SELECT 1 FROM cove_qa_owner_positive_candidate
             WHERE generation=NEW.generation AND sealed=1)
 BEGIN SELECT RAISE(ABORT,'qa_candidate_sealed'); END;

-- A covered source mutation bumps revision and immediately invalidates an
-- already-committed positive pointer IN THE SAME SQLITE TRANSACTION.
CREATE TRIGGER cove_qa_positive_source_updated AFTER UPDATE ON rights_grants
 BEGIN
   UPDATE cove_qa_owner_positive_source_revision SET revision=revision+1 WHERE slot=1;
   UPDATE cove_qa_owner_positive_publication_fence
      SET dirty=1,eligibility_valid_until_ms=0,
          publication_revision=publication_revision+1
      WHERE slot=1 AND dirty=0;
 END;
CREATE TRIGGER cove_qa_positive_source_inserted AFTER INSERT ON rights_grants
 BEGIN
   UPDATE cove_qa_owner_positive_source_revision SET revision=revision+1 WHERE slot=1;
   UPDATE cove_qa_owner_positive_publication_fence
      SET dirty=1,eligibility_valid_until_ms=0,
          publication_revision=publication_revision+1
      WHERE slot=1 AND dirty=0;
 END;
CREATE TRIGGER cove_qa_positive_source_deleted AFTER DELETE ON rights_grants
 BEGIN
   UPDATE cove_qa_owner_positive_source_revision SET revision=revision+1 WHERE slot=1;
   UPDATE cove_qa_owner_positive_publication_fence
      SET dirty=1,eligibility_valid_until_ms=0,
          publication_revision=publication_revision+1
      WHERE slot=1 AND dirty=0;
 END;
-- Invalidations are permitted; positive changes still require all reviewed
-- fields to move together. The CAS WHERE is the authoritative proof boundary.
CREATE TRIGGER cove_qa_positive_fence_update
 BEFORE UPDATE ON cove_qa_owner_positive_publication_fence
 WHEN NOT (
   (OLD.dirty=1 AND NEW.dirty=0
    AND NEW.slot=OLD.slot AND NEW.publication_schema=OLD.publication_schema
    AND NEW.primary_id=OLD.primary_id
    AND NEW.owner_journal_version=OLD.owner_journal_version
    AND NEW.owner_rehearsal_revision=OLD.owner_rehearsal_revision
    AND NEW.owner_mutation_epoch>=OLD.owner_mutation_epoch
    AND NEW.active_generation>OLD.active_generation
    AND NEW.pending_withdrawals=0 AND NEW.pending_writes=0
    AND NEW.eligibility_valid_until_ms>0
    AND length(NEW.manifest_sha256)=64
    AND NEW.publication_revision=OLD.publication_revision+1)
   OR
   (OLD.dirty=0 AND NEW.dirty=1
    AND NEW.slot=OLD.slot AND NEW.publication_schema=OLD.publication_schema
    AND NEW.primary_id=OLD.primary_id
    AND NEW.owner_journal_version=OLD.owner_journal_version
    AND NEW.owner_rehearsal_revision=OLD.owner_rehearsal_revision
    AND NEW.owner_mutation_epoch=OLD.owner_mutation_epoch
    AND NEW.source_revision=OLD.source_revision
    AND NEW.active_generation=OLD.active_generation
    AND NEW.manifest_sha256=OLD.manifest_sha256
    AND NEW.pending_withdrawals=OLD.pending_withdrawals
    AND NEW.pending_writes=OLD.pending_writes
    AND NEW.eligibility_valid_until_ms=0
    AND NEW.publication_revision=OLD.publication_revision+1)
 )
 BEGIN SELECT RAISE(ABORT,'qa_positive_generation_update_denied'); END;
CREATE TRIGGER cove_qa_positive_fence_insert
 BEFORE INSERT ON cove_qa_owner_positive_publication_fence
 BEGIN SELECT RAISE(ABORT,'qa_positive_reenrollment_forbidden'); END;
CREATE TRIGGER cove_qa_positive_fence_delete
 BEFORE DELETE ON cove_qa_owner_positive_publication_fence
 BEGIN SELECT RAISE(ABORT,'qa_positive_delete_forbidden'); END;
