-- SYNTHETIC FIXTURE ONLY. Do NOT include this SQL in production migrations.
-- Database e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3 ONLY.
-- Public descriptive/license/AI metadata is usable only while a live D1
-- statement proves its R2 snapshot revision equals this monotonic generation.
-- Retail rights, pricing and protected asset authorization remain independently live.
CREATE TABLE IF NOT EXISTS cove_synthetic_public_metadata_revision (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id=1),
  revision INTEGER NOT NULL CHECK (revision>0)
);

INSERT OR IGNORE INTO cove_synthetic_public_metadata_revision(id,revision) VALUES(1,1);

CREATE TRIGGER IF NOT EXISTS cove_syn_metadata_gutenberg_attr_update
AFTER UPDATE OF id,source_project,source_url,source_license_url ON gutenberg_source_cache
WHEN OLD.id IS NOT NEW.id
  OR OLD.source_project IS NOT NEW.source_project
  OR OLD.source_url IS NOT NEW.source_url
  OR OLD.source_license_url IS NOT NEW.source_license_url
BEGIN
  UPDATE cove_synthetic_public_metadata_revision SET revision=revision+1 WHERE id=1;
END;

CREATE TRIGGER IF NOT EXISTS cove_syn_metadata_gutenberg_insert
AFTER INSERT ON gutenberg_source_cache
BEGIN
  UPDATE cove_synthetic_public_metadata_revision SET revision=revision+1 WHERE id=1;
END;

CREATE TRIGGER IF NOT EXISTS cove_syn_metadata_gutenberg_delete
AFTER DELETE ON gutenberg_source_cache
BEGIN
  UPDATE cove_synthetic_public_metadata_revision SET revision=revision+1 WHERE id=1;
END;

CREATE TRIGGER IF NOT EXISTS cove_syn_metadata_disclosures_insert
AFTER INSERT ON publishing_publication_disclosures
BEGIN
  UPDATE cove_synthetic_public_metadata_revision SET revision=revision+1 WHERE id=1;
END;

CREATE TRIGGER IF NOT EXISTS cove_syn_metadata_disclosures_delete
AFTER DELETE ON publishing_publication_disclosures
BEGIN
  UPDATE cove_synthetic_public_metadata_revision SET revision=revision+1 WHERE id=1;
END;

CREATE TRIGGER IF NOT EXISTS cove_syn_metadata_disclosures_update
AFTER UPDATE ON publishing_publication_disclosures
WHEN OLD.ai_disclosure_id IS NOT NEW.ai_disclosure_id
  OR OLD.policy_version IS NOT NEW.policy_version
  OR OLD.text_origin IS NOT NEW.text_origin
  OR OLD.cover_origin IS NOT NEW.cover_origin
  OR OLD.narration_origin IS NOT NEW.narration_origin
  OR OLD.translation_origin IS NOT NEW.translation_origin
  OR OLD.synthetic_voice_label IS NOT NEW.synthetic_voice_label
  OR OLD.public_badges_json IS NOT NEW.public_badges_json
  OR OLD.publication_version_id IS NOT NEW.publication_version_id
BEGIN
  UPDATE cove_synthetic_public_metadata_revision SET revision=revision+1 WHERE id=1;
END;

CREATE TRIGGER IF NOT EXISTS cove_syn_metadata_lifecycle_insert
AFTER INSERT ON publishing_release_lifecycles
BEGIN
  UPDATE cove_synthetic_public_metadata_revision SET revision=revision+1 WHERE id=1;
END;

CREATE TRIGGER IF NOT EXISTS cove_syn_metadata_lifecycle_delete
AFTER DELETE ON publishing_release_lifecycles
BEGIN
  UPDATE cove_synthetic_public_metadata_revision SET revision=revision+1 WHERE id=1;
END;

CREATE TRIGGER IF NOT EXISTS cove_syn_metadata_lifecycle_update
AFTER UPDATE OF current_publication_version_id,publishing_edition_id ON publishing_release_lifecycles
WHEN OLD.current_publication_version_id IS NOT NEW.current_publication_version_id
  OR OLD.publishing_edition_id IS NOT NEW.publishing_edition_id
BEGIN
  UPDATE cove_synthetic_public_metadata_revision SET revision=revision+1 WHERE id=1;
END;

CREATE TRIGGER IF NOT EXISTS cove_syn_metadata_publications_insert
AFTER INSERT ON publishing_publications
BEGIN
  UPDATE cove_synthetic_public_metadata_revision SET revision=revision+1 WHERE id=1;
END;

CREATE TRIGGER IF NOT EXISTS cove_syn_metadata_publications_delete
AFTER DELETE ON publishing_publications
BEGIN
  UPDATE cove_synthetic_public_metadata_revision SET revision=revision+1 WHERE id=1;
END;

CREATE TRIGGER IF NOT EXISTS cove_syn_metadata_publications_update
AFTER UPDATE OF product_id,edition_id,id ON publishing_publications
WHEN OLD.product_id IS NOT NEW.product_id
  OR OLD.edition_id IS NOT NEW.edition_id
  OR OLD.id IS NOT NEW.id
BEGIN
  UPDATE cove_synthetic_public_metadata_revision SET revision=revision+1 WHERE id=1;
END;

CREATE TRIGGER IF NOT EXISTS cove_syn_metadata_versions_insert
AFTER INSERT ON publishing_publication_versions
BEGIN
  UPDATE cove_synthetic_public_metadata_revision SET revision=revision+1 WHERE id=1;
END;

CREATE TRIGGER IF NOT EXISTS cove_syn_metadata_versions_delete
AFTER DELETE ON publishing_publication_versions
BEGIN
  UPDATE cove_synthetic_public_metadata_revision SET revision=revision+1 WHERE id=1;
END;

CREATE TRIGGER IF NOT EXISTS cove_syn_metadata_versions_update
AFTER UPDATE OF publication_id,lifecycle_id,id ON publishing_publication_versions
WHEN OLD.publication_id IS NOT NEW.publication_id
  OR OLD.lifecycle_id IS NOT NEW.lifecycle_id
  OR OLD.id IS NOT NEW.id
BEGIN
  UPDATE cove_synthetic_public_metadata_revision SET revision=revision+1 WHERE id=1;
END;
