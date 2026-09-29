-- Commercial creator commerce: versioned royalty rules, creator reporting, preorders, and promotions.
-- The rule engine is append-only. Historical royalty calculations snapshot the inputs and exact rule/version used.

ALTER TABLE finance_royalty_contract_versions ADD COLUMN rules_version_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE finance_royalty_contract_versions ADD COLUMN default_royalty_rate_bps INTEGER;
ALTER TABLE finance_royalty_contract_versions ADD COLUMN effective_to TEXT;
ALTER TABLE finance_royalty_contract_versions ADD COLUMN notes TEXT NOT NULL DEFAULT '';

ALTER TABLE finance_royalty_events ADD COLUMN royalty_calculation_id TEXT;
ALTER TABLE finance_royalty_events ADD COLUMN sales_channel TEXT NOT NULL DEFAULT 'retail';
ALTER TABLE finance_royalty_events ADD COLUMN territory_code TEXT;
ALTER TABLE finance_royalty_events ADD COLUMN product_id TEXT;

ALTER TABLE commerce_order_items ADD COLUMN sales_channel TEXT NOT NULL DEFAULT 'retail';
ALTER TABLE commerce_order_items ADD COLUMN fulfillment_type TEXT NOT NULL DEFAULT 'immediate';
ALTER TABLE commerce_order_items ADD COLUMN fulfillment_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE commerce_order_items ADD COLUMN preorder_id TEXT;
ALTER TABLE commerce_order_items ADD COLUMN promotion_campaign_id TEXT;
ALTER TABLE commerce_order_items ADD COLUMN publisher_discount_funding_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE commerce_order_items ADD COLUMN fore_discount_funding_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE commerce_order_items ADD COLUMN processor_fee_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE commerce_order_items ADD COLUMN distributor_fee_minor INTEGER NOT NULL DEFAULT 0;

ALTER TABLE commerce_promo_codes ADD COLUMN campaign_id TEXT;
ALTER TABLE commerce_promo_codes ADD COLUMN funding_source TEXT NOT NULL DEFAULT 'fore';
ALTER TABLE commerce_promo_codes ADD COLUMN publisher_funding_bps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE commerce_promo_codes ADD COLUMN eligible_products_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE commerce_promo_codes ADD COLUMN stackable INTEGER NOT NULL DEFAULT 0;

ALTER TABLE promotions ADD COLUMN campaign_id TEXT;
ALTER TABLE promotions ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS finance_royalty_rules (
  id TEXT PRIMARY KEY NOT NULL,
  contract_version_id TEXT NOT NULL REFERENCES finance_royalty_contract_versions(id) ON DELETE RESTRICT,
  rule_key TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  conditions_json TEXT NOT NULL DEFAULT '{}',
  action_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(contract_version_id, rule_key)
);
CREATE INDEX IF NOT EXISTS idx_finance_royalty_rules_version ON finance_royalty_rules(contract_version_id,priority,rule_key);

CREATE TABLE IF NOT EXISTS finance_royalty_calculations (
  id TEXT PRIMARY KEY NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('sale','refund','chargeback','subscription','library','wholesale','agency','promotion_adjustment','manual_adjustment')),
  source_id TEXT NOT NULL,
  order_id TEXT REFERENCES commerce_orders(id) ON DELETE RESTRICT,
  order_item_id TEXT REFERENCES commerce_order_items(id) ON DELETE RESTRICT,
  usage_event_id TEXT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  contract_id TEXT NOT NULL REFERENCES finance_royalty_contracts(id) ON DELETE RESTRICT,
  contract_version_id TEXT NOT NULL REFERENCES finance_royalty_contract_versions(id) ON DELETE RESTRICT,
  contract_version_hash TEXT NOT NULL,
  rule_id TEXT REFERENCES finance_royalty_rules(id) ON DELETE RESTRICT,
  territory_code TEXT,
  format TEXT,
  sales_channel TEXT NOT NULL,
  currency TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  list_price_minor INTEGER NOT NULL DEFAULT 0,
  customer_price_minor INTEGER NOT NULL DEFAULT 0,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  processor_fee_minor INTEGER NOT NULL DEFAULT 0,
  promotion_discount_minor INTEGER NOT NULL DEFAULT 0,
  fore_funded_discount_minor INTEGER NOT NULL DEFAULT 0,
  publisher_funded_discount_minor INTEGER NOT NULL DEFAULT 0,
  distributor_fee_minor INTEGER NOT NULL DEFAULT 0,
  net_receipts_minor INTEGER NOT NULL DEFAULT 0,
  basis_minor INTEGER NOT NULL,
  fore_commission_minor INTEGER NOT NULL DEFAULT 0,
  royalty_pool_minor INTEGER NOT NULL,
  rule_trace_json TEXT NOT NULL DEFAULT '[]',
  input_snapshot_json TEXT NOT NULL,
  calculated_at TEXT NOT NULL,
  UNIQUE(source_type,source_id,product_id,contract_version_id)
);
CREATE INDEX IF NOT EXISTS idx_finance_royalty_calculations_product ON finance_royalty_calculations(product_id,calculated_at DESC);
CREATE INDEX IF NOT EXISTS idx_finance_royalty_calculations_contract ON finance_royalty_calculations(contract_version_id,calculated_at DESC);

CREATE TABLE IF NOT EXISTS finance_royalty_allocations (
  id TEXT PRIMARY KEY NOT NULL,
  calculation_id TEXT NOT NULL REFERENCES finance_royalty_calculations(id) ON DELETE RESTRICT,
  party_id TEXT NOT NULL REFERENCES finance_parties(id) ON DELETE RESTRICT,
  share_bps INTEGER NOT NULL,
  royalty_minor INTEGER NOT NULL,
  withholding_minor INTEGER NOT NULL DEFAULT 0,
  reserve_minor INTEGER NOT NULL DEFAULT 0,
  payable_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accrued' CHECK(status IN ('accrued','payable','paid','reversed','held')),
  available_at TEXT NOT NULL,
  legacy_royalty_event_id TEXT REFERENCES finance_royalty_events(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(calculation_id,party_id)
);
CREATE INDEX IF NOT EXISTS idx_finance_royalty_allocations_party ON finance_royalty_allocations(party_id,status,available_at,currency);

CREATE TABLE IF NOT EXISTS payout_allocation_links (
  payout_item_id TEXT NOT NULL REFERENCES payout_items(id) ON DELETE CASCADE,
  royalty_allocation_id TEXT NOT NULL REFERENCES finance_royalty_allocations(id) ON DELETE RESTRICT,
  PRIMARY KEY(payout_item_id,royalty_allocation_id)
);

CREATE TABLE IF NOT EXISTS finance_usage_events (
  id TEXT PRIMARY KEY NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('subscription_read','subscription_listen','library_loan','library_read','library_listen','wholesale_unit','agency_unit')),
  source_reference TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  user_id TEXT,
  territory_code TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  units REAL NOT NULL DEFAULT 0,
  pages_read INTEGER NOT NULL DEFAULT 0,
  seconds_consumed INTEGER NOT NULL DEFAULT 0,
  gross_value_minor INTEGER NOT NULL DEFAULT 0,
  pool_id TEXT,
  occurred_at TEXT NOT NULL,
  processed_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(source_type,source_reference)
);
CREATE INDEX IF NOT EXISTS idx_finance_usage_events_processing ON finance_usage_events(processed_at,occurred_at,source_type);
CREATE INDEX IF NOT EXISTS idx_finance_usage_events_product ON finance_usage_events(product_id,occurred_at DESC);

CREATE TABLE IF NOT EXISTS finance_usage_pools (
  id TEXT PRIMARY KEY NOT NULL,
  pool_type TEXT NOT NULL CHECK(pool_type IN ('subscription','library','wholesale')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  territory_code TEXT,
  currency TEXT NOT NULL,
  pool_minor INTEGER NOT NULL,
  metric TEXT NOT NULL CHECK(metric IN ('units','pages','seconds','weighted')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','locked','allocated','closed')),
  rules_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  locked_at TEXT,
  allocated_at TEXT,
  UNIQUE(pool_type,period_start,period_end,territory_code,currency)
);

CREATE TABLE IF NOT EXISTS creator_daily_metrics (
  publishing_account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE CASCADE,
  metric_date TEXT NOT NULL,
  product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
  territory_code TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'USD',
  sales_units INTEGER NOT NULL DEFAULT 0,
  preorder_units INTEGER NOT NULL DEFAULT 0,
  refund_units INTEGER NOT NULL DEFAULT 0,
  gross_revenue_minor INTEGER NOT NULL DEFAULT 0,
  discounts_minor INTEGER NOT NULL DEFAULT 0,
  refunds_minor INTEGER NOT NULL DEFAULT 0,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  net_revenue_minor INTEGER NOT NULL DEFAULT 0,
  royalties_minor INTEGER NOT NULL DEFAULT 0,
  subscription_units REAL NOT NULL DEFAULT 0,
  subscription_pages INTEGER NOT NULL DEFAULT 0,
  audiobook_seconds INTEGER NOT NULL DEFAULT 0,
  library_units REAL NOT NULL DEFAULT 0,
  wishlist_adds INTEGER NOT NULL DEFAULT 0,
  promotion_impressions INTEGER NOT NULL DEFAULT 0,
  promotion_clicks INTEGER NOT NULL DEFAULT 0,
  promotion_orders INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(publishing_account_id,metric_date,product_id,territory_code,format,currency)
);
CREATE INDEX IF NOT EXISTS idx_creator_metrics_account_date ON creator_daily_metrics(publishing_account_id,metric_date DESC);

CREATE TABLE IF NOT EXISTS creator_statement_exports (
  id TEXT PRIMARY KEY NOT NULL,
  publishing_account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE CASCADE,
  statement_id TEXT REFERENCES finance_statements(id) ON DELETE SET NULL,
  export_type TEXT NOT NULL CHECK(export_type IN ('monthly_statement_csv','sales_csv','royalty_csv','tax_document')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  object_key TEXT,
  sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('generating','ready','failed','expired')),
  generated_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_creator_exports_account ON creator_statement_exports(publishing_account_id,generated_at DESC);

CREATE TABLE IF NOT EXISTS creator_tax_documents (
  id TEXT PRIMARY KEY NOT NULL,
  publishing_account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE CASCADE,
  tax_year INTEGER NOT NULL,
  jurisdiction TEXT NOT NULL,
  document_type TEXT NOT NULL,
  provider_reference TEXT NOT NULL DEFAULT '',
  object_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','available','corrected','void')),
  available_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(publishing_account_id,tax_year,jurisdiction,document_type)
);

CREATE TABLE IF NOT EXISTS preorder_release_plans (
  id TEXT PRIMARY KEY NOT NULL,
  publishing_edition_id TEXT NOT NULL REFERENCES publishing_edition_drafts(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  publication_id TEXT REFERENCES publishing_publications(id) ON DELETE SET NULL,
  opens_at TEXT NOT NULL,
  release_at TEXT NOT NULL,
  manuscript_deadline_at TEXT NOT NULL,
  payment_timing TEXT NOT NULL DEFAULT 'charge_now' CHECK(payment_timing IN ('charge_now','charge_at_release')),
  price_guarantee_policy TEXT NOT NULL DEFAULT 'lowest_price' CHECK(price_guarantee_policy IN ('none','lowest_price')),
  cancellation_policy TEXT NOT NULL DEFAULT 'customer_until_release',
  failure_policy TEXT NOT NULL DEFAULT 'auto_refund_and_penalty',
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('draft','scheduled','open','locked','released','canceled','failed')),
  created_by_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(publishing_edition_id)
);
CREATE INDEX IF NOT EXISTS idx_preorder_release_plans_due ON preorder_release_plans(status,release_at);

CREATE TABLE IF NOT EXISTS preorders (
  id TEXT PRIMARY KEY NOT NULL,
  release_plan_id TEXT NOT NULL REFERENCES preorder_release_plans(id) ON DELETE RESTRICT,
  order_item_id TEXT NOT NULL UNIQUE REFERENCES commerce_order_items(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL REFERENCES commerce_orders(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  currency TEXT NOT NULL,
  original_price_minor INTEGER NOT NULL,
  guaranteed_price_minor INTEGER NOT NULL,
  charged_minor INTEGER NOT NULL DEFAULT 0,
  payment_timing TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'paid_pending_release' CHECK(status IN ('reserved','payment_pending','paid_pending_release','cancellation_requested','released','customer_canceled','publisher_canceled','delivery_failed','refunded')),
  entitlement_id TEXT,
  created_at TEXT NOT NULL,
  canceled_at TEXT,
  released_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_preorders_release ON preorders(release_plan_id,status,created_at);
CREATE INDEX IF NOT EXISTS idx_preorders_user ON preorders(user_id,status,created_at DESC);


CREATE TABLE IF NOT EXISTS preorder_policy_versions (
  id TEXT PRIMARY KEY NOT NULL,
  policy_key TEXT NOT NULL DEFAULT 'fore-preorder',
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','retired')),
  max_horizon_days INTEGER NOT NULL DEFAULT 548,
  manuscript_lead_hours INTEGER NOT NULL DEFAULT 72,
  customer_cancellation_until_release INTEGER NOT NULL DEFAULT 1,
  missed_deadline_penalty_points INTEGER NOT NULL DEFAULT 1,
  repeat_failure_threshold INTEGER NOT NULL DEFAULT 3,
  rules_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(policy_key,version)
);
INSERT OR IGNORE INTO preorder_policy_versions(id,policy_key,version,status,max_horizon_days,manuscript_lead_hours,customer_cancellation_until_release,missed_deadline_penalty_points,repeat_failure_threshold,rules_json,created_at) VALUES('preorder_policy_v1','fore-preorder',1,'active',548,72,1,1,3,'{"paymentTiming":"charge_now","priceGuarantee":"lowest_price","publisherFailure":"refund_and_incident"}',datetime('now'));

CREATE TABLE IF NOT EXISTS preorder_price_adjustments (
  id TEXT PRIMARY KEY NOT NULL,
  preorder_id TEXT NOT NULL REFERENCES preorders(id) ON DELETE RESTRICT,
  previous_guaranteed_minor INTEGER NOT NULL,
  new_guaranteed_minor INTEGER NOT NULL,
  adjustment_minor INTEGER NOT NULL,
  reason TEXT NOT NULL,
  refund_job_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_preorder_price_adjustments ON preorder_price_adjustments(preorder_id,created_at);

CREATE TABLE IF NOT EXISTS preorder_refund_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  preorder_id TEXT NOT NULL REFERENCES preorders(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL REFERENCES commerce_orders(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','leased','succeeded','failed','canceled')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_expires_at TEXT,
  provider_refund_id TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_preorder_refund_jobs_queue ON preorder_refund_jobs(status,created_at);

CREATE TABLE IF NOT EXISTS preorder_events (
  id TEXT PRIMARY KEY NOT NULL,
  preorder_id TEXT NOT NULL REFERENCES preorders(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  event_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_preorder_events_preorder ON preorder_events(preorder_id,created_at);

CREATE TABLE IF NOT EXISTS publishing_preorder_incidents (
  id TEXT PRIMARY KEY NOT NULL,
  publishing_account_id TEXT NOT NULL REFERENCES publishing_accounts(id) ON DELETE CASCADE,
  release_plan_id TEXT NOT NULL REFERENCES preorder_release_plans(id) ON DELETE RESTRICT,
  incident_type TEXT NOT NULL CHECK(incident_type IN ('missed_manuscript_deadline','release_delay','publisher_cancellation','delivery_failure')),
  severity TEXT NOT NULL DEFAULT 'warning' CHECK(severity IN ('warning','restriction','severe')),
  preorder_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','waived')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS promotion_campaigns (
  id TEXT PRIMARY KEY NOT NULL,
  publishing_account_id TEXT REFERENCES publishing_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  campaign_type TEXT NOT NULL CHECK(campaign_type IN ('scheduled_price_drop','daily_deal','genre_sale','publisher_sale','coupon','free_promotion','first_in_series','bundle','launch_pricing','seasonal','countdown')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','scheduled','live','ended','canceled','rejected')),
  funding_source TEXT NOT NULL DEFAULT 'publisher' CHECK(funding_source IN ('publisher','fore','shared')),
  publisher_funding_bps INTEGER NOT NULL DEFAULT 10000,
  currency TEXT,
  territory_code TEXT,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  budget_minor INTEGER,
  max_redemptions INTEGER,
  stackable INTEGER NOT NULL DEFAULT 0,
  eligibility_json TEXT NOT NULL DEFAULT '{}',
  merchandising_submission INTEGER NOT NULL DEFAULT 0,
  submitted_at TEXT,
  approved_at TEXT,
  created_by_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_promotion_campaigns_status ON promotion_campaigns(status,starts_at,ends_at);
CREATE INDEX IF NOT EXISTS idx_promotion_campaigns_publisher ON promotion_campaigns(publishing_account_id,created_at DESC);

CREATE TABLE IF NOT EXISTS promotion_campaign_products (
  campaign_id TEXT NOT NULL REFERENCES promotion_campaigns(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  offer_id TEXT REFERENCES offers(id) ON DELETE SET NULL,
  role TEXT NOT NULL DEFAULT 'featured',
  original_price_minor INTEGER,
  promotional_price_minor INTEGER,
  publisher_funding_bps INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(campaign_id,product_id)
);
CREATE INDEX IF NOT EXISTS idx_promotion_products_product ON promotion_campaign_products(product_id,campaign_id);

CREATE TABLE IF NOT EXISTS promotion_attribution_events (
  id TEXT PRIMARY KEY NOT NULL,
  campaign_id TEXT NOT NULL REFERENCES promotion_campaigns(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
  user_id TEXT,
  visitor_id TEXT,
  event_type TEXT NOT NULL CHECK(event_type IN ('impression','click','wishlist','cart','order','refund')),
  order_id TEXT REFERENCES commerce_orders(id) ON DELETE SET NULL,
  order_item_id TEXT REFERENCES commerce_order_items(id) ON DELETE SET NULL,
  amount_minor INTEGER NOT NULL DEFAULT 0,
  currency TEXT,
  source_surface TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_promotion_attribution_campaign ON promotion_attribution_events(campaign_id,event_type,created_at);
CREATE INDEX IF NOT EXISTS idx_promotion_attribution_product ON promotion_attribution_events(product_id,event_type,created_at);

CREATE TABLE IF NOT EXISTS promotion_campaign_events (
  id TEXT PRIMARY KEY NOT NULL,
  campaign_id TEXT NOT NULL REFERENCES promotion_campaigns(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  event_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_promotion_campaign_events ON promotion_campaign_events(campaign_id,created_at);

-- Historical contractual evidence and accounting decisions are append-only.
CREATE TRIGGER IF NOT EXISTS trg_finance_royalty_contract_versions_immutable_update
BEFORE UPDATE ON finance_royalty_contract_versions BEGIN SELECT RAISE(ABORT,'royalty contract versions are immutable; create a new version'); END;
CREATE TRIGGER IF NOT EXISTS trg_finance_royalty_contract_versions_immutable_delete
BEFORE DELETE ON finance_royalty_contract_versions BEGIN SELECT RAISE(ABORT,'royalty contract versions cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_finance_royalty_rules_immutable_update
BEFORE UPDATE ON finance_royalty_rules BEGIN SELECT RAISE(ABORT,'royalty rules are immutable; create a new contract version'); END;
CREATE TRIGGER IF NOT EXISTS trg_finance_royalty_rules_immutable_delete
BEFORE DELETE ON finance_royalty_rules BEGIN SELECT RAISE(ABORT,'royalty rules cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_finance_royalty_calculations_immutable_update
BEFORE UPDATE ON finance_royalty_calculations BEGIN SELECT RAISE(ABORT,'royalty calculations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_finance_royalty_calculations_immutable_delete
BEFORE DELETE ON finance_royalty_calculations BEGIN SELECT RAISE(ABORT,'royalty calculations cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS trg_preorder_events_append_only_update
BEFORE UPDATE ON preorder_events BEGIN SELECT RAISE(ABORT,'preorder events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_preorder_events_append_only_delete
BEFORE DELETE ON preorder_events BEGIN SELECT RAISE(ABORT,'preorder events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_promotion_campaign_events_append_only_update
BEFORE UPDATE ON promotion_campaign_events BEGIN SELECT RAISE(ABORT,'promotion campaign events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_promotion_campaign_events_append_only_delete
BEFORE DELETE ON promotion_campaign_events BEGIN SELECT RAISE(ABORT,'promotion campaign events are append-only'); END;

-- Backfill compatibility: old contract versions become explicit default rules.
INSERT OR IGNORE INTO finance_royalty_rules(id,contract_version_id,rule_key,priority,conditions_json,action_json,created_at)
SELECT 'rule_legacy_'||id,id,'legacy_default',100,'{}',json_object(
  'basis',calculation_basis,
  'foreCommissionBps',fore_commission_bps,
  'reserveBps',reserve_bps,
  'paymentTermsDays',payment_terms_days
),created_at FROM finance_royalty_contract_versions;

ALTER TABLE finance_statements ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE finance_statements ADD COLUMN finalized_at TEXT;
ALTER TABLE finance_statements ADD COLUMN calculation_cutoff_at TEXT;
ALTER TABLE finance_statements ADD COLUMN snapshot_sha256 TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS finance_statement_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  statement_id TEXT NOT NULL REFERENCES finance_statements(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('final','corrected')),
  snapshot_json TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  UNIQUE(statement_id,revision)
);
CREATE TRIGGER IF NOT EXISTS trg_finance_statement_revisions_immutable_update
BEFORE UPDATE ON finance_statement_revisions BEGIN SELECT RAISE(ABORT,'statement revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_finance_statement_revisions_immutable_delete
BEFORE DELETE ON finance_statement_revisions BEGIN SELECT RAISE(ABORT,'statement revisions cannot be deleted'); END;
