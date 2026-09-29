-- Commercial rights management and auditable availability enforcement.
-- Rights are evaluated by edition + territory + format + sales channel + effective date.

CREATE TABLE IF NOT EXISTS rights_parties (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  party_type text NOT NULL DEFAULT 'publisher' CHECK(party_type IN ('publisher','author','agent','distributor','estate','licensor','other')),
  publisher_id text REFERENCES publishers(id) ON DELETE SET NULL,
  contributor_id text REFERENCES contributors(id) ON DELETE SET NULL,
  contact_email text NOT NULL DEFAULT '',
  reference_code text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rights_parties_publisher ON rights_parties(publisher_id,status);

ALTER TABLE rights_grants ADD COLUMN rightsholder_party_id text;
ALTER TABLE rights_grants ADD COLUMN decision text NOT NULL DEFAULT 'allow' CHECK(decision IN ('allow','deny'));
ALTER TABLE rights_grants ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','suspended','revoked','expired'));
ALTER TABLE rights_grants ADD COLUMN promotion_restrictions_json text NOT NULL DEFAULT '{}';
ALTER TABLE rights_grants ADD COLUMN contract_reference text NOT NULL DEFAULT '';
ALTER TABLE rights_grants ADD COLUMN source text NOT NULL DEFAULT 'operator';
ALTER TABLE rights_grants ADD COLUMN notes text NOT NULL DEFAULT '';
ALTER TABLE rights_grants ADD COLUMN updated_at text;
UPDATE rights_grants SET updated_at=COALESCE(updated_at,created_at) WHERE updated_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rights_grant_match ON rights_grants(edition_id,territory_code,format,sales_channel,status,decision,starts_at,ends_at);
CREATE INDEX IF NOT EXISTS idx_rights_grant_party ON rights_grants(rightsholder_party_id,status);

ALTER TABLE offers ADD COLUMN sales_channel text NOT NULL DEFAULT 'retail' CHECK(sales_channel IN ('retail','subscription','library'));
CREATE INDEX IF NOT EXISTS idx_offers_channel_active ON offers(product_id,sales_channel,active,starts_at,ends_at);

CREATE TABLE IF NOT EXISTS rights_decisions (
  id text PRIMARY KEY,
  product_id text REFERENCES products(id) ON DELETE SET NULL,
  edition_id text NOT NULL REFERENCES editions(id) ON DELETE RESTRICT,
  grant_id text REFERENCES rights_grants(id) ON DELETE SET NULL,
  territory_code text NOT NULL,
  format text NOT NULL,
  sales_channel text NOT NULL,
  decision text NOT NULL CHECK(decision IN ('allow','deny')),
  reason_code text NOT NULL,
  rightsholder_name text NOT NULL DEFAULT '',
  license_type text NOT NULL DEFAULT '',
  drm_requirement text NOT NULL DEFAULT 'none',
  promotion_restrictions_json text NOT NULL DEFAULT '{}',
  context_json text NOT NULL DEFAULT '{}',
  evaluated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rights_decisions_product ON rights_decisions(product_id,evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_rights_decisions_edition ON rights_decisions(edition_id,territory_code,sales_channel,evaluated_at DESC);

-- Contract records and legal availability decisions are compliance evidence. Keep an
-- append-only change history even when an operator edits the current grant in place.
CREATE TABLE IF NOT EXISTS rights_grant_audit (
  id text PRIMARY KEY,
  grant_id text NOT NULL,
  action text NOT NULL CHECK(action IN ('baseline','insert','update')),
  snapshot_json text NOT NULL,
  recorded_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rights_grant_audit_grant ON rights_grant_audit(grant_id,recorded_at DESC);

ALTER TABLE commerce_order_items ADD COLUMN rights_decision_id text;
ALTER TABLE commerce_order_items ADD COLUMN rights_grant_id text;
ALTER TABLE commerce_order_items ADD COLUMN rights_snapshot_json text NOT NULL DEFAULT '{}';

-- Normalize existing Project Gutenberg metadata into the generic rightsholder registry.
INSERT OR IGNORE INTO rights_parties(id,display_name,party_type,publisher_id,reference_code,status,created_at,updated_at)
SELECT 'rparty_project_gutenberg','Project Gutenberg','publisher','pub_project_gutenberg','project-gutenberg','active',datetime('now'),datetime('now');
UPDATE rights_grants SET rightsholder_party_id='rparty_project_gutenberg',updated_at=COALESCE(updated_at,created_at)
WHERE rightsholder_id='pub_project_gutenberg' AND (rightsholder_party_id IS NULL OR rightsholder_party_id='');

INSERT INTO rights_grant_audit(id,grant_id,action,snapshot_json,recorded_at)
SELECT 'rga_'||lower(hex(randomblob(16))),id,'baseline',json_object(
  'editionId',edition_id,'rightsholderId',rightsholder_id,'rightsholderPartyId',rightsholder_party_id,
  'territory',territory_code,'format',format,'salesChannel',sales_channel,'startsAt',starts_at,'endsAt',ends_at,
  'licenseType',license_type,'drmRequirement',drm_requirement,'subscriptionPermitted',subscription_permitted,
  'libraryPermitted',library_permitted,'decision',decision,'status',status,'promotionRestrictions',CASE WHEN json_valid(promotion_restrictions_json) THEN json(promotion_restrictions_json) ELSE json('{}') END,
  'contractReference',contract_reference,'source',source,'notes',notes
),COALESCE(updated_at,created_at) FROM rights_grants;

CREATE TRIGGER IF NOT EXISTS rights_grants_audit_insert AFTER INSERT ON rights_grants BEGIN
  INSERT INTO rights_grant_audit(id,grant_id,action,snapshot_json,recorded_at) VALUES(
    'rga_'||lower(hex(randomblob(16))),NEW.id,'insert',json_object(
      'editionId',NEW.edition_id,'rightsholderId',NEW.rightsholder_id,'rightsholderPartyId',NEW.rightsholder_party_id,
      'territory',NEW.territory_code,'format',NEW.format,'salesChannel',NEW.sales_channel,'startsAt',NEW.starts_at,'endsAt',NEW.ends_at,
      'licenseType',NEW.license_type,'drmRequirement',NEW.drm_requirement,'subscriptionPermitted',NEW.subscription_permitted,
      'libraryPermitted',NEW.library_permitted,'decision',NEW.decision,'status',NEW.status,'promotionRestrictions',CASE WHEN json_valid(NEW.promotion_restrictions_json) THEN json(NEW.promotion_restrictions_json) ELSE json('{}') END,
      'contractReference',NEW.contract_reference,'source',NEW.source,'notes',NEW.notes
    ),COALESCE(NEW.updated_at,NEW.created_at));
END;
CREATE TRIGGER IF NOT EXISTS rights_grants_audit_update AFTER UPDATE ON rights_grants BEGIN
  INSERT INTO rights_grant_audit(id,grant_id,action,snapshot_json,recorded_at) VALUES(
    'rga_'||lower(hex(randomblob(16))),NEW.id,'update',json_object(
      'editionId',NEW.edition_id,'rightsholderId',NEW.rightsholder_id,'rightsholderPartyId',NEW.rightsholder_party_id,
      'territory',NEW.territory_code,'format',NEW.format,'salesChannel',NEW.sales_channel,'startsAt',NEW.starts_at,'endsAt',NEW.ends_at,
      'licenseType',NEW.license_type,'drmRequirement',NEW.drm_requirement,'subscriptionPermitted',NEW.subscription_permitted,
      'libraryPermitted',NEW.library_permitted,'decision',NEW.decision,'status',NEW.status,'promotionRestrictions',CASE WHEN json_valid(NEW.promotion_restrictions_json) THEN json(NEW.promotion_restrictions_json) ELSE json('{}') END,
      'contractReference',NEW.contract_reference,'source',NEW.source,'notes',NEW.notes
    ),COALESCE(NEW.updated_at,datetime('now')));
END;

-- Legal history is append-only: revoke/expire a grant instead of deleting it, and never
-- rewrite decision/audit evidence or the rights snapshot attached to an order.
CREATE TRIGGER IF NOT EXISTS rights_grants_party_insert BEFORE INSERT ON rights_grants
WHEN NEW.rightsholder_party_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rights_parties WHERE id=NEW.rightsholder_party_id) BEGIN
  SELECT RAISE(ABORT,'unknown rights party');
END;
CREATE TRIGGER IF NOT EXISTS rights_grants_party_update BEFORE UPDATE OF rightsholder_party_id ON rights_grants
WHEN NEW.rightsholder_party_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rights_parties WHERE id=NEW.rightsholder_party_id) BEGIN
  SELECT RAISE(ABORT,'unknown rights party');
END;
CREATE TRIGGER IF NOT EXISTS rights_grants_no_delete BEFORE DELETE ON rights_grants BEGIN
  SELECT RAISE(ABORT,'rights grants are immutable records; revoke or expire instead');
END;
CREATE TRIGGER IF NOT EXISTS rights_grant_audit_no_update BEFORE UPDATE ON rights_grant_audit BEGIN
  SELECT RAISE(ABORT,'rights grant audit is append-only');
END;
CREATE TRIGGER IF NOT EXISTS rights_grant_audit_no_delete BEFORE DELETE ON rights_grant_audit BEGIN
  SELECT RAISE(ABORT,'rights grant audit is append-only');
END;
CREATE TRIGGER IF NOT EXISTS rights_decisions_no_update BEFORE UPDATE ON rights_decisions BEGIN
  SELECT RAISE(ABORT,'rights decisions are append-only');
END;
CREATE TRIGGER IF NOT EXISTS rights_decisions_no_delete BEFORE DELETE ON rights_decisions BEGIN
  SELECT RAISE(ABORT,'rights decisions are append-only');
END;
CREATE TRIGGER IF NOT EXISTS order_item_rights_no_rewrite BEFORE UPDATE OF rights_decision_id,rights_grant_id,rights_snapshot_json ON commerce_order_items BEGIN
  SELECT RAISE(ABORT,'order rights evidence is immutable');
END;

-- One fail-closed storefront projection for all retail discovery surfaces.  A product is
-- discoverable only if an active allow grant matches its exact edition/format/territory,
-- its delivered asset satisfies the grant's DRM requirement, and no active deny grant
-- overrides the same scope.  Effective dates are evaluated at query time.
CREATE VIEW IF NOT EXISTS retail_product_availability AS
SELECT DISTINCT
  p.id AS product_id,
  p.edition_id,
  upper(rg.territory_code) AS territory_code,
  p.format,
  rg.id AS rights_grant_id
FROM products p
JOIN editions e ON e.id=p.edition_id
JOIN rights_grants rg ON rg.edition_id=e.id AND lower(rg.format)=lower(p.format)
WHERE p.storefront_status='active'
  AND rg.sales_channel='retail'
  AND rg.decision='allow'
  AND rg.status='active'
  AND (rg.starts_at IS NULL OR rg.starts_at<=datetime('now'))
  AND (rg.ends_at IS NULL OR rg.ends_at>datetime('now'))
  AND NOT EXISTS (
    SELECT 1 FROM rights_grants deny
    WHERE deny.edition_id=e.id
      AND upper(deny.territory_code)=upper(rg.territory_code)
      AND lower(deny.format)=lower(p.format)
      AND deny.sales_channel='retail'
      AND deny.decision='deny'
      AND deny.status='active'
      AND (deny.starts_at IS NULL OR deny.starts_at<=datetime('now'))
      AND (deny.ends_at IS NULL OR deny.ends_at>datetime('now'))
  )
  AND (
    lower(COALESCE(rg.drm_requirement,'none')) IN ('','none','optional','any')
    OR (lower(rg.drm_requirement) IN ('none-only','drm-free') AND lower(COALESCE(
      (SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=e.id
       AND ((p.format='ebook' AND da.kind='epub') OR (p.format='audiobook' AND da.kind='audio'))
       ORDER BY da.updated_at DESC LIMIT 1),e.drm_status,'none')) IN ('','none','drm-free'))
    OR (lower(rg.drm_requirement) IN ('required','drm','encrypted','any-drm') AND lower(COALESCE(
      (SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=e.id
       AND ((p.format='ebook' AND da.kind='epub') OR (p.format='audiobook' AND da.kind='audio'))
       ORDER BY da.updated_at DESC LIMIT 1),e.drm_status,'none')) NOT IN ('','none','drm-free'))
    OR (lower(rg.drm_requirement) IN ('watermark','social-drm') AND lower(COALESCE(
      (SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=e.id
       AND ((p.format='ebook' AND da.kind='epub') OR (p.format='audiobook' AND da.kind='audio'))
       ORDER BY da.updated_at DESC LIMIT 1),e.drm_status,'none')) IN ('watermark','social-drm'))
    OR (lower(rg.drm_requirement) IN ('adobe','adobe-acs','acs4') AND lower(COALESCE(
      (SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=e.id
       AND ((p.format='ebook' AND da.kind='epub') OR (p.format='audiobook' AND da.kind='audio'))
       ORDER BY da.updated_at DESC LIMIT 1),e.drm_status,'none')) IN ('adobe','adobe-acs','acs4'))
    OR (lower(rg.drm_requirement) IN ('lcp','readium-lcp') AND lower(COALESCE(
      (SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=e.id
       AND ((p.format='ebook' AND da.kind='epub') OR (p.format='audiobook' AND da.kind='audio'))
       ORDER BY da.updated_at DESC LIMIT 1),e.drm_status,'none')) IN ('lcp','readium-lcp'))
    OR lower(rg.drm_requirement)=lower(COALESCE(
      (SELECT da.drm_status FROM digital_assets da WHERE da.edition_id=e.id
       AND ((p.format='ebook' AND da.kind='epub') OR (p.format='audiobook' AND da.kind='audio'))
       ORDER BY da.updated_at DESC LIMIT 1),e.drm_status,'none'))
  );
