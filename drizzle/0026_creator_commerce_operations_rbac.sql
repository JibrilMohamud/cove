-- Creator commerce operations RBAC and auditable contract/tax-document provenance.

ALTER TABLE finance_royalty_contract_versions ADD COLUMN supersedes_version_id TEXT REFERENCES finance_royalty_contract_versions(id) ON DELETE RESTRICT;
ALTER TABLE finance_royalty_contract_versions ADD COLUMN created_by_user_id TEXT;
ALTER TABLE finance_royalty_contract_versions ADD COLUMN change_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE creator_tax_documents ADD COLUMN source_provider TEXT NOT NULL DEFAULT '';
ALTER TABLE creator_tax_documents ADD COLUMN source_reference TEXT NOT NULL DEFAULT '';
ALTER TABLE creator_tax_documents ADD COLUMN sha256 TEXT NOT NULL DEFAULT '';
ALTER TABLE creator_tax_documents ADD COLUMN mime_type TEXT NOT NULL DEFAULT 'application/pdf';

INSERT OR IGNORE INTO staff_roles(id,name,description) VALUES
 ('role_finance_ops','finance_ops','Manage contractual royalty versions, usage accounting, statements, and creator tax-document records.'),
 ('role_promotion_ops','promotion_ops','Review creator promotion submissions and operate merchandising campaigns.');

INSERT OR IGNORE INTO staff_role_permissions(role_id,permission) VALUES
 ('role_finance_ops','moderation.case.read'),
 ('role_finance_ops','finance.contract.manage'),
 ('role_finance_ops','finance.usage.ingest'),
 ('role_finance_ops','finance.statement.generate'),
 ('role_finance_ops','finance.metrics.refresh'),
 ('role_finance_ops','finance.tax_document.manage'),
 ('role_promotion_ops','moderation.case.read'),
 ('role_promotion_ops','promotions.review'),
 ('role_promotion_ops','promotions.operations.read'),
 ('role_moderation_admin','finance.contract.manage'),
 ('role_moderation_admin','finance.usage.ingest'),
 ('role_moderation_admin','finance.statement.generate'),
 ('role_moderation_admin','finance.metrics.refresh'),
 ('role_moderation_admin','finance.tax_document.manage'),
 ('role_moderation_admin','promotions.review'),
 ('role_moderation_admin','promotions.operations.read');

CREATE UNIQUE INDEX IF NOT EXISTS idx_creator_tax_documents_source
  ON creator_tax_documents(source_provider,source_reference)
  WHERE source_provider<>'' AND source_reference<>'';

-- Tax records and finalized commerce accounting evidence are append-only at the evidence layer.
CREATE TRIGGER IF NOT EXISTS trg_creator_tax_documents_identity_immutable
BEFORE UPDATE OF publishing_account_id,tax_year,jurisdiction,document_type,object_key,source_provider,source_reference,sha256,mime_type,created_at ON creator_tax_documents
BEGIN SELECT RAISE(ABORT,'tax document identity/evidence is immutable; create a corrected document record'); END;
CREATE TRIGGER IF NOT EXISTS trg_creator_tax_documents_no_delete
BEFORE DELETE ON creator_tax_documents
BEGIN SELECT RAISE(ABORT,'creator tax document records cannot be deleted'); END;
