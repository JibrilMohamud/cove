-- Commercial fraud/risk and tax-compliance infrastructure.
-- Risk decisions are first-class, auditable policy outputs. Tax is deliberately split
-- between customer transaction tax and publisher payee tax/withholding.

-- ---------------------------------------------------------------------------
-- Risk engine: policy, signals, decisions, holds, graph links, investigations.
-- ---------------------------------------------------------------------------
CREATE TABLE risk_policy_versions (
  id TEXT PRIMARY KEY NOT NULL,
  domain TEXT NOT NULL CHECK(domain IN ('buyer','publisher','community','payout','usage')),
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','retired')),
  policy_json TEXT NOT NULL,
  policy_hash TEXT NOT NULL UNIQUE,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  created_by_user_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(domain,version)
);
CREATE INDEX idx_risk_policy_active ON risk_policy_versions(domain,status,effective_from DESC);

CREATE TABLE risk_events (
  id TEXT PRIMARY KEY NOT NULL,
  domain TEXT NOT NULL CHECK(domain IN ('buyer','publisher','community','payout','usage')),
  event_type TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  user_id TEXT,
  publishing_account_id TEXT REFERENCES publishing_accounts(id) ON DELETE SET NULL,
  order_id TEXT REFERENCES commerce_orders(id) ON DELETE SET NULL,
  payout_item_id TEXT REFERENCES payout_items(id) ON DELETE SET NULL,
  review_id TEXT REFERENCES reviews(id) ON DELETE SET NULL,
  usage_event_id TEXT REFERENCES finance_usage_events(id) ON DELETE SET NULL,
  amount_minor INTEGER,
  currency TEXT,
  territory_code TEXT,
  device_fingerprint_hash TEXT NOT NULL DEFAULT '',
  network_fingerprint_hash TEXT NOT NULL DEFAULT '',
  payment_fingerprint_hash TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT 'fore',
  provider_event_id TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(domain,dedupe_key)
);
CREATE INDEX idx_risk_events_subject ON risk_events(subject_type,subject_id,occurred_at DESC);
CREATE INDEX idx_risk_events_user ON risk_events(user_id,occurred_at DESC);
CREATE INDEX idx_risk_events_publisher ON risk_events(publishing_account_id,occurred_at DESC);
CREATE INDEX idx_risk_events_provider ON risk_events(provider,provider_event_id) WHERE provider_event_id<>'';

CREATE TABLE risk_assessments (
  id TEXT PRIMARY KEY NOT NULL,
  domain TEXT NOT NULL CHECK(domain IN ('buyer','publisher','community','payout','usage')),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  policy_version_id TEXT NOT NULL REFERENCES risk_policy_versions(id) ON DELETE RESTRICT,
  score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
  level TEXT NOT NULL CHECK(level IN ('low','elevated','high','critical')),
  action TEXT NOT NULL CHECK(action IN ('allow','monitor','challenge','hold','block')),
  signals_json TEXT NOT NULL DEFAULT '[]',
  provider_scores_json TEXT NOT NULL DEFAULT '{}',
  input_snapshot_json TEXT NOT NULL DEFAULT '{}',
  supersedes_assessment_id TEXT REFERENCES risk_assessments(id) ON DELETE SET NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_risk_assessments_subject ON risk_assessments(subject_type,subject_id,created_at DESC);
CREATE INDEX idx_risk_assessments_queue ON risk_assessments(domain,action,score DESC,created_at DESC);

CREATE TABLE risk_holds (
  id TEXT PRIMARY KEY NOT NULL,
  assessment_id TEXT REFERENCES risk_assessments(id) ON DELETE SET NULL,
  domain TEXT NOT NULL CHECK(domain IN ('buyer','publisher','community','payout','usage')),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  hold_scope TEXT NOT NULL CHECK(hold_scope IN ('checkout','entitlement','refund','publishing','royalty','payout','review_ranking','usage_credit','account')),
  reason_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','released','converted','expired')),
  amount_minor INTEGER,
  currency TEXT,
  release_conditions_json TEXT NOT NULL DEFAULT '{}',
  created_by_type TEXT NOT NULL DEFAULT 'system' CHECK(created_by_type IN ('system','provider','staff')),
  created_by_user_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  released_at TEXT,
  released_by_user_id TEXT,
  release_note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_risk_holds_active ON risk_holds(subject_type,subject_id,hold_scope,status,created_at DESC);

CREATE TABLE risk_entity_links (
  id TEXT PRIMARY KEY NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  link_type TEXT NOT NULL CHECK(link_type IN ('device','network','payment','identity','payout_destination','content','household','behavioral','manual')),
  confidence REAL NOT NULL CHECK(confidence>=0 AND confidence<=1),
  evidence_hash TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','dismissed','confirmed_abuse')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(NOT(source_type=target_type AND source_id=target_id)),
  UNIQUE(source_type,source_id,target_type,target_id,link_type)
);
CREATE INDEX idx_risk_entity_links_source ON risk_entity_links(source_type,source_id,status,confidence DESC);
CREATE INDEX idx_risk_entity_links_target ON risk_entity_links(target_type,target_id,status,confidence DESC);

CREATE TABLE risk_cases (
  id TEXT PRIMARY KEY NOT NULL,
  case_number TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL CHECK(domain IN ('buyer','publisher','community','payout','usage')),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  assessment_id TEXT REFERENCES risk_assessments(id) ON DELETE SET NULL,
  moderation_case_id TEXT REFERENCES moderation_cases(id) ON DELETE SET NULL,
  publishing_account_id TEXT REFERENCES publishing_accounts(id) ON DELETE SET NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','triage','in_review','waiting_external','actioned','resolved','closed')),
  assigned_to_user_id TEXT REFERENCES staff_principals(user_id) ON DELETE SET NULL,
  summary TEXT NOT NULL DEFAULT '',
  disposition TEXT NOT NULL DEFAULT '' CHECK(disposition IN ('','legitimate','abuse_confirmed','fraud_confirmed','insufficient_evidence','referred','false_positive')),
  sla_due_at TEXT,
  opened_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_risk_cases_queue ON risk_cases(status,priority,domain,opened_at);
CREATE INDEX idx_risk_cases_subject ON risk_cases(subject_type,subject_id,status);

CREATE TABLE risk_case_events (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL REFERENCES risk_cases(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('system','staff','provider')),
  actor_user_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_risk_case_events_case ON risk_case_events(case_id,created_at);

CREATE TABLE risk_provider_signals (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  provider_signal_id TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  score INTEGER CHECK(score IS NULL OR (score BETWEEN 0 AND 100)),
  level TEXT NOT NULL DEFAULT '',
  payload_hash TEXT NOT NULL,
  normalized_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(provider,provider_signal_id)
);
CREATE INDEX idx_risk_provider_subject ON risk_provider_signals(subject_type,subject_id,created_at DESC);

ALTER TABLE finance_usage_events ADD COLUMN device_fingerprint_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE finance_usage_events ADD COLUMN network_fingerprint_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE finance_usage_events ADD COLUMN session_fingerprint_hash TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_usage_device_fingerprint ON finance_usage_events(device_fingerprint_hash,occurred_at DESC) WHERE device_fingerprint_hash<>'';
CREATE INDEX idx_usage_network_fingerprint ON finance_usage_events(network_fingerprint_hash,occurred_at DESC) WHERE network_fingerprint_hash<>'';

ALTER TABLE commerce_orders ADD COLUMN risk_assessment_id TEXT REFERENCES risk_assessments(id) ON DELETE SET NULL;
ALTER TABLE commerce_orders ADD COLUMN risk_action TEXT NOT NULL DEFAULT 'allow';
ALTER TABLE commerce_refunds ADD COLUMN risk_assessment_id TEXT REFERENCES risk_assessments(id) ON DELETE SET NULL;
ALTER TABLE payout_items ADD COLUMN risk_assessment_id TEXT REFERENCES risk_assessments(id) ON DELETE SET NULL;
ALTER TABLE payout_items ADD COLUMN hold_reason_code TEXT NOT NULL DEFAULT '';
ALTER TABLE publishing_accounts ADD COLUMN risk_score INTEGER NOT NULL DEFAULT 0 CHECK(risk_score BETWEEN 0 AND 100);
ALTER TABLE publishing_accounts ADD COLUMN risk_level TEXT NOT NULL DEFAULT 'low' CHECK(risk_level IN ('low','elevated','high','critical'));

-- Default policies are deliberately data, not hard-coded thresholds.
INSERT INTO risk_policy_versions(id,domain,version,status,policy_json,policy_hash,effective_from,created_at) VALUES
('risk-buyer-v1','buyer',1,'active','{"thresholds":{"monitor":25,"challenge":50,"hold":70,"block":90},"weights":{"recentPaymentFailures":8,"refundRatio":35,"disputeHistory":40,"promoVelocity":20,"giftCardHeavy":15,"giftCardReuse":45,"publisherSelfPurchase":30,"linkedAbuse":45,"processorHighRisk":55,"activeAccountHold":80,"securityChangeBurst":55,"countryVelocity":45}}','risk-buyer-v1-bootstrap',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('risk-publisher-v1','publisher',1,'active','{"thresholds":{"monitor":20,"challenge":45,"hold":65,"block":90},"weights":{"identityUnverified":40,"taxUnverified":25,"payoutUnverified":25,"duplicateContent":45,"confirmedRiskLink":55,"activeSanction":60,"payoutDestinationReuse":45}}','risk-publisher-v1-bootstrap',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('risk-community-v1','community',1,'active','{"thresholds":{"monitor":25,"challenge":50,"hold":70,"block":90},"weights":{"reviewSignals":45,"voteSignals":40,"linkedAbuse":35,"velocity":35}}','risk-community-v1-bootstrap',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('risk-payout-v1','payout',1,'active','{"thresholds":{"monitor":20,"challenge":40,"hold":60,"block":90},"weights":{"publisherRisk":60,"taxNotVerified":60,"payoutNotVerified":60,"destinationChanged":35,"rightsHold":70}}','risk-payout-v1-bootstrap',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('risk-usage-v1','usage',1,'active','{"thresholds":{"monitor":25,"challenge":50,"hold":70,"block":90},"weights":{"velocity":45,"linkedAccounts":40,"repeatedSource":70,"impossibleConsumption":60}}','risk-usage-v1-bootstrap',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- ---------------------------------------------------------------------------
-- Customer transaction tax: registrations, evidence, immutable calculations,
-- provider transactions/reversals and reconciliation.
-- ---------------------------------------------------------------------------
CREATE TABLE commerce_tax_registrations (
  id TEXT PRIMARY KEY NOT NULL,
  jurisdiction_code TEXT NOT NULL,
  tax_type TEXT NOT NULL CHECK(tax_type IN ('sales_tax','vat','gst','hst','pst','digital_services','other')),
  provider TEXT NOT NULL,
  provider_registration_reference TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending','active','suspended','ended')),
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  filing_frequency TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(jurisdiction_code,tax_type,effective_from)
);
CREATE INDEX idx_tax_registration_active ON commerce_tax_registrations(status,jurisdiction_code,effective_from);

CREATE TABLE commerce_tax_evidence (
  id TEXT PRIMARY KEY NOT NULL,
  quote_id TEXT REFERENCES commerce_checkout_quotes(id) ON DELETE SET NULL,
  order_id TEXT REFERENCES commerce_orders(id) ON DELETE SET NULL,
  user_id TEXT,
  evidence_type TEXT NOT NULL CHECK(evidence_type IN ('billing_address','ip_country','payment_country','customer_tax_id','tax_exemption','storefront_country')),
  country_code TEXT NOT NULL DEFAULT '',
  subdivision_code TEXT NOT NULL DEFAULT '',
  postal_prefix TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  provider_reference TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  collected_at TEXT NOT NULL
);
CREATE INDEX idx_tax_evidence_order ON commerce_tax_evidence(order_id,collected_at);
CREATE INDEX idx_tax_evidence_quote ON commerce_tax_evidence(quote_id,collected_at);

CREATE TABLE commerce_tax_records (
  id TEXT PRIMARY KEY NOT NULL,
  quote_id TEXT REFERENCES commerce_checkout_quotes(id) ON DELETE SET NULL,
  order_id TEXT REFERENCES commerce_orders(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  provider_calculation_id TEXT NOT NULL DEFAULT '',
  provider_transaction_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('calculated','committed','reversed','void','failed')),
  currency TEXT NOT NULL,
  taxable_minor INTEGER NOT NULL DEFAULT 0,
  tax_exclusive_minor INTEGER NOT NULL DEFAULT 0,
  tax_inclusive_minor INTEGER NOT NULL DEFAULT 0,
  jurisdiction_summary_json TEXT NOT NULL DEFAULT '[]',
  line_items_json TEXT NOT NULL DEFAULT '[]',
  evidence_snapshot_hash TEXT NOT NULL DEFAULT '',
  provider_payload_hash TEXT NOT NULL DEFAULT '',
  calculated_at TEXT NOT NULL,
  committed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(provider,provider_calculation_id)
);
CREATE INDEX idx_tax_records_order ON commerce_tax_records(order_id,status,updated_at DESC);

CREATE TABLE commerce_tax_reversals (
  id TEXT PRIMARY KEY NOT NULL,
  tax_record_id TEXT NOT NULL REFERENCES commerce_tax_records(id) ON DELETE RESTRICT,
  refund_id TEXT NOT NULL REFERENCES commerce_refunds(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  provider_reversal_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','committed','failed','void')),
  payload_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider,provider_reversal_id),
  UNIQUE(refund_id)
);

CREATE TABLE commerce_tax_reconciliation_runs (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','complete','failed')),
  checked_count INTEGER NOT NULL DEFAULT 0,
  mismatch_count INTEGER NOT NULL DEFAULT 0,
  repaired_count INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  finished_at TEXT
);

-- ---------------------------------------------------------------------------
-- Publisher/payee tax: validated provider profiles, effective withholding and reporting.
-- Raw TINs and forms remain at specialist providers; Cove stores references/status only.
-- ---------------------------------------------------------------------------
ALTER TABLE publishing_tax_profiles ADD COLUMN entity_type TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE publishing_tax_profiles ADD COLUMN tax_residency_country TEXT NOT NULL DEFAULT '';
ALTER TABLE publishing_tax_profiles ADD COLUMN tin_last4 TEXT NOT NULL DEFAULT '';
ALTER TABLE publishing_tax_profiles ADD COLUMN provider_verification_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE publishing_tax_profiles ADD COLUMN form_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE publishing_tax_profiles ADD COLUMN reportable INTEGER NOT NULL DEFAULT 1 CHECK(reportable IN (0,1));
ALTER TABLE publishing_tax_profiles ADD COLUMN treaty_rate_bps INTEGER CHECK(treaty_rate_bps IS NULL OR (treaty_rate_bps BETWEEN 0 AND 10000));
ALTER TABLE publishing_tax_profiles ADD COLUMN backup_withholding_bps INTEGER NOT NULL DEFAULT 0 CHECK(backup_withholding_bps BETWEEN 0 AND 10000);
ALTER TABLE publishing_tax_profiles ADD COLUMN effective_withholding_bps INTEGER NOT NULL DEFAULT 0 CHECK(effective_withholding_bps BETWEEN 0 AND 10000);
ALTER TABLE publishing_tax_profiles ADD COLUMN compliance_snapshot_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE publishing_tax_profiles ADD COLUMN next_review_at TEXT;

CREATE TABLE publisher_tax_withholding_rules (
  id TEXT PRIMARY KEY NOT NULL,
  rule_key TEXT NOT NULL,
  payee_country_code TEXT,
  income_type TEXT NOT NULL DEFAULT 'royalty' CHECK(income_type IN ('royalty','service','interest','other')),
  form_type TEXT,
  treaty_country_code TEXT,
  default_withholding_bps INTEGER NOT NULL CHECK(default_withholding_bps BETWEEN 0 AND 10000),
  treaty_withholding_bps INTEGER CHECK(treaty_withholding_bps IS NULL OR (treaty_withholding_bps BETWEEN 0 AND 10000)),
  backup_withholding_bps INTEGER CHECK(backup_withholding_bps IS NULL OR (backup_withholding_bps BETWEEN 0 AND 10000)),
  conditions_json TEXT NOT NULL DEFAULT '{}',
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  source_reference TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','retired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(rule_key,effective_from)
);
CREATE INDEX idx_tax_withholding_rules_active ON publisher_tax_withholding_rules(status,payee_country_code,income_type,effective_from);

CREATE TABLE publisher_tax_verification_events (
  id TEXT PRIMARY KEY NOT NULL,
  tax_profile_id TEXT NOT NULL REFERENCES publishing_tax_profiles(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  reason_code TEXT NOT NULL DEFAULT '',
  payload_hash TEXT NOT NULL,
  normalized_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(provider,provider_event_id)
);
CREATE INDEX idx_publisher_tax_events_profile ON publisher_tax_verification_events(tax_profile_id,occurred_at DESC);

CREATE TABLE publisher_tax_reporting_periods (
  id TEXT PRIMARY KEY NOT NULL,
  publishing_account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE RESTRICT,
  tax_year INTEGER NOT NULL,
  jurisdiction TEXT NOT NULL,
  form_family TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','review','ready','filed','corrected','void')),
  gross_reportable_minor INTEGER NOT NULL DEFAULT 0,
  withheld_minor INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  provider TEXT NOT NULL DEFAULT '',
  provider_filing_reference TEXT NOT NULL DEFAULT '',
  reconciliation_json TEXT NOT NULL DEFAULT '{}',
  opened_at TEXT NOT NULL,
  filed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(publishing_account_id,tax_year,jurisdiction,form_family)
);
CREATE INDEX idx_publisher_tax_reporting_status ON publisher_tax_reporting_periods(status,tax_year,jurisdiction);

ALTER TABLE finance_royalty_allocations ADD COLUMN tax_profile_id TEXT REFERENCES publishing_tax_profiles(id) ON DELETE SET NULL;
ALTER TABLE finance_royalty_allocations ADD COLUMN withholding_rule_id TEXT REFERENCES publisher_tax_withholding_rules(id) ON DELETE SET NULL;
ALTER TABLE payout_items ADD COLUMN tax_profile_id TEXT REFERENCES publishing_tax_profiles(id) ON DELETE SET NULL;

-- Fraud decisions and compliance evidence are append-only. Operational status lives on holds/cases.
CREATE TRIGGER trg_risk_events_immutable_update BEFORE UPDATE ON risk_events BEGIN SELECT RAISE(ABORT,'risk events are immutable'); END;
CREATE TRIGGER trg_risk_events_immutable_delete BEFORE DELETE ON risk_events BEGIN SELECT RAISE(ABORT,'risk events are immutable'); END;
CREATE TRIGGER trg_risk_assessments_immutable_update BEFORE UPDATE ON risk_assessments BEGIN SELECT RAISE(ABORT,'risk assessments are immutable'); END;
CREATE TRIGGER trg_risk_assessments_immutable_delete BEFORE DELETE ON risk_assessments BEGIN SELECT RAISE(ABORT,'risk assessments are immutable'); END;
CREATE TRIGGER trg_tax_evidence_protect_update BEFORE UPDATE ON commerce_tax_evidence
WHEN NEW.quote_id IS NOT OLD.quote_id OR NEW.user_id IS NOT OLD.user_id OR NEW.evidence_type IS NOT OLD.evidence_type OR NEW.country_code IS NOT OLD.country_code OR NEW.subdivision_code IS NOT OLD.subdivision_code OR NEW.postal_prefix IS NOT OLD.postal_prefix OR NEW.source IS NOT OLD.source OR NEW.evidence_hash IS NOT OLD.evidence_hash OR NEW.metadata_json IS NOT OLD.metadata_json OR NEW.collected_at IS NOT OLD.collected_at
BEGIN SELECT RAISE(ABORT,'tax evidence is immutable'); END;
CREATE TRIGGER trg_tax_evidence_immutable_delete BEFORE DELETE ON commerce_tax_evidence BEGIN SELECT RAISE(ABORT,'tax evidence is immutable'); END;
CREATE TRIGGER trg_publisher_tax_events_immutable_update BEFORE UPDATE ON publisher_tax_verification_events BEGIN SELECT RAISE(ABORT,'publisher tax verification events are immutable'); END;
CREATE TRIGGER trg_publisher_tax_events_immutable_delete BEFORE DELETE ON publisher_tax_verification_events BEGIN SELECT RAISE(ABORT,'publisher tax verification events are immutable'); END;

-- Staff permissions for dedicated fraud/tax operations.
INSERT OR IGNORE INTO staff_role_permissions(role_id,permission) VALUES
 ('role_fraud','risk.case.read'),('role_fraud','risk.case.manage'),('role_fraud','risk.hold.manage'),('role_fraud','risk.link.manage'),
 ('role_trust_safety','risk.case.read'),
 ('role_senior_moderator','risk.case.read'),('role_senior_moderator','risk.case.manage'),('role_senior_moderator','risk.hold.manage'),
 ('role_finance_ops','tax.compliance.read'),('role_finance_ops','tax.compliance.manage'),
 ('role_moderation_admin','risk.case.read'),('role_moderation_admin','risk.case.manage'),('role_moderation_admin','risk.hold.manage'),('role_moderation_admin','risk.link.manage'),('role_moderation_admin','risk.policy.manage'),('role_moderation_admin','tax.compliance.read'),('role_moderation_admin','tax.compliance.manage');
