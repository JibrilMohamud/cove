-- Commercial pricing + multi-party finance layer.
ALTER TABLE commerce_order_items ADD COLUMN pricing_decision_id text;
ALTER TABLE commerce_order_items ADD COLUMN royalty_contract_version_id text;
ALTER TABLE commerce_order_items ADD COLUMN recognized_revenue_minor integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS pricing_policies (
  id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','retired')),
  base_currency text NOT NULL DEFAULT 'USD',
  rounding_rule text NOT NULL DEFAULT 'psychological_99',
  fx_markup_bps integer NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS pricing_region_rules (
  id text PRIMARY KEY,
  policy_id text NOT NULL REFERENCES pricing_policies(id) ON DELETE CASCADE,
  territory_code text NOT NULL,
  currency text NOT NULL,
  floor_minor integer,
  ceiling_minor integer,
  tax_inclusive integer NOT NULL DEFAULT 0,
  fx_source text NOT NULL DEFAULT 'manual',
  active integer NOT NULL DEFAULT 1,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  UNIQUE(policy_id,territory_code,currency)
);

CREATE TABLE IF NOT EXISTS fx_rates (
  id text PRIMARY KEY,
  base_currency text NOT NULL,
  quote_currency text NOT NULL,
  rate_ppm integer NOT NULL,
  source text NOT NULL,
  effective_at text NOT NULL,
  expires_at text,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fx_rates_pair ON fx_rates(base_currency,quote_currency,effective_at DESC);

CREATE TABLE IF NOT EXISTS product_pricing_assignments (
  product_id text PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  policy_id text NOT NULL REFERENCES pricing_policies(id) ON DELETE RESTRICT,
  base_offer_id text REFERENCES offers(id) ON DELETE SET NULL,
  preorder_guarantee integer NOT NULL DEFAULT 1,
  minimum_advertised_price_minor integer,
  publisher_floor_minor integer,
  updated_at text NOT NULL
);

ALTER TABLE price_schedules ADD COLUMN territory_code text;
ALTER TABLE price_schedules ADD COLUMN price_kind text NOT NULL DEFAULT 'list' CHECK(price_kind IN ('list','sale','preorder','introductory'));
ALTER TABLE price_schedules ADD COLUMN source text NOT NULL DEFAULT 'publisher';
ALTER TABLE price_schedules ADD COLUMN reason text NOT NULL DEFAULT '';
ALTER TABLE price_schedules ADD COLUMN created_at text;
CREATE INDEX IF NOT EXISTS idx_price_schedules_scope ON price_schedules(offer_id,territory_code,currency,starts_at,ends_at);

ALTER TABLE promotions ADD COLUMN funding_source text NOT NULL DEFAULT 'publisher' CHECK(funding_source IN ('publisher','fore','shared'));
ALTER TABLE promotions ADD COLUMN publisher_funding_bps integer NOT NULL DEFAULT 10000;
ALTER TABLE promotions ADD COLUMN territory_code text;
ALTER TABLE promotions ADD COLUMN coupon_required integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS pricing_decisions (
  id text PRIMARY KEY,
  product_id text NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  offer_id text NOT NULL REFERENCES offers(id) ON DELETE RESTRICT,
  territory_code text NOT NULL,
  currency text NOT NULL,
  base_amount_minor integer NOT NULL,
  scheduled_amount_minor integer NOT NULL,
  promotion_amount_minor integer NOT NULL DEFAULT 0,
  promotion_id text,
  effective_amount_minor integer NOT NULL,
  floor_minor integer,
  fx_rate_ppm integer,
  fx_source text,
  preorder_guarantee_applied integer NOT NULL DEFAULT 0,
  rule_trace_json text NOT NULL DEFAULT '[]',
  valid_until text,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pricing_decisions_product ON pricing_decisions(product_id,created_at DESC);

CREATE TABLE IF NOT EXISTS preorder_price_guarantees (
  user_id text NOT NULL,
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  currency text NOT NULL,
  lowest_price_minor integer NOT NULL,
  first_seen_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY(user_id,product_id,currency)
);

CREATE TABLE IF NOT EXISTS finance_parties (
  id text PRIMARY KEY,
  party_type text NOT NULL CHECK(party_type IN ('publisher','author','agent','narrator','distributor','other')),
  display_name text NOT NULL,
  publisher_id text REFERENCES publishers(id) ON DELETE SET NULL,
  contributor_id text REFERENCES contributors(id) ON DELETE SET NULL,
  tax_country text,
  withholding_bps integer NOT NULL DEFAULT 0,
  payout_currency text NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','hold','closed')),
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS finance_royalty_contracts (
  id text PRIMARY KEY,
  name text NOT NULL,
  publisher_id text REFERENCES publishers(id) ON DELETE SET NULL,
  product_id text REFERENCES products(id) ON DELETE CASCADE,
  edition_id text REFERENCES editions(id) ON DELETE CASCADE,
  territory_code text,
  format text,
  sales_channel text NOT NULL DEFAULT 'retail',
  effective_from text NOT NULL,
  effective_to text,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','retired')),
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_royalty_contract_match ON finance_royalty_contracts(product_id,edition_id,territory_code,effective_from,effective_to,status);

CREATE TABLE IF NOT EXISTS finance_royalty_contract_versions (
  id text PRIMARY KEY,
  contract_id text NOT NULL REFERENCES finance_royalty_contracts(id) ON DELETE CASCADE,
  version integer NOT NULL,
  calculation_basis text NOT NULL DEFAULT 'net_revenue' CHECK(calculation_basis IN ('list_price','customer_price','net_revenue')),
  fore_commission_bps integer NOT NULL DEFAULT 3000,
  payment_terms_days integer NOT NULL DEFAULT 60,
  reserve_bps integer NOT NULL DEFAULT 0,
  effective_from text NOT NULL,
  created_at text NOT NULL,
  UNIQUE(contract_id,version)
);

CREATE TABLE IF NOT EXISTS finance_royalty_splits (
  id text PRIMARY KEY,
  contract_version_id text NOT NULL REFERENCES finance_royalty_contract_versions(id) ON DELETE CASCADE,
  party_id text NOT NULL REFERENCES finance_parties(id) ON DELETE RESTRICT,
  share_bps integer NOT NULL CHECK(share_bps>=0 AND share_bps<=10000),
  priority integer NOT NULL DEFAULT 0,
  recoupment_account text,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_finance_royalty_splits_version ON finance_royalty_splits(contract_version_id,priority);

CREATE TABLE IF NOT EXISTS finance_royalty_events (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES commerce_orders(id) ON DELETE RESTRICT,
  order_item_id text NOT NULL REFERENCES commerce_order_items(id) ON DELETE RESTRICT,
  refund_id text REFERENCES commerce_refunds(id) ON DELETE RESTRICT,
  contract_version_id text NOT NULL REFERENCES finance_royalty_contract_versions(id) ON DELETE RESTRICT,
  party_id text NOT NULL REFERENCES finance_parties(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK(event_type IN ('sale','refund','chargeback','adjustment')),
  basis_minor integer NOT NULL,
  royalty_minor integer NOT NULL,
  withholding_minor integer NOT NULL DEFAULT 0,
  reserve_minor integer NOT NULL DEFAULT 0,
  payable_minor integer NOT NULL,
  currency text NOT NULL,
  status text NOT NULL DEFAULT 'accrued' CHECK(status IN ('accrued','payable','paid','reversed','held')),
  available_at text NOT NULL,
  external_reference text NOT NULL DEFAULT '',
  created_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_royalty_event_idempotent ON finance_royalty_events(order_item_id,party_id,event_type,COALESCE(refund_id,''),external_reference);
CREATE INDEX IF NOT EXISTS idx_finance_royalty_events_party ON finance_royalty_events(party_id,status,available_at,currency);

CREATE TABLE IF NOT EXISTS payout_batches (
  id text PRIMARY KEY,
  currency text NOT NULL,
  period_start text NOT NULL,
  period_end text NOT NULL,
  status text NOT NULL CHECK(status IN ('draft','approved','processing','paid','failed','canceled')),
  gross_minor integer NOT NULL DEFAULT 0,
  withholding_minor integer NOT NULL DEFAULT 0,
  net_minor integer NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  approved_at text,
  paid_at text
);

CREATE TABLE IF NOT EXISTS payout_items (
  id text PRIMARY KEY,
  batch_id text NOT NULL REFERENCES payout_batches(id) ON DELETE CASCADE,
  party_id text NOT NULL REFERENCES finance_parties(id) ON DELETE RESTRICT,
  currency text NOT NULL,
  gross_minor integer NOT NULL,
  withholding_minor integer NOT NULL,
  net_minor integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','failed','held')),
  external_payout_id text,
  created_at text NOT NULL,
  UNIQUE(batch_id,party_id,currency)
);

CREATE TABLE IF NOT EXISTS payout_event_links (
  payout_item_id text NOT NULL REFERENCES payout_items(id) ON DELETE CASCADE,
  royalty_event_id text NOT NULL REFERENCES finance_royalty_events(id) ON DELETE RESTRICT,
  PRIMARY KEY(payout_item_id,royalty_event_id)
);

CREATE TABLE IF NOT EXISTS finance_statements (
  id text PRIMARY KEY,
  party_id text NOT NULL REFERENCES finance_parties(id) ON DELETE CASCADE,
  period_start text NOT NULL,
  period_end text NOT NULL,
  currency text NOT NULL,
  sales_minor integer NOT NULL DEFAULT 0,
  refunds_minor integer NOT NULL DEFAULT 0,
  royalties_minor integer NOT NULL DEFAULT 0,
  withholding_minor integer NOT NULL DEFAULT 0,
  reserve_minor integer NOT NULL DEFAULT 0,
  payable_minor integer NOT NULL DEFAULT 0,
  generated_at text NOT NULL,
  UNIQUE(party_id,period_start,period_end,currency)
);

INSERT OR IGNORE INTO pricing_policies(id,name,status,base_currency,rounding_rule,fx_markup_bps,created_at,updated_at)
VALUES('pricing_default','Default retail pricing','active','USD','psychological_99',0,datetime('now'),datetime('now'));
INSERT OR IGNORE INTO pricing_region_rules(id,policy_id,territory_code,currency,floor_minor,ceiling_minor,tax_inclusive,fx_source,created_at,updated_at)
VALUES('pricing_default_us','pricing_default','US','USD',0,NULL,0,'manual',datetime('now'),datetime('now'));

INSERT OR IGNORE INTO product_pricing_assignments(product_id,policy_id,base_offer_id,preorder_guarantee,publisher_floor_minor,updated_at)
SELECT p.id,'pricing_default',(SELECT o.id FROM offers o WHERE o.product_id=p.id ORDER BY o.created_at DESC LIMIT 1),1,NULL,datetime('now') FROM products p;
