-- STAGING-ONLY PROTOTYPE. NEVER APPLY TO PRODUCTION OR PUT INTO drizzle/.
-- This is NOT authority to enable Cove's legal owner or create D1 write grants.
-- Every supported source mutation and generation change occurs in the same
-- SQLite transaction through triggers, including cascaded deletes.
-- Owner disabled/dirty by default; an independently reviewed cutover must
-- first attest exclusive physical writers and explicitly reconcile dirty state.
CREATE TABLE IF NOT EXISTS cove_seo_primary_fence (
  slot INTEGER PRIMARY KEY CHECK(slot=1),
  owner_version TEXT NOT NULL DEFAULT '',
  owner_denial_epoch INTEGER NOT NULL DEFAULT 0 CHECK(owner_denial_epoch>=0),
  catalog_generation INTEGER NOT NULL DEFAULT 0 CHECK(catalog_generation>=0),
  rights_generation INTEGER NOT NULL DEFAULT 0 CHECK(rights_generation>=0),
  withdrawal_generation INTEGER NOT NULL DEFAULT 0 CHECK(withdrawal_generation>=0),
  taxonomy_generation INTEGER NOT NULL DEFAULT 0 CHECK(taxonomy_generation>=0),
  contributor_generation INTEGER NOT NULL DEFAULT 0 CHECK(contributor_generation>=0),
  dirty INTEGER NOT NULL DEFAULT 1 CHECK(dirty IN (0,1)),
  pending_withdrawals INTEGER NOT NULL DEFAULT 0 CHECK(pending_withdrawals>=0),
  pending_writes INTEGER NOT NULL DEFAULT 0 CHECK(pending_writes>=0)
);
INSERT OR IGNORE INTO cove_seo_primary_fence(slot) VALUES(1);
CREATE TABLE IF NOT EXISTS cove_seo_count_snapshots (
  slot INTEGER PRIMARY KEY CHECK(slot=1),
  owner_version TEXT NOT NULL,
  owner_denial_epoch INTEGER NOT NULL CHECK(owner_denial_epoch>=0),
  catalog_generation INTEGER NOT NULL,
  rights_generation INTEGER NOT NULL,
  withdrawal_generation INTEGER NOT NULL,
  taxonomy_generation INTEGER NOT NULL,
  contributor_generation INTEGER NOT NULL,
  built_at_ms INTEGER NOT NULL CHECK(built_at_ms>=0),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>built_at_ms AND expires_at_ms<=built_at_ms+60000),
  books_count INTEGER NOT NULL CHECK(books_count>=0),
  works_count INTEGER NOT NULL CHECK(works_count>=0),
  editions_count INTEGER NOT NULL CHECK(editions_count>=0),
  authors_count INTEGER NOT NULL CHECK(authors_count>=0),
  categories_count INTEGER NOT NULL CHECK(categories_count>=0)
);

-- The DO deny epoch is NEVER advanced by these D1 triggers. An authorized
-- canonical owner must acknowledge and reconcile it after the Durable Object
-- denial is committed, and the private owner must be queried again before
-- any sitemap response. D1 is not authority for owner-denial recency.
-- No live owner ack adapter exists in this staged prototype.
-- Incomplete source/table inventory or an unported writer MUST keep dirty=1.
-- No generic admin command may set dirty=0; owner-enabled cutover is separate.
CREATE TRIGGER IF NOT EXISTS seo_gen_works_insert
AFTER INSERT ON works
BEGIN
  UPDATE cove_seo_primary_fence SET catalog_generation=catalog_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_works_update
AFTER UPDATE ON works
BEGIN
  UPDATE cove_seo_primary_fence SET catalog_generation=catalog_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_works_delete
AFTER DELETE ON works
BEGIN
  UPDATE cove_seo_primary_fence SET catalog_generation=catalog_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_editions_insert
AFTER INSERT ON editions
BEGIN
  UPDATE cove_seo_primary_fence SET catalog_generation=catalog_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_editions_update
AFTER UPDATE ON editions
BEGIN
  UPDATE cove_seo_primary_fence SET catalog_generation=catalog_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_editions_delete
AFTER DELETE ON editions
BEGIN
  UPDATE cove_seo_primary_fence SET catalog_generation=catalog_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_products_insert
AFTER INSERT ON products
BEGIN
  UPDATE cove_seo_primary_fence SET catalog_generation=catalog_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_products_update
AFTER UPDATE ON products
BEGIN
  UPDATE cove_seo_primary_fence SET catalog_generation=catalog_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_products_delete
AFTER DELETE ON products
BEGIN
  UPDATE cove_seo_primary_fence SET catalog_generation=catalog_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_contributors_insert
AFTER INSERT ON contributors
BEGIN
  UPDATE cove_seo_primary_fence SET contributor_generation=contributor_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_contributors_update
AFTER UPDATE ON contributors
BEGIN
  UPDATE cove_seo_primary_fence SET contributor_generation=contributor_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_contributors_delete
AFTER DELETE ON contributors
BEGIN
  UPDATE cove_seo_primary_fence SET contributor_generation=contributor_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_edition_contributors_insert
AFTER INSERT ON edition_contributors
BEGIN
  UPDATE cove_seo_primary_fence SET contributor_generation=contributor_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_edition_contributors_update
AFTER UPDATE ON edition_contributors
BEGIN
  UPDATE cove_seo_primary_fence SET contributor_generation=contributor_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_edition_contributors_delete
AFTER DELETE ON edition_contributors
BEGIN
  UPDATE cove_seo_primary_fence SET contributor_generation=contributor_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_work_contributors_insert
AFTER INSERT ON work_contributors
BEGIN
  UPDATE cove_seo_primary_fence SET contributor_generation=contributor_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_work_contributors_update
AFTER UPDATE ON work_contributors
BEGIN
  UPDATE cove_seo_primary_fence SET contributor_generation=contributor_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_work_contributors_delete
AFTER DELETE ON work_contributors
BEGIN
  UPDATE cove_seo_primary_fence SET contributor_generation=contributor_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_storefront_taxonomies_insert
AFTER INSERT ON storefront_taxonomies
BEGIN
  UPDATE cove_seo_primary_fence SET taxonomy_generation=taxonomy_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_storefront_taxonomies_update
AFTER UPDATE ON storefront_taxonomies
BEGIN
  UPDATE cove_seo_primary_fence SET taxonomy_generation=taxonomy_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_storefront_taxonomies_delete
AFTER DELETE ON storefront_taxonomies
BEGIN
  UPDATE cove_seo_primary_fence SET taxonomy_generation=taxonomy_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_storefront_taxonomy_nodes_insert
AFTER INSERT ON storefront_taxonomy_nodes
BEGIN
  UPDATE cove_seo_primary_fence SET taxonomy_generation=taxonomy_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_storefront_taxonomy_nodes_update
AFTER UPDATE ON storefront_taxonomy_nodes
BEGIN
  UPDATE cove_seo_primary_fence SET taxonomy_generation=taxonomy_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_storefront_taxonomy_nodes_delete
AFTER DELETE ON storefront_taxonomy_nodes
BEGIN
  UPDATE cove_seo_primary_fence SET taxonomy_generation=taxonomy_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_rights_grants_insert
AFTER INSERT ON rights_grants
BEGIN
  UPDATE cove_seo_primary_fence SET rights_generation=rights_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_rights_grants_update
AFTER UPDATE ON rights_grants
BEGIN
  UPDATE cove_seo_primary_fence SET rights_generation=rights_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_rights_grants_delete
AFTER DELETE ON rights_grants
BEGIN
  UPDATE cove_seo_primary_fence SET rights_generation=rights_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_rights_grant_territories_insert
AFTER INSERT ON rights_grant_territories
BEGIN
  UPDATE cove_seo_primary_fence SET rights_generation=rights_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_rights_grant_territories_update
AFTER UPDATE ON rights_grant_territories
BEGIN
  UPDATE cove_seo_primary_fence SET rights_generation=rights_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_rights_grant_territories_delete
AFTER DELETE ON rights_grant_territories
BEGIN
  UPDATE cove_seo_primary_fence SET rights_generation=rights_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_rights_contracts_insert
AFTER INSERT ON rights_contracts
BEGIN
  UPDATE cove_seo_primary_fence SET rights_generation=rights_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_rights_contracts_update
AFTER UPDATE ON rights_contracts
BEGIN
  UPDATE cove_seo_primary_fence SET rights_generation=rights_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_rights_contracts_delete
AFTER DELETE ON rights_contracts
BEGIN
  UPDATE cove_seo_primary_fence SET rights_generation=rights_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_rights_contract_languages_insert
AFTER INSERT ON rights_contract_languages
BEGIN
  UPDATE cove_seo_primary_fence SET rights_generation=rights_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_rights_contract_languages_update
AFTER UPDATE ON rights_contract_languages
BEGIN
  UPDATE cove_seo_primary_fence SET rights_generation=rights_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_rights_contract_languages_delete
AFTER DELETE ON rights_contract_languages
BEGIN
  UPDATE cove_seo_primary_fence SET rights_generation=rights_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_rights_contract_versions_insert
AFTER INSERT ON rights_contract_versions
BEGIN
  UPDATE cove_seo_primary_fence SET rights_generation=rights_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_rights_contract_versions_update
AFTER UPDATE ON rights_contract_versions
BEGIN
  UPDATE cove_seo_primary_fence SET rights_generation=rights_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_rights_contract_versions_delete
AFTER DELETE ON rights_contract_versions
BEGIN
  UPDATE cove_seo_primary_fence SET rights_generation=rights_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_rights_contract_version_territories_insert
AFTER INSERT ON rights_contract_version_territories
BEGIN
  UPDATE cove_seo_primary_fence SET rights_generation=rights_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_rights_contract_version_territories_update
AFTER UPDATE ON rights_contract_version_territories
BEGIN
  UPDATE cove_seo_primary_fence SET rights_generation=rights_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_rights_contract_version_territories_delete
AFTER DELETE ON rights_contract_version_territories
BEGIN
  UPDATE cove_seo_primary_fence SET rights_generation=rights_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_rights_contract_version_formats_insert
AFTER INSERT ON rights_contract_version_formats
BEGIN
  UPDATE cove_seo_primary_fence SET rights_generation=rights_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_rights_contract_version_formats_update
AFTER UPDATE ON rights_contract_version_formats
BEGIN
  UPDATE cove_seo_primary_fence SET rights_generation=rights_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_rights_contract_version_formats_delete
AFTER DELETE ON rights_contract_version_formats
BEGIN
  UPDATE cove_seo_primary_fence SET rights_generation=rights_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_rights_contract_version_channels_insert
AFTER INSERT ON rights_contract_version_channels
BEGIN
  UPDATE cove_seo_primary_fence SET rights_generation=rights_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_rights_contract_version_channels_update
AFTER UPDATE ON rights_contract_version_channels
BEGIN
  UPDATE cove_seo_primary_fence SET rights_generation=rights_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
CREATE TRIGGER IF NOT EXISTS seo_gen_rights_contract_version_channels_delete
AFTER DELETE ON rights_contract_version_channels
BEGIN
  UPDATE cove_seo_primary_fence SET rights_generation=rights_generation+1,withdrawal_generation=withdrawal_generation+1 WHERE slot=1;
END;
