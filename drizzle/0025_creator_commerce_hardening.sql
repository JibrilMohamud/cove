-- Creator commerce hardening: immutable contractual economics, versioned promotion policy,
-- preorder release-change audit, and promotion funding attribution.

ALTER TABLE promotion_attribution_events ADD COLUMN funding_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE preorder_release_plans ADD COLUMN policy_version_id TEXT NOT NULL DEFAULT 'preorder_policy_v1';
ALTER TABLE promotion_campaigns ADD COLUMN policy_version TEXT NOT NULL DEFAULT 'fore-promotions-v1';

CREATE TABLE IF NOT EXISTS promotion_policy_versions (
  id TEXT PRIMARY KEY NOT NULL,
  policy_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','retired')),
  max_duration_days INTEGER NOT NULL DEFAULT 90,
  max_products INTEGER NOT NULL DEFAULT 500,
  rules_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(policy_key,version)
);
INSERT OR IGNORE INTO promotion_policy_versions(id,policy_key,version,status,max_duration_days,max_products,rules_json,created_at)
VALUES('fore-promotions-v1','fore-promotions',1,'active',90,500,'{"approvalRequired":true,"rightsCheckRequired":true,"budgetEnforcement":"funding_spend","countdownSurface":true,"wishlistPriceDropEvents":true}',datetime('now'));

CREATE TABLE IF NOT EXISTS preorder_release_changes (
  id TEXT PRIMARY KEY NOT NULL,
  release_plan_id TEXT NOT NULL REFERENCES preorder_release_plans(id) ON DELETE RESTRICT,
  previous_release_at TEXT NOT NULL,
  new_release_at TEXT NOT NULL,
  previous_manuscript_deadline_at TEXT NOT NULL,
  new_manuscript_deadline_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('publisher','staff','automation')),
  actor_id TEXT,
  affected_preorders INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_preorder_release_changes_plan ON preorder_release_changes(release_plan_id,created_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_preorder_release_changes_append_only_update
BEFORE UPDATE ON preorder_release_changes BEGIN SELECT RAISE(ABORT,'preorder release changes are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_preorder_release_changes_append_only_delete
BEFORE DELETE ON preorder_release_changes BEGIN SELECT RAISE(ABORT,'preorder release changes cannot be deleted'); END;

-- Contract economics are immutable once a version exists. Status on allocations remains mutable
-- because holds/payability/settlement are workflow states, not changes to the calculation.
CREATE TRIGGER IF NOT EXISTS trg_finance_royalty_splits_immutable_update
BEFORE UPDATE ON finance_royalty_splits BEGIN SELECT RAISE(ABORT,'royalty splits are immutable; create a new contract version'); END;
CREATE TRIGGER IF NOT EXISTS trg_finance_royalty_splits_immutable_delete
BEFORE DELETE ON finance_royalty_splits BEGIN SELECT RAISE(ABORT,'royalty splits cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS trg_finance_royalty_allocations_economics_immutable
BEFORE UPDATE OF calculation_id,party_id,share_bps,royalty_minor,withholding_minor,reserve_minor,payable_minor,currency,available_at,legacy_royalty_event_id,created_at ON finance_royalty_allocations
BEGIN SELECT RAISE(ABORT,'royalty allocation economics are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_finance_royalty_allocations_no_delete
BEFORE DELETE ON finance_royalty_allocations BEGIN SELECT RAISE(ABORT,'royalty allocations cannot be deleted'); END;

-- Once processed into a royalty calculation, the measured usage and its assigned economic value
-- cannot be rewritten. Corrections must be new usage/adjustment records.
CREATE TRIGGER IF NOT EXISTS trg_finance_usage_processed_immutable
BEFORE UPDATE OF source_type,source_reference,product_id,user_id,territory_code,currency,units,pages_read,seconds_consumed,gross_value_minor,pool_id,occurred_at,metadata_json ON finance_usage_events
WHEN OLD.processed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'processed usage economics are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_finance_usage_processed_no_delete
BEFORE DELETE ON finance_usage_events WHEN OLD.processed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'processed usage cannot be deleted'); END;

-- Pool terms freeze once allocation begins. State/timestamps may progress through the workflow.
CREATE TRIGGER IF NOT EXISTS trg_finance_usage_pool_locked_terms
BEFORE UPDATE OF pool_type,period_start,period_end,territory_code,currency,pool_minor,metric,rules_json ON finance_usage_pools
WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT,'locked usage-pool terms are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_finance_usage_pool_no_delete
BEFORE DELETE ON finance_usage_pools WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT,'locked usage pools cannot be deleted'); END;

-- A campaign can be freely edited only while it is a draft/rejected proposal. Approved economics
-- are historical merchandising evidence; changes require a replacement campaign.
CREATE TRIGGER IF NOT EXISTS trg_promotion_campaign_locked_terms
BEFORE UPDATE OF publishing_account_id,name,campaign_type,funding_source,publisher_funding_bps,currency,territory_code,starts_at,ends_at,budget_minor,max_redemptions,stackable,eligibility_json,merchandising_submission,policy_version ON promotion_campaigns
WHEN OLD.status NOT IN ('draft','rejected')
BEGIN SELECT RAISE(ABORT,'approved/submitted promotion terms are immutable; create a replacement campaign'); END;
CREATE TRIGGER IF NOT EXISTS trg_promotion_campaign_products_locked_update
BEFORE UPDATE ON promotion_campaign_products
WHEN (SELECT status FROM promotion_campaigns WHERE id=OLD.campaign_id) NOT IN ('draft','rejected')
BEGIN SELECT RAISE(ABORT,'approved/submitted promotion products are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_promotion_campaign_products_locked_delete
BEFORE DELETE ON promotion_campaign_products
WHEN (SELECT status FROM promotion_campaigns WHERE id=OLD.campaign_id) NOT IN ('draft','rejected')
BEGIN SELECT RAISE(ABORT,'approved/submitted promotion products cannot be deleted'); END;
