-- Commercial checkout/payments/accounting layer. Stripe is the processor; Cove remains system of record.
ALTER TABLE offers ADD COLUMN tax_behavior text NOT NULL DEFAULT 'exclusive' CHECK(tax_behavior IN ('exclusive','inclusive'));
ALTER TABLE offers ADD COLUMN tax_code text NOT NULL DEFAULT 'txcd_10302000';

CREATE TABLE IF NOT EXISTS commerce_customers (
  user_id text PRIMARY KEY,
  stripe_customer_id text UNIQUE,
  email text NOT NULL DEFAULT '',
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS commerce_checkout_quotes (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  cart_id text NOT NULL REFERENCES shopping_carts(id) ON DELETE CASCADE,
  cart_fingerprint text NOT NULL,
  territory_code text NOT NULL,
  currency text NOT NULL,
  items_json text NOT NULL,
  billing_address_json text NOT NULL,
  subtotal_minor integer NOT NULL,
  promo_discount_minor integer NOT NULL DEFAULT 0,
  tax_minor integer NOT NULL DEFAULT 0,
  tax_inclusive_minor integer NOT NULL DEFAULT 0,
  gift_card_minor integer NOT NULL DEFAULT 0,
  store_credit_minor integer NOT NULL DEFAULT 0,
  total_minor integer NOT NULL,
  stripe_due_minor integer NOT NULL,
  promo_code_hash text,
  gift_card_hash text,
  stripe_tax_calculation_id text,
  tax_breakdown_json text NOT NULL DEFAULT '[]',
  expires_at text NOT NULL,
  consumed_at text,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkout_quotes_user ON commerce_checkout_quotes(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkout_quotes_expiry ON commerce_checkout_quotes(expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS commerce_orders (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  quote_id text REFERENCES commerce_checkout_quotes(id) ON DELETE SET NULL,
  invoice_number text NOT NULL UNIQUE,
  status text NOT NULL CHECK(status IN ('pending_payment','authorized','processing','paid','payment_failed','canceled','partially_refunded','refunded','disputed','chargeback_lost')),
  currency text NOT NULL,
  territory_code text NOT NULL,
  subtotal_minor integer NOT NULL,
  promo_discount_minor integer NOT NULL DEFAULT 0,
  tax_minor integer NOT NULL DEFAULT 0,
  tax_inclusive_minor integer NOT NULL DEFAULT 0,
  gift_card_minor integer NOT NULL DEFAULT 0,
  store_credit_minor integer NOT NULL DEFAULT 0,
  total_minor integer NOT NULL,
  stripe_due_minor integer NOT NULL,
  refunded_minor integer NOT NULL DEFAULT 0,
  billing_address_json text NOT NULL,
  stripe_customer_id text,
  stripe_payment_intent_id text UNIQUE,
  stripe_charge_id text,
  stripe_tax_calculation_id text,
  stripe_tax_transaction_id text,
  receipt_url text,
  payment_method_summary text NOT NULL DEFAULT '',
  risk_level text,
  risk_score integer,
  capture_method text NOT NULL DEFAULT 'automatic_async',
  idempotency_key text NOT NULL UNIQUE,
  failure_code text,
  failure_message text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  authorized_at text,
  paid_at text,
  canceled_at text
);
CREATE INDEX IF NOT EXISTS idx_commerce_orders_user ON commerce_orders(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_orders_quote_unique ON commerce_orders(quote_id) WHERE quote_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_commerce_orders_status ON commerce_orders(status, updated_at);

CREATE TABLE IF NOT EXISTS commerce_order_items (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES commerce_orders(id) ON DELETE RESTRICT,
  product_id text NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  offer_id text,
  title_snapshot text NOT NULL,
  sku_snapshot text NOT NULL,
  unit_amount_minor integer NOT NULL,
  discount_minor integer NOT NULL DEFAULT 0,
  tax_minor integer NOT NULL DEFAULT 0,
  total_minor integer NOT NULL,
  source_surface text NOT NULL DEFAULT '',
  source_request_id text,
  entitlement_status text NOT NULL DEFAULT 'pending',
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON commerce_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product ON commerce_order_items(product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS commerce_payment_attempts (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES commerce_orders(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'stripe',
  provider_payment_id text,
  status text NOT NULL,
  amount_minor integer NOT NULL,
  currency text NOT NULL,
  failure_code text,
  failure_message text,
  provider_payload_json text NOT NULL DEFAULT '{}',
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_order ON commerce_payment_attempts(order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS commerce_promo_codes (
  code_hash text PRIMARY KEY,
  code_label text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('percent','amount')),
  value integer NOT NULL,
  currency text,
  minimum_subtotal_minor integer NOT NULL DEFAULT 0,
  max_redemptions integer,
  max_per_user integer NOT NULL DEFAULT 1,
  redemptions integer NOT NULL DEFAULT 0,
  active integer NOT NULL DEFAULT 1,
  starts_at text,
  ends_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS commerce_promo_redemptions (
  id text PRIMARY KEY,
  code_hash text NOT NULL REFERENCES commerce_promo_codes(code_hash) ON DELETE RESTRICT,
  user_id text NOT NULL,
  order_id text REFERENCES commerce_orders(id) ON DELETE SET NULL,
  quote_id text,
  amount_minor integer NOT NULL,
  status text NOT NULL CHECK(status IN ('reserved','applied','released','refunded')),
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_code ON commerce_promo_redemptions(code_hash,status);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_user ON commerce_promo_redemptions(user_id,code_hash,status);

CREATE TABLE IF NOT EXISTS commerce_gift_cards (
  code_hash text PRIMARY KEY,
  last4 text NOT NULL,
  currency text NOT NULL,
  original_balance_minor integer NOT NULL,
  balance_minor integer NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled','exhausted','expired')),
  expires_at text,
  issued_by text NOT NULL DEFAULT 'operator',
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS commerce_gift_card_ledger (
  id text PRIMARY KEY,
  code_hash text NOT NULL REFERENCES commerce_gift_cards(code_hash) ON DELETE RESTRICT,
  order_id text REFERENCES commerce_orders(id) ON DELETE SET NULL,
  entry_type text NOT NULL,
  amount_minor integer NOT NULL,
  balance_after_minor integer NOT NULL,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gift_card_ledger_card ON commerce_gift_card_ledger(code_hash,created_at);

CREATE TABLE IF NOT EXISTS commerce_store_credit_ledger (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  order_id text REFERENCES commerce_orders(id) ON DELETE SET NULL,
  entry_type text NOT NULL,
  amount_minor integer NOT NULL,
  currency text NOT NULL,
  reference text NOT NULL DEFAULT '',
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_store_credit_user ON commerce_store_credit_ledger(user_id,currency,created_at);

CREATE TABLE IF NOT EXISTS commerce_balance_reservations (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  order_id text NOT NULL REFERENCES commerce_orders(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK(source_type IN ('gift_card','store_credit')),
  source_key text NOT NULL,
  amount_minor integer NOT NULL,
  currency text NOT NULL,
  status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','consumed','released')),
  expires_at text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_balance_reservations_source ON commerce_balance_reservations(source_type,source_key,status,expires_at);

CREATE TABLE IF NOT EXISTS commerce_refunds (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES commerce_orders(id) ON DELETE RESTRICT,
  provider_refund_id text UNIQUE,
  amount_minor integer NOT NULL,
  stripe_amount_minor integer NOT NULL DEFAULT 0,
  gift_card_amount_minor integer NOT NULL DEFAULT 0,
  store_credit_amount_minor integer NOT NULL DEFAULT 0,
  currency text NOT NULL,
  reason text NOT NULL DEFAULT '',
  status text NOT NULL,
  tax_reversal_id text,
  idempotency_key text NOT NULL UNIQUE,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  succeeded_at text
);
CREATE INDEX IF NOT EXISTS idx_refunds_order ON commerce_refunds(order_id,created_at DESC);

CREATE TABLE IF NOT EXISTS commerce_disputes (
  provider_dispute_id text PRIMARY KEY,
  order_id text REFERENCES commerce_orders(id) ON DELETE SET NULL,
  charge_id text NOT NULL,
  amount_minor integer NOT NULL,
  currency text NOT NULL,
  reason text NOT NULL DEFAULT '',
  status text NOT NULL,
  evidence_due_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  closed_at text
);
CREATE INDEX IF NOT EXISTS idx_disputes_order ON commerce_disputes(order_id,updated_at DESC);

CREATE TABLE IF NOT EXISTS commerce_webhook_events (
  provider_event_id text PRIMARY KEY,
  event_type text NOT NULL,
  livemode integer NOT NULL DEFAULT 0,
  payload_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'received',
  error text NOT NULL DEFAULT '',
  received_at text NOT NULL,
  processed_at text
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON commerce_webhook_events(status,received_at);

CREATE TABLE IF NOT EXISTS commerce_ledger_entries (
  id text PRIMARY KEY,
  order_id text REFERENCES commerce_orders(id) ON DELETE RESTRICT,
  refund_id text REFERENCES commerce_refunds(id) ON DELETE RESTRICT,
  user_id text,
  entry_type text NOT NULL,
  account_code text NOT NULL,
  amount_minor integer NOT NULL,
  currency text NOT NULL,
  external_reference text NOT NULL DEFAULT '',
  metadata_json text NOT NULL DEFAULT '{}',
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commerce_ledger_order ON commerce_ledger_entries(order_id,created_at);
CREATE INDEX IF NOT EXISTS idx_commerce_ledger_account ON commerce_ledger_entries(account_code,currency,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_ledger_idempotent ON commerce_ledger_entries(order_id,entry_type,account_code,external_reference);
CREATE TRIGGER IF NOT EXISTS commerce_ledger_no_update BEFORE UPDATE ON commerce_ledger_entries BEGIN SELECT RAISE(ABORT,'commerce ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS commerce_ledger_no_delete BEFORE DELETE ON commerce_ledger_entries BEGIN SELECT RAISE(ABORT,'commerce ledger is append-only'); END;

CREATE TABLE IF NOT EXISTS commerce_reconciliation_runs (
  id text PRIMARY KEY,
  started_at text NOT NULL,
  finished_at text,
  status text NOT NULL,
  checked_orders integer NOT NULL DEFAULT 0,
  mismatches integer NOT NULL DEFAULT 0,
  repaired integer NOT NULL DEFAULT 0,
  details_json text NOT NULL DEFAULT '[]'
);
