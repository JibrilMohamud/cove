-- Cove security program, conflict-aware cross-device sync, and first-class text bookmarks.

-- -----------------------------------------------------------------------------
-- First-class text bookmarks. A bookmark is a location marker, not a highlight.
-- -----------------------------------------------------------------------------
CREATE TABLE text_bookmarks (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  external_book_id TEXT NOT NULL,
  cfi TEXT NOT NULL,
  chapter TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  progress REAL NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 1),
  publication_version_id TEXT REFERENCES publishing_publication_versions(id) ON DELETE SET NULL,
  asset_version_id TEXT REFERENCES asset_versions(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_by_client_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_text_bookmarks_user_book ON text_bookmarks(user_id,external_book_id,deleted_at,created_at DESC);
CREATE INDEX idx_text_bookmarks_product ON text_bookmarks(user_id,product_id,deleted_at);

CREATE TABLE text_bookmark_cfi_migrations (
  id TEXT PRIMARY KEY NOT NULL,
  bookmark_id TEXT NOT NULL REFERENCES text_bookmarks(id) ON DELETE CASCADE,
  from_publication_version_id TEXT REFERENCES publishing_publication_versions(id) ON DELETE SET NULL,
  to_publication_version_id TEXT REFERENCES publishing_publication_versions(id) ON DELETE SET NULL,
  old_cfi TEXT NOT NULL,
  new_cfi TEXT,
  status TEXT NOT NULL CHECK(status IN ('exact','mapped','manual_required','invalid')),
  method TEXT NOT NULL DEFAULT 'asset_hash',
  confidence_bps INTEGER NOT NULL DEFAULT 0 CHECK(confidence_bps BETWEEN 0 AND 10000),
  created_at TEXT NOT NULL,
  UNIQUE(bookmark_id,to_publication_version_id)
);
CREATE INDEX idx_text_bookmark_migrations_status ON text_bookmark_cfi_migrations(status,created_at DESC);

-- Existing mutable reading entities gain server versions for optimistic concurrency.
ALTER TABLE reading_states ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE annotations ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE annotations ADD COLUMN deleted_at TEXT;
ALTER TABLE preview_states ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE shelves ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

-- -----------------------------------------------------------------------------
-- Conflict-aware cross-device sync. The event stream is the sync transport; domain
-- tables remain authoritative. No generic last-write-wins overwrite is permitted.
-- -----------------------------------------------------------------------------
CREATE TABLE sync_clients (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  client_key_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '',
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  last_cursor INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(user_id,client_key_hash)
);
CREATE INDEX idx_sync_clients_user ON sync_clients(user_id,status,last_seen_at DESC);

CREATE TABLE sync_entity_policies (
  entity_type TEXT PRIMARY KEY NOT NULL,
  merge_policy TEXT NOT NULL CHECK(merge_policy IN ('optimistic','orset','field_optimistic','device_scoped','append_only')),
  conflict_behavior TEXT NOT NULL CHECK(conflict_behavior IN ('reject_and_return_both','preserve_both','reject','insert_only')),
  tombstone_retention_days INTEGER NOT NULL DEFAULT 90 CHECK(tombstone_retention_days BETWEEN 7 AND 3650),
  description TEXT NOT NULL
);

INSERT INTO sync_entity_policies(entity_type,merge_policy,conflict_behavior,tombstone_retention_days,description) VALUES
 ('reading_position','optimistic','reject_and_return_both',180,'One location per product. Concurrent moves are surfaced; Cove never guesses whether backwards or forwards was intentional.'),
 ('annotation','orset','reject_and_return_both',365,'Highlights/notes use stable UUIDs. Independent records merge; concurrent edits to one annotation require resolution.'),
 ('text_bookmark','orset','reject_and_return_both',365,'Text bookmarks are independent UUID records with tombstones.'),
 ('reader_setting','field_optimistic','reject_and_return_both',180,'Each setting key is independently versioned, avoiding whole-settings-object clobbering.'),
 ('audio_location','optimistic','reject_and_return_both',180,'Audiobook playback already uses optimistic versions; conflicts return the current server position.'),
 ('biosync_location','optimistic','reject_and_return_both',180,'Verified text/audio handoff location is versioned and never silently overwritten.'),
 ('shelf','orset','reject_and_return_both',365,'Shelves and membership rows merge by stable identifiers.'),
 ('wishlist','orset','reject_and_return_both',365,'Wishlist records merge by product identity and retain tombstones for offline removal.'),
 ('sample','optimistic','reject_and_return_both',90,'Sample location is versioned; conversion to owned reading state is a separate domain transition.'),
 ('download_metadata','device_scoped','reject',90,'Download metadata is scoped to a registered sync client/device.'),
 ('device_state','device_scoped','reject',90,'Device capabilities/state cannot overwrite another device record.');

CREATE TABLE sync_records (
  user_id TEXT NOT NULL,
  entity_type TEXT NOT NULL REFERENCES sync_entity_policies(entity_type) ON DELETE RESTRICT,
  entity_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  payload_json TEXT NOT NULL,
  tombstone INTEGER NOT NULL DEFAULT 0 CHECK(tombstone IN (0,1)),
  content_sha256 TEXT NOT NULL,
  updated_by_client_id TEXT REFERENCES sync_clients(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id,entity_type,entity_id)
);
CREATE INDEX idx_sync_records_user_type ON sync_records(user_id,entity_type,updated_at DESC);

CREATE TABLE sync_mutations (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),
  payload_json TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  client_id TEXT REFERENCES sync_clients(id) ON DELETE SET NULL,
  mutation_id TEXT,
  occurred_at TEXT NOT NULL,
  UNIQUE(user_id,client_id,mutation_id)
);
CREATE INDEX idx_sync_mutations_pull ON sync_mutations(user_id,sequence);
CREATE INDEX idx_sync_mutations_entity ON sync_mutations(user_id,entity_type,entity_id,sequence DESC);

CREATE TABLE sync_conflicts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  client_id TEXT REFERENCES sync_clients(id) ON DELETE SET NULL,
  mutation_id TEXT,
  expected_version INTEGER NOT NULL,
  server_version INTEGER NOT NULL,
  incoming_operation TEXT NOT NULL DEFAULT 'upsert' CHECK(incoming_operation IN ('upsert','delete')),
  incoming_payload_json TEXT NOT NULL,
  server_payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved_keep_server','resolved_accept_client','resolved_merged','dismissed')),
  resolution_payload_json TEXT,
  resolved_by_client_id TEXT REFERENCES sync_clients(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_sync_conflicts_user_open ON sync_conflicts(user_id,status,created_at DESC);

CREATE TABLE reader_settings (
  user_id TEXT NOT NULL,
  setting_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  updated_by_client_id TEXT REFERENCES sync_clients(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id,setting_key)
);

CREATE TABLE sync_download_metadata (
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES sync_clients(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  asset_sha256 TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK(state IN ('queued','downloading','available','stale','removed','failed')),
  bytes_downloaded INTEGER NOT NULL DEFAULT 0 CHECK(bytes_downloaded>=0),
  total_bytes INTEGER,
  offline_license_expires_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id,client_id,product_id)
);

-- -----------------------------------------------------------------------------
-- Formal security program and evidence/control plane.
-- Secrets are references to an external secret manager; plaintext secret material
-- must never be written to these tables.
-- -----------------------------------------------------------------------------
CREATE TABLE security_program_versions (
  id TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL UNIQUE CHECK(version>0),
  status TEXT NOT NULL CHECK(status IN ('draft','active','retired')),
  framework TEXT NOT NULL DEFAULT 'Cove Security Baseline',
  scope_json TEXT NOT NULL DEFAULT '{}',
  approved_by_user_id TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_security_program_active ON security_program_versions(status) WHERE status='active';

CREATE TABLE security_threat_models (
  id TEXT PRIMARY KEY NOT NULL,
  program_version_id TEXT NOT NULL REFERENCES security_program_versions(id) ON DELETE RESTRICT,
  system_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  status TEXT NOT NULL CHECK(status IN ('draft','review','approved','superseded')),
  trust_boundaries_json TEXT NOT NULL DEFAULT '[]',
  data_flows_json TEXT NOT NULL DEFAULT '[]',
  assumptions_json TEXT NOT NULL DEFAULT '[]',
  approved_by_user_id TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(system_key,version)
);

CREATE TABLE security_threats (
  id TEXT PRIMARY KEY NOT NULL,
  threat_model_id TEXT NOT NULL REFERENCES security_threat_models(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK(category IN ('spoofing','tampering','repudiation','information_disclosure','denial_of_service','elevation_of_privilege','fraud','supply_chain','privacy')),
  title TEXT NOT NULL,
  scenario TEXT NOT NULL,
  likelihood INTEGER NOT NULL CHECK(likelihood BETWEEN 1 AND 5),
  impact INTEGER NOT NULL CHECK(impact BETWEEN 1 AND 5),
  risk_score INTEGER NOT NULL CHECK(risk_score BETWEEN 1 AND 25),
  treatment TEXT NOT NULL CHECK(treatment IN ('mitigate','accept','transfer','avoid')),
  status TEXT NOT NULL CHECK(status IN ('open','mitigated','accepted','closed')),
  owner_team TEXT NOT NULL,
  controls_json TEXT NOT NULL DEFAULT '[]',
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_security_threats_risk ON security_threats(status,risk_score DESC);

CREATE TABLE security_edge_controls (
  id TEXT PRIMARY KEY NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('staging','production')),
  provider TEXT NOT NULL,
  waf_mode TEXT NOT NULL CHECK(waf_mode IN ('off','monitor','block')),
  managed_rules_enabled INTEGER NOT NULL DEFAULT 1 CHECK(managed_rules_enabled IN (0,1)),
  bot_management_mode TEXT NOT NULL CHECK(bot_management_mode IN ('off','monitor','challenge','block')),
  ddos_managed INTEGER NOT NULL DEFAULT 1 CHECK(ddos_managed IN (0,1)),
  rate_limit_policy_ref TEXT NOT NULL DEFAULT '',
  config_reference TEXT NOT NULL DEFAULT '',
  evidence_reference TEXT NOT NULL DEFAULT '',
  verified_at TEXT,
  verified_by_user_id TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(environment,provider)
);

CREATE TABLE security_header_policies (
  id TEXT PRIMARY KEY NOT NULL,
  environment TEXT NOT NULL UNIQUE CHECK(environment IN ('development','staging','production')),
  csp TEXT NOT NULL,
  hsts TEXT NOT NULL,
  permissions_policy TEXT NOT NULL,
  referrer_policy TEXT NOT NULL,
  cross_origin_opener_policy TEXT NOT NULL,
  cross_origin_resource_policy TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','retired')),
  last_verified_at TEXT,
  evidence_reference TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE security_secret_inventory (
  id TEXT PRIMARY KEY NOT NULL,
  secret_key TEXT NOT NULL UNIQUE,
  owner_team TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('development','staging','production','shared')),
  provider TEXT NOT NULL,
  secret_manager_reference TEXT NOT NULL,
  purpose TEXT NOT NULL,
  rotation_days INTEGER NOT NULL CHECK(rotation_days BETWEEN 1 AND 730),
  last_rotated_at TEXT,
  next_rotation_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','rotation_due','revoked','retired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE security_key_rotation_events (
  id TEXT PRIMARY KEY NOT NULL,
  secret_inventory_id TEXT NOT NULL REFERENCES security_secret_inventory(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('rotated','revoked','compromised','tested')),
  old_version_reference TEXT,
  new_version_reference TEXT,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('staff','service','provider','system')),
  actor_id TEXT NOT NULL,
  evidence_reference TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL
);

CREATE TABLE security_scans (
  id TEXT PRIMARY KEY NOT NULL,
  scan_type TEXT NOT NULL CHECK(scan_type IN ('dependency','sbom','secret','sast','dast','container','provenance','malware','pentest','pci_scope','header','waf','backup_security')),
  environment TEXT NOT NULL DEFAULT 'ci',
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  scanner TEXT NOT NULL,
  scanner_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('queued','running','passed','warning','failed','blocked')),
  critical_count INTEGER NOT NULL DEFAULT 0,
  high_count INTEGER NOT NULL DEFAULT 0,
  medium_count INTEGER NOT NULL DEFAULT 0,
  low_count INTEGER NOT NULL DEFAULT 0,
  report_reference TEXT NOT NULL DEFAULT '',
  report_sha256 TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_security_scans_type_time ON security_scans(scan_type,created_at DESC);
CREATE INDEX idx_security_scans_target ON security_scans(target_type,target_id,created_at DESC);

CREATE TABLE security_findings (
  id TEXT PRIMARY KEY NOT NULL,
  scan_id TEXT NOT NULL REFERENCES security_scans(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('critical','high','medium','low','info')),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  component TEXT NOT NULL DEFAULT '',
  installed_version TEXT NOT NULL DEFAULT '',
  fixed_version TEXT NOT NULL DEFAULT '',
  cve TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','triaged','accepted','fixed','false_positive')),
  due_at TEXT,
  owner_team TEXT NOT NULL DEFAULT 'security',
  remediation_reference TEXT NOT NULL DEFAULT '',
  accepted_until TEXT,
  accepted_by_user_id TEXT,
  acceptance_reason TEXT NOT NULL DEFAULT '',
  acceptance_reference TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scan_id,fingerprint)
);
CREATE INDEX idx_security_findings_open ON security_findings(status,severity,due_at);

CREATE TABLE security_sboms (
  id TEXT PRIMARY KEY NOT NULL,
  release_id TEXT NOT NULL,
  format TEXT NOT NULL CHECK(format IN ('cyclonedx-json','spdx-json')),
  object_reference TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  component_count INTEGER NOT NULL DEFAULT 0,
  generated_by TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  UNIQUE(release_id,format)
);

CREATE TABLE security_build_provenance (
  id TEXT PRIMARY KEY NOT NULL,
  release_id TEXT NOT NULL UNIQUE,
  source_revision TEXT NOT NULL,
  builder_identity TEXT NOT NULL,
  build_system TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  provenance_format TEXT NOT NULL DEFAULT 'slsa-v1',
  provenance_reference TEXT NOT NULL,
  signature_reference TEXT NOT NULL DEFAULT '',
  verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1)),
  verified_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE security_pentest_engagements (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  scope TEXT NOT NULL,
  engagement_type TEXT NOT NULL CHECK(engagement_type IN ('external','authenticated','api','mobile','cloud','red_team')),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('planned','active','report_received','remediating','closed')),
  report_reference TEXT NOT NULL DEFAULT '',
  retest_reference TEXT NOT NULL DEFAULT '',
  critical_open INTEGER NOT NULL DEFAULT 0,
  high_open INTEGER NOT NULL DEFAULT 0,
  owner_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE security_disclosure_reports (
  id TEXT PRIMARY KEY NOT NULL,
  public_reference TEXT NOT NULL UNIQUE,
  reporter_contact_ref TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('unknown','low','medium','high','critical')),
  status TEXT NOT NULL CHECK(status IN ('received','triaged','accepted','duplicate','not_applicable','remediating','resolved')),
  safe_harbor_version TEXT NOT NULL,
  acknowledged_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE security_incident_response_plans (
  id TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('draft','active','retired')),
  severity_matrix_json TEXT NOT NULL,
  roles_json TEXT NOT NULL,
  communications_json TEXT NOT NULL,
  containment_playbooks_json TEXT NOT NULL,
  evidence_preservation_json TEXT NOT NULL,
  notification_matrix_json TEXT NOT NULL,
  approved_by_user_id TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_security_ir_active ON security_incident_response_plans(status) WHERE status='active';

CREATE TABLE security_incidents (
  id TEXT PRIMARY KEY NOT NULL,
  plan_id TEXT NOT NULL REFERENCES security_incident_response_plans(id) ON DELETE RESTRICT,
  severity TEXT NOT NULL CHECK(severity IN ('sev1','sev2','sev3','sev4')),
  status TEXT NOT NULL CHECK(status IN ('declared','contained','eradicated','recovering','resolved','postmortem')),
  title TEXT NOT NULL,
  incident_commander_user_id TEXT,
  declared_at TEXT NOT NULL,
  contained_at TEXT,
  resolved_at TEXT,
  root_cause TEXT NOT NULL DEFAULT '',
  customer_impact TEXT NOT NULL DEFAULT '',
  notification_status TEXT NOT NULL DEFAULT 'assessing',
  evidence_reference TEXT NOT NULL DEFAULT '',
  postmortem_reference TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_security_incidents_status ON security_incidents(status,severity,declared_at DESC);

-- Publisher account security posture. Sensitive publishing operations require MFA.
CREATE TABLE publisher_security_policies (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES publishing_accounts(id) ON DELETE CASCADE,
  require_mfa INTEGER NOT NULL DEFAULT 1 CHECK(require_mfa IN (0,1)),
  require_mfa_for_read_only INTEGER NOT NULL DEFAULT 0 CHECK(require_mfa_for_read_only IN (0,1)),
  max_session_age_minutes INTEGER NOT NULL DEFAULT 720 CHECK(max_session_age_minutes BETWEEN 5 AND 10080),
  approved_domains_json TEXT NOT NULL DEFAULT '[]',
  updated_by_user_id TEXT,
  updated_at TEXT NOT NULL
);

-- Seed baseline program/header/IR evidence. Values are policy defaults and still need
-- deployment verification against the edge provider.
INSERT INTO security_program_versions(id,version,status,framework,scope_json,created_at)
VALUES('secprog_v1',1,'active','Cove Security Baseline v1','{"scope":["storefront","accounts","publishing","payments","reader-sync","operations"],"pci":"SAQ-A target via hosted/provider payment collection"}',datetime('now'));

INSERT INTO security_threat_models(id,program_version_id,system_key,version,status,trust_boundaries_json,data_flows_json,assumptions_json,approved_by_user_id,approved_at,created_at) VALUES
('threatmodel_fore_platform_1','secprog_v1','fore-platform',1,'approved','[{"name":"public-edge","between":"internet and CDN/WAF"},{"name":"application-auth","between":"anonymous/authenticated application requests"},{"name":"staff-control-plane","between":"customer/publisher and privileged staff APIs"},{"name":"publisher-upload-quarantine","between":"untrusted publisher bytes and catalog assets"},{"name":"payment-provider","between":"Cove order state and provider-hosted card collection"},{"name":"sync-client","between":"device-local reader state and authoritative domain tables"}]','[{"from":"browser","to":"CDN/WAF","data":"storefront/API requests"},{"from":"publisher","to":"quarantine","data":"EPUB/cover/audio assets"},{"from":"checkout","to":"payment-provider","data":"payment intent identifiers, no PAN/CVC"},{"from":"reader-device","to":"sync-api","data":"versioned reader mutations"},{"from":"staff","to":"control-plane","data":"privileged administrative mutations"}]','["Managed edge controls are deployment responsibilities and require independent evidence","Payment card data remains provider-hosted","Publisher assets are untrusted until required validators pass","Privileged staff and publisher mutations require strong authentication"]','system:migration',datetime('now'),datetime('now'));

INSERT INTO security_threats(id,threat_model_id,category,title,scenario,likelihood,impact,risk_score,treatment,status,owner_team,controls_json,reviewed_at,created_at,updated_at) VALUES
('threat_auth_takeover','threatmodel_fore_platform_1','spoofing','Account or privileged-session takeover','An attacker reuses credentials/session material to access customer, publisher, or staff privileges.',4,5,20,'mitigate','mitigated','identity-security','["HttpOnly sessions","AAL2/MFA","staff RBAC","publisher MFA","session/device revocation","security notifications","risk holds"]',datetime('now'),datetime('now'),datetime('now')),
('threat_upload_malware','threatmodel_fore_platform_1','tampering','Malicious publisher upload','A publisher or compromised publisher account uploads a malicious or weaponized EPUB/cover/audio artifact.',3,5,15,'mitigate','mitigated','publishing-security','["quarantine","required malware validation","content-type/size validation","isolated scanner worker","security scan evidence"]',datetime('now'),datetime('now'),datetime('now')),
('threat_edge_ddos','threatmodel_fore_platform_1','denial_of_service','Storefront/API volumetric or bot denial of service','Automated or volumetric traffic overwhelms application resources or abuses expensive endpoints.',4,4,16,'mitigate','open','operations-security','["managed DDoS provider","WAF block mode","bot management","application rate limits","SLO/alerting"]',datetime('now'),datetime('now'),datetime('now')),
('threat_supply_chain','threatmodel_fore_platform_1','supply_chain','Compromised dependency or build pipeline','A malicious dependency, secret leak, or untrusted build produces compromised release artifacts.',3,5,15,'mitigate','mitigated','application-security','["dependency audit","Dependabot","CodeQL","secret scan","CycloneDX SBOM","OIDC provenance attestation"]',datetime('now'),datetime('now'),datetime('now')),
('threat_sync_tamper','threatmodel_fore_platform_1','tampering','Cross-device stale-write data loss','A stale device overwrites newer reading state, notes or bookmarks without detecting the conflict.',4,3,12,'mitigate','mitigated','reader-platform','["per-entity versions","expectedVersion","ordered mutation stream","durable conflict records","explicit resolution"]',datetime('now'),datetime('now'),datetime('now')),
('threat_payment_scope','threatmodel_fore_platform_1','information_disclosure','Payment-card data enters Cove systems','A payment integration change accidentally sends or stores PAN/CVC in Cove application infrastructure.',2,5,10,'avoid','mitigated','commerce-security','["provider-hosted payment collection","no PAN/CVC schema","payment-provider identifiers only","PCI scope review gate"]',datetime('now'),datetime('now'),datetime('now')),
('threat_secret_leak','threatmodel_fore_platform_1','information_disclosure','Production credential exposure','A source, log, support artifact, or overly broad workload credential exposes a production secret.',3,5,15,'mitigate','mitigated','security','["central secret-manager references","scoped service principals","secret scanning","redaction","rotation/revocation evidence"]',datetime('now'),datetime('now'),datetime('now')),
('threat_privilege_abuse','threatmodel_fore_platform_1','elevation_of_privilege','Overprivileged human or workload identity','A compromised or misconfigured identity performs actions outside its operational role.',3,5,15,'mitigate','mitigated','security','["staff RBAC","service scopes","MFA","privileged access audit","separation of human and machine identities"]',datetime('now'),datetime('now'),datetime('now'));

INSERT INTO security_header_policies(id,environment,csp,hsts,permissions_policy,referrer_policy,cross_origin_opener_policy,cross_origin_resource_policy,status,updated_at) VALUES
('sechdr_dev','development','default-src ''self''; object-src ''none''; base-uri ''self''; frame-ancestors ''none''','', 'camera=(), microphone=(), geolocation=(), payment=(self)', 'strict-origin-when-cross-origin','same-origin','same-origin','active',datetime('now')),
('sechdr_stage','staging','default-src ''self''; object-src ''none''; base-uri ''self''; frame-ancestors ''none''','max-age=86400', 'camera=(), microphone=(), geolocation=(), payment=(self)', 'strict-origin-when-cross-origin','same-origin','same-origin','active',datetime('now')),
('sechdr_prod','production','default-src ''self''; object-src ''none''; base-uri ''self''; frame-ancestors ''none''','max-age=31536000; includeSubDomains; preload', 'camera=(), microphone=(), geolocation=(), payment=(self)', 'strict-origin-when-cross-origin','same-origin','same-origin','active',datetime('now'));

INSERT INTO security_incident_response_plans(id,version,status,severity_matrix_json,roles_json,communications_json,containment_playbooks_json,evidence_preservation_json,notification_matrix_json,created_at)
VALUES('secir_v1',1,'active','{"sev1":"confirmed material compromise/outage with broad impact","sev2":"confirmed compromise with limited impact","sev3":"credible suspected incident","sev4":"security event requiring investigation"}','{"incident_commander":"security/on-call","operations":"operations engineer","communications":"designated incident communications lead","legal_privacy":"designated counsel/privacy lead"}','{"internal":"dedicated incident channel and timeline","external":"status/customer/regulator notices only through approved incident communications"}','{"account_takeover":["revoke sessions","rotate affected credentials","preserve auth logs"],"publisher_upload_malware":["quarantine asset","suspend affected credential","preserve hash/sample reference"],"secret_compromise":["revoke","rotate","audit use","invalidate derived tokens"],"payment":["notify payment provider","disable affected path","preserve provider event ids"]}','{"immutability":"preserve hashes, timestamps, trace/request ids and provider references; restrict evidence access"}','{"assessment":"legal/privacy team determines contractual/regulatory notice duties and deadlines; do not hard-code jurisdictional law in application logic"}',datetime('now'));

-- Security-specific staff capabilities.
INSERT OR IGNORE INTO staff_role_permissions(role_id,permission) VALUES
 ('role_operations_engineer','security.read'),
 ('role_super_admin','security.read'),
 ('role_super_admin','security.manage');

-- Deployment guard: this migration is additive/expand-only. Roll back the application
-- before any later contract/cleanup migration; retain sync/security evidence for audit.
INSERT OR IGNORE INTO ops_migration_controls(migration_name,backward_compatible,rollback_strategy,rollback_sql,minimum_previous_app_version,notes)
VALUES('0036_security_program_conflict_sync_bookmarks.sql',1,'expand_contract','','','Expand-only security/sync schema plus additive version/tombstone columns. Roll back application code first; do not delete bookmark, sync, scan, disclosure, incident, or provenance evidence during a rollback window.');
