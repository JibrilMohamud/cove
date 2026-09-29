-- Global storefront context, human-vs-machine privileged identity separation, and production operations control plane.
-- This migration intentionally composes existing territory rights, pricing, tax, merchandising and recommendation systems
-- instead of duplicating their policy logic.

-- -----------------------------
-- Global storefront / localization
-- -----------------------------
CREATE TABLE storefront_markets (
  country_code TEXT PRIMARY KEY NOT NULL REFERENCES territories(code) ON DELETE RESTRICT,
  display_name TEXT NOT NULL,
  default_locale TEXT NOT NULL,
  default_currency TEXT NOT NULL CHECK(length(default_currency)=3),
  tax_inclusive_default INTEGER NOT NULL DEFAULT 0 CHECK(tax_inclusive_default IN (0,1)),
  market_status TEXT NOT NULL DEFAULT 'active' CHECK(market_status IN ('draft','active','paused','retired')),
  recommendation_region TEXT NOT NULL DEFAULT 'global',
  merchandising_region TEXT NOT NULL DEFAULT 'global',
  payment_provider TEXT NOT NULL DEFAULT 'stripe',
  checkout_enabled INTEGER NOT NULL DEFAULT 1 CHECK(checkout_enabled IN (0,1)),
  launched_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_storefront_markets_status ON storefront_markets(market_status,country_code);

CREATE TABLE storefront_locales (
  locale TEXT PRIMARY KEY NOT NULL,
  language_code TEXT NOT NULL,
  script_code TEXT NOT NULL DEFAULT 'Latn',
  region_code TEXT,
  display_name TEXT NOT NULL,
  native_name TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'ltr' CHECK(direction IN ('ltr','rtl')),
  fallback_locale TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','retired')),
  required_translation_coverage_bps INTEGER NOT NULL DEFAULT 9500 CHECK(required_translation_coverage_bps BETWEEN 0 AND 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_storefront_locales_language ON storefront_locales(language_code,status);

CREATE TABLE storefront_market_locales (
  country_code TEXT NOT NULL REFERENCES storefront_markets(country_code) ON DELETE CASCADE,
  locale TEXT NOT NULL REFERENCES storefront_locales(locale) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  PRIMARY KEY(country_code,locale)
);
CREATE INDEX idx_storefront_market_locales_priority ON storefront_market_locales(country_code,active,priority,locale);

CREATE TABLE storefront_currency_options (
  country_code TEXT NOT NULL REFERENCES storefront_markets(country_code) ON DELETE CASCADE,
  currency TEXT NOT NULL CHECK(length(currency)=3),
  priority INTEGER NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  PRIMARY KEY(country_code,currency)
);

CREATE TABLE storefront_payment_methods (
  country_code TEXT NOT NULL REFERENCES storefront_markets(country_code) ON DELETE CASCADE,
  payment_method TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'stripe',
  currency TEXT,
  availability TEXT NOT NULL DEFAULT 'planned' CHECK(availability IN ('available','planned','disabled')),
  priority INTEGER NOT NULL DEFAULT 100,
  config_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(country_code,payment_method,currency)
);
CREATE INDEX idx_storefront_payment_methods_live ON storefront_payment_methods(country_code,availability,priority);

CREATE TABLE storefront_user_preferences (
  user_id TEXT PRIMARY KEY NOT NULL,
  country_code TEXT REFERENCES storefront_markets(country_code) ON DELETE SET NULL,
  locale TEXT REFERENCES storefront_locales(locale) ON DELETE SET NULL,
  currency TEXT,
  country_source TEXT NOT NULL DEFAULT 'user' CHECK(country_source IN ('user','network','billing','account','default')),
  updated_at TEXT NOT NULL
);

CREATE TABLE ui_translation_bundles (
  id TEXT PRIMARY KEY NOT NULL,
  locale TEXT NOT NULL REFERENCES storefront_locales(locale) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version>0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','review','active','retired')),
  source TEXT NOT NULL DEFAULT 'fore',
  message_count INTEGER NOT NULL DEFAULT 0,
  translated_count INTEGER NOT NULL DEFAULT 0,
  coverage_bps INTEGER NOT NULL DEFAULT 0 CHECK(coverage_bps BETWEEN 0 AND 10000),
  checksum_sha256 TEXT NOT NULL DEFAULT '',
  created_by_user_id TEXT,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  UNIQUE(locale,version)
);
CREATE UNIQUE INDEX idx_ui_translation_active_locale ON ui_translation_bundles(locale) WHERE status='active';

CREATE TABLE ui_translation_messages (
  bundle_id TEXT NOT NULL REFERENCES ui_translation_bundles(id) ON DELETE CASCADE,
  message_key TEXT NOT NULL,
  message_value TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(bundle_id,message_key)
);
CREATE INDEX idx_ui_translation_messages_key ON ui_translation_messages(message_key,bundle_id);

CREATE TABLE storefront_taxonomy_node_localizations (
  taxonomy_node_id TEXT NOT NULL REFERENCES storefront_taxonomy_nodes(id) ON DELETE CASCADE,
  locale TEXT NOT NULL REFERENCES storefront_locales(locale) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  seo_title TEXT NOT NULL DEFAULT '',
  seo_description TEXT NOT NULL DEFAULT '',
  updated_by_user_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(taxonomy_node_id,locale)
);

CREATE TABLE recommendation_regional_item_metrics (
  territory_code TEXT NOT NULL REFERENCES territories(code) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  views_7d INTEGER NOT NULL DEFAULT 0,
  clicks_7d INTEGER NOT NULL DEFAULT 0,
  library_adds_30d INTEGER NOT NULL DEFAULT 0,
  purchases_30d INTEGER NOT NULL DEFAULT 0,
  completions_90d INTEGER NOT NULL DEFAULT 0,
  trend_score REAL NOT NULL DEFAULT 0,
  popularity_score REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(territory_code,product_id)
);
CREATE INDEX idx_recommendation_regional_rank ON recommendation_regional_item_metrics(territory_code,trend_score DESC,popularity_score DESC);

CREATE TABLE storefront_context_events (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT,
  session_fingerprint TEXT,
  network_country TEXT,
  storefront_country TEXT NOT NULL,
  rights_country TEXT NOT NULL,
  tax_country TEXT,
  locale TEXT NOT NULL,
  currency TEXT NOT NULL,
  source_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_storefront_context_events_time ON storefront_context_events(created_at DESC);
CREATE INDEX idx_storefront_context_events_user ON storefront_context_events(user_id,created_at DESC);

-- -----------------------------
-- Human staff roles + machine service principals
-- -----------------------------
INSERT OR IGNORE INTO staff_roles(id,name,description) VALUES
 ('role_catalog_reviewer','catalog_reviewer','Review catalog metadata, taxonomy and publication readiness.'),
 ('role_community_moderator','community_moderator','Moderate reviews, hearts, reports and reader community abuse.'),
 ('role_publisher_support','publisher_support','Support publisher onboarding, feeds and publishing accounts.'),
 ('role_finance_operator','finance_operator','Operate commerce, pricing, reconciliation, payouts and tax workflows.'),
 ('role_fraud_investigator','fraud_investigator','Investigate buyer, publisher and community financial abuse.'),
 ('role_storefront_editor','storefront_editor','Manage localized storefront taxonomy, merchandising and campaigns.'),
 ('role_operations_engineer','operations_engineer','Operate production reliability, deployments, queues and recovery drills.'),
 ('role_super_admin','super_admin','Break-glass human administration across Cove staff domains.');

INSERT OR IGNORE INTO staff_role_permissions(role_id,permission) VALUES
 ('role_catalog_reviewer','catalog.read'),('role_catalog_reviewer','catalog.review'),('role_catalog_reviewer','publishing.review'),('role_catalog_reviewer','publishing.duplicate_review'),('role_catalog_reviewer','taxonomy.read'),
 ('role_community_moderator','moderation.case.read'),('role_community_moderator','moderation.case.manage'),('role_community_moderator','moderation.note.write'),('role_community_moderator','moderation.review.manage'),('role_community_moderator','reviews.integrity.read'),('role_community_moderator','reviews.integrity.manage'),
 ('role_publisher_support','support.read'),('role_publisher_support','support.case.manage'),('role_publisher_support','publishing.partner.read'),('role_publisher_support','publishing.review'),
 ('role_finance_operator','commerce.read'),('role_finance_operator','commerce.manage'),('role_finance_operator','finance.read'),('role_finance_operator','finance.manage'),('role_finance_operator','finance.contract.manage'),('role_finance_operator','finance.statement.generate'),('role_finance_operator','finance.metrics.refresh'),('role_finance_operator','tax.compliance.read'),('role_finance_operator','tax.compliance.manage'),
 ('role_fraud_investigator','risk.case.read'),('role_fraud_investigator','risk.case.manage'),('role_fraud_investigator','risk.hold.manage'),('role_fraud_investigator','risk.link.manage'),('role_fraud_investigator','moderation.fraud.manage'),('role_fraud_investigator','moderation.case.read'),('role_fraud_investigator','moderation.note.write'),
 ('role_storefront_editor','storefront.read'),('role_storefront_editor','storefront.manage'),('role_storefront_editor','taxonomy.read'),('role_storefront_editor','taxonomy.manage'),('role_storefront_editor','merchandising.read'),('role_storefront_editor','merchandising.manage'),('role_storefront_editor','recommendations.read'),('role_storefront_editor','recommendations.manage'),('role_storefront_editor','localization.read'),('role_storefront_editor','localization.manage'),
 ('role_operations_engineer','operations.read'),('role_operations_engineer','operations.manage'),('role_operations_engineer','operations.deploy'),('role_operations_engineer','service_principal.read'),('role_operations_engineer','service_principal.manage'),('role_operations_engineer','search.reindex'),
 ('role_super_admin','staff.manage'),('role_super_admin','service_principal.read'),('role_super_admin','service_principal.manage'),('role_super_admin','operations.deploy'),('role_super_admin','storefront.read'),('role_super_admin','storefront.manage'),('role_super_admin','taxonomy.read'),('role_super_admin','taxonomy.manage'),('role_super_admin','merchandising.read'),('role_super_admin','merchandising.manage'),('role_super_admin','recommendations.read'),('role_super_admin','recommendations.manage'),('role_super_admin','localization.read'),('role_super_admin','localization.manage'),('role_super_admin','catalog.read'),('role_super_admin','catalog.review'),('role_super_admin','commerce.read'),('role_super_admin','commerce.manage'),('role_super_admin','finance.read'),('role_super_admin','finance.manage'),('role_super_admin','operations.read'),('role_super_admin','operations.manage'),('role_super_admin','search.reindex');

CREATE TABLE service_principals (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  owner_team TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'production' CHECK(environment IN ('development','staging','production')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','retired')),
  created_by_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE service_principal_scopes (
  principal_id TEXT NOT NULL REFERENCES service_principals(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  granted_by_user_id TEXT,
  granted_at TEXT NOT NULL,
  PRIMARY KEY(principal_id,scope)
);
CREATE INDEX idx_service_principal_scopes_scope ON service_principal_scopes(scope,principal_id);

CREATE TABLE service_principal_credentials (
  id TEXT PRIMARY KEY NOT NULL,
  principal_id TEXT NOT NULL REFERENCES service_principals(id) ON DELETE CASCADE,
  token_prefix TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked','expired')),
  not_before TEXT,
  expires_at TEXT,
  last_used_at TEXT,
  last_used_country TEXT,
  created_by_user_id TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by_user_id TEXT
);
CREATE INDEX idx_service_credentials_principal ON service_principal_credentials(principal_id,status,expires_at);
CREATE INDEX idx_service_credentials_prefix ON service_principal_credentials(token_prefix,status);

CREATE TABLE privileged_access_audit (
  id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('staff','service','bootstrap','system')),
  actor_id TEXT NOT NULL,
  permission_or_scope TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('authorized','denied','completed','failed')),
  response_status INTEGER,
  ip_country TEXT,
  user_agent_sha256 TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_privileged_access_actor ON privileged_access_audit(actor_type,actor_id,created_at DESC);
CREATE INDEX idx_privileged_access_path ON privileged_access_audit(path,created_at DESC);
CREATE INDEX idx_privileged_access_request ON privileged_access_audit(request_id,created_at);

-- -----------------------------
-- Production observability / reliability control plane
-- -----------------------------
CREATE TABLE ops_http_requests (
  id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  actor_kind TEXT NOT NULL DEFAULT 'anonymous',
  storefront_country TEXT,
  error_class TEXT,
  sampled INTEGER NOT NULL DEFAULT 1 CHECK(sampled IN (0,1)),
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_ops_http_time ON ops_http_requests(occurred_at DESC);
CREATE INDEX idx_ops_http_route ON ops_http_requests(route,occurred_at DESC);
CREATE INDEX idx_ops_http_trace ON ops_http_requests(trace_id,occurred_at);

CREATE TABLE ops_trace_spans (
  id TEXT PRIMARY KEY NOT NULL,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  span_name TEXT NOT NULL,
  span_kind TEXT NOT NULL DEFAULT 'internal' CHECK(span_kind IN ('server','client','producer','consumer','internal')),
  status TEXT NOT NULL DEFAULT 'ok' CHECK(status IN ('ok','error')),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(trace_id,span_id)
);
CREATE INDEX idx_ops_trace_spans_trace ON ops_trace_spans(trace_id,started_at);

CREATE TABLE ops_error_events (
  id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT,
  trace_id TEXT,
  fingerprint TEXT NOT NULL,
  error_class TEXT NOT NULL,
  message TEXT NOT NULL,
  stack_excerpt TEXT NOT NULL DEFAULT '',
  route TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'error' CHECK(severity IN ('warning','error','critical')),
  context_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_ops_errors_time ON ops_error_events(occurred_at DESC);
CREATE INDEX idx_ops_errors_fingerprint ON ops_error_events(fingerprint,occurred_at DESC);

CREATE TABLE ops_metric_points (
  id TEXT PRIMARY KEY NOT NULL,
  metric_name TEXT NOT NULL,
  metric_type TEXT NOT NULL CHECK(metric_type IN ('counter','gauge','histogram')),
  value REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT '1',
  labels_json TEXT NOT NULL DEFAULT '{}',
  observed_at TEXT NOT NULL
);
CREATE INDEX idx_ops_metrics_name_time ON ops_metric_points(metric_name,observed_at DESC);

CREATE TABLE ops_slo_definitions (
  id TEXT PRIMARY KEY NOT NULL,
  service_name TEXT NOT NULL,
  slo_key TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  indicator_type TEXT NOT NULL CHECK(indicator_type IN ('availability','latency','freshness','queue_age','webhook_success','synthetic_success')),
  target_bps INTEGER NOT NULL CHECK(target_bps BETWEEN 0 AND 10000),
  window_days INTEGER NOT NULL CHECK(window_days BETWEEN 1 AND 90),
  threshold_ms INTEGER,
  threshold_seconds INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','retired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE ops_slo_measurements (
  id TEXT PRIMARY KEY NOT NULL,
  slo_id TEXT NOT NULL REFERENCES ops_slo_definitions(id) ON DELETE CASCADE,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  good_events INTEGER NOT NULL,
  total_events INTEGER NOT NULL,
  achieved_bps INTEGER NOT NULL,
  error_budget_remaining_bps INTEGER NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  measured_at TEXT NOT NULL
);
CREATE INDEX idx_ops_slo_measurements ON ops_slo_measurements(slo_id,measured_at DESC);

CREATE TABLE ops_alert_rules (
  id TEXT PRIMARY KEY NOT NULL,
  rule_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('warning','critical')),
  signal_type TEXT NOT NULL CHECK(signal_type IN ('metric','slo','freshness','queue','webhook','synthetic','storage','backup','worker')),
  config_json TEXT NOT NULL,
  notification_target TEXT NOT NULL DEFAULT 'oncall',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE ops_incidents (
  id TEXT PRIMARY KEY NOT NULL,
  alert_rule_id TEXT REFERENCES ops_alert_rules(id) ON DELETE SET NULL,
  dedupe_key TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('warning','critical')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','acknowledged','resolved')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  acknowledged_at TEXT,
  acknowledged_by_user_id TEXT,
  resolved_at TEXT,
  resolved_by_user_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX idx_ops_incident_open_dedupe ON ops_incidents(dedupe_key) WHERE status IN ('open','acknowledged');
CREATE INDEX idx_ops_incidents_status ON ops_incidents(status,severity,opened_at DESC);

CREATE TABLE ops_alert_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  incident_id TEXT NOT NULL REFERENCES ops_incidents(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('opened','updated','resolved')),
  notification_target TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','retry','leased','sent','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  available_at TEXT NOT NULL,
  leased_at TEXT,
  sent_at TEXT,
  response_status INTEGER,
  last_error TEXT NOT NULL DEFAULT '',
  payload_sha256 TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_ops_alert_delivery_event ON ops_alert_deliveries(incident_id,event_type);
CREATE INDEX idx_ops_alert_delivery_queue ON ops_alert_deliveries(status,available_at,created_at);

CREATE TABLE ops_queue_definitions (
  queue_key TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  owner_team TEXT NOT NULL,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  lease_seconds INTEGER NOT NULL DEFAULT 120,
  warn_oldest_seconds INTEGER NOT NULL DEFAULT 300,
  critical_oldest_seconds INTEGER NOT NULL DEFAULT 1800,
  dead_letter_retention_days INTEGER NOT NULL DEFAULT 30,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE ops_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  queue_key TEXT NOT NULL REFERENCES ops_queue_definitions(queue_key) ON DELETE RESTRICT,
  job_type TEXT NOT NULL,
  dedupe_key TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','retry','completed','dead_letter','canceled')),
  priority INTEGER NOT NULL DEFAULT 100,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  available_at TEXT NOT NULL,
  leased_by TEXT,
  lease_until TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE UNIQUE INDEX idx_ops_jobs_dedupe_active ON ops_jobs(queue_key,dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','leased','retry');
CREATE INDEX idx_ops_jobs_queue ON ops_jobs(queue_key,status,available_at,priority,created_at);

CREATE TABLE ops_dead_letters (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES ops_jobs(id) ON DELETE RESTRICT,
  queue_key TEXT NOT NULL,
  job_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  last_error TEXT NOT NULL,
  first_failed_at TEXT NOT NULL,
  dead_lettered_at TEXT NOT NULL,
  replayed_job_id TEXT,
  replayed_by_user_id TEXT,
  replayed_at TEXT
);
CREATE INDEX idx_ops_dead_letters_queue ON ops_dead_letters(queue_key,dead_lettered_at DESC);

CREATE TABLE ops_worker_runs (
  id TEXT PRIMARY KEY NOT NULL,
  worker_key TEXT NOT NULL,
  service_principal_id TEXT REFERENCES service_principals(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','partial')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  processed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  last_checkpoint TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_ops_worker_runs ON ops_worker_runs(worker_key,started_at DESC);

CREATE TABLE ops_dependency_checks (
  id TEXT PRIMARY KEY NOT NULL,
  check_key TEXT NOT NULL,
  dependency_type TEXT NOT NULL CHECK(dependency_type IN ('database','storage','cdn','stripe','search','email','push','publisher_feed','catalog','other')),
  status TEXT NOT NULL CHECK(status IN ('healthy','degraded','down','unknown')),
  latency_ms INTEGER,
  freshness_seconds INTEGER,
  details_json TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT NOT NULL
);
CREATE INDEX idx_ops_dependency_checks ON ops_dependency_checks(check_key,checked_at DESC);

CREATE TABLE ops_recovery_objectives (
  service_key TEXT PRIMARY KEY NOT NULL,
  rpo_minutes INTEGER NOT NULL CHECK(rpo_minutes>=0),
  rto_minutes INTEGER NOT NULL CHECK(rto_minutes>0),
  backup_frequency_minutes INTEGER NOT NULL CHECK(backup_frequency_minutes>0),
  restore_drill_frequency_days INTEGER NOT NULL CHECK(restore_drill_frequency_days>0),
  owner_team TEXT NOT NULL,
  runbook_url TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE ops_backup_artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  service_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_backup_id TEXT NOT NULL,
  snapshot_at TEXT NOT NULL,
  size_bytes INTEGER,
  checksum_sha256 TEXT,
  status TEXT NOT NULL CHECK(status IN ('created','verified','failed','expired')),
  verification_json TEXT NOT NULL DEFAULT '{}',
  verified_at TEXT,
  recorded_at TEXT NOT NULL,
  UNIQUE(provider,provider_backup_id)
);
CREATE INDEX idx_ops_backups_service ON ops_backup_artifacts(service_key,snapshot_at DESC);

CREATE TABLE ops_restore_drills (
  id TEXT PRIMARY KEY NOT NULL,
  service_key TEXT NOT NULL,
  backup_artifact_id TEXT REFERENCES ops_backup_artifacts(id) ON DELETE SET NULL,
  environment TEXT NOT NULL DEFAULT 'isolated',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  restore_duration_seconds INTEGER,
  data_loss_window_seconds INTEGER,
  integrity_check_status TEXT NOT NULL DEFAULT 'pending' CHECK(integrity_check_status IN ('pending','passed','failed')),
  application_probe_status TEXT NOT NULL DEFAULT 'pending' CHECK(application_probe_status IN ('pending','passed','failed')),
  status TEXT NOT NULL CHECK(status IN ('running','passed','failed')),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  performed_by_user_id TEXT
);
CREATE INDEX idx_ops_restore_drills_service ON ops_restore_drills(service_key,started_at DESC);

CREATE TABLE ops_deployments (
  id TEXT PRIMARY KEY NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('staging','production')),
  release_version TEXT NOT NULL,
  previous_version TEXT,
  strategy TEXT NOT NULL CHECK(strategy IN ('blue_green','canary','rolling','emergency')),
  canary_percent INTEGER CHECK(canary_percent BETWEEN 0 AND 100),
  status TEXT NOT NULL CHECK(status IN ('planned','deploying','verifying','promoted','rolled_back','failed')),
  schema_migrations_json TEXT NOT NULL DEFAULT '[]',
  health_criteria_json TEXT NOT NULL DEFAULT '{}',
  rollback_plan_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  promoted_at TEXT,
  rolled_back_at TEXT,
  completed_at TEXT,
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ops_deployments_env ON ops_deployments(environment,created_at DESC);

CREATE TABLE ops_deployment_events (
  id TEXT PRIMARY KEY NOT NULL,
  deployment_id TEXT NOT NULL REFERENCES ops_deployments(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_user_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ops_deployment_events ON ops_deployment_events(deployment_id,created_at);

CREATE TABLE ops_migration_controls (
  migration_name TEXT PRIMARY KEY NOT NULL,
  backward_compatible INTEGER NOT NULL DEFAULT 1 CHECK(backward_compatible IN (0,1)),
  rollback_strategy TEXT NOT NULL CHECK(rollback_strategy IN ('down_sql','forward_fix','restore_required','expand_contract')),
  rollback_sql TEXT NOT NULL DEFAULT '',
  minimum_previous_app_version TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  reviewed_by_user_id TEXT,
  reviewed_at TEXT
);

CREATE TABLE ops_synthetic_checks (
  id TEXT PRIMARY KEY NOT NULL,
  check_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  check_type TEXT NOT NULL CHECK(check_type IN ('storefront','search','checkout','download','login','publisher_feed')),
  storefront_country TEXT,
  locale TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  schedule_minutes INTEGER NOT NULL DEFAULT 5,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE ops_synthetic_runs (
  id TEXT PRIMARY KEY NOT NULL,
  check_id TEXT NOT NULL REFERENCES ops_synthetic_checks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('passed','failed','degraded')),
  duration_ms INTEGER NOT NULL,
  step_results_json TEXT NOT NULL DEFAULT '[]',
  error TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);
CREATE INDEX idx_ops_synthetic_runs ON ops_synthetic_runs(check_id,started_at DESC);

CREATE TABLE ops_capacity_tests (
  id TEXT PRIMARY KEY NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('staging','production-shadow')),
  scenario_key TEXT NOT NULL,
  version TEXT NOT NULL,
  target_rps INTEGER NOT NULL,
  duration_seconds INTEGER NOT NULL,
  achieved_rps REAL NOT NULL DEFAULT 0,
  p50_ms INTEGER,
  p95_ms INTEGER,
  p99_ms INTEGER,
  error_rate_bps INTEGER,
  saturation_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK(status IN ('planned','running','passed','failed')),
  artifact_url TEXT NOT NULL DEFAULT '',
  run_by_user_id TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ops_capacity_tests ON ops_capacity_tests(scenario_key,created_at DESC);

-- Baseline global markets. The policy engine still accepts any sellable territory once a market is configured.
INSERT OR IGNORE INTO storefront_locales(locale,language_code,script_code,region_code,display_name,native_name,direction,fallback_locale,status,required_translation_coverage_bps,created_at,updated_at) VALUES
 ('en-US','en','Latn','US','English (United States)','English (United States)','ltr',NULL,'active',9500,datetime('now'),datetime('now')),
 ('en-GB','en','Latn','GB','English (United Kingdom)','English (United Kingdom)','ltr','en-US','active',9000,datetime('now'),datetime('now')),
 ('en-CA','en','Latn','CA','English (Canada)','English (Canada)','ltr','en-US','active',9000,datetime('now'),datetime('now')),
 ('en-AU','en','Latn','AU','English (Australia)','English (Australia)','ltr','en-GB','active',9000,datetime('now'),datetime('now')),
 ('fr-FR','fr','Latn','FR','French (France)','Français (France)','ltr','en-US','active',9000,datetime('now'),datetime('now')),
 ('fr-CA','fr','Latn','CA','French (Canada)','Français (Canada)','ltr','fr-FR','active',9000,datetime('now'),datetime('now')),
 ('de-DE','de','Latn','DE','German (Germany)','Deutsch (Deutschland)','ltr','en-US','active',9000,datetime('now'),datetime('now')),
 ('es-ES','es','Latn','ES','Spanish (Spain)','Español (España)','ltr','en-US','active',9000,datetime('now'),datetime('now')),
 ('es-MX','es','Latn','MX','Spanish (Mexico)','Español (México)','ltr','es-ES','active',9000,datetime('now'),datetime('now')),
 ('it-IT','it','Latn','IT','Italian (Italy)','Italiano (Italia)','ltr','en-US','active',9000,datetime('now'),datetime('now')),
 ('pt-BR','pt','Latn','BR','Portuguese (Brazil)','Português (Brasil)','ltr','en-US','active',9000,datetime('now'),datetime('now')),
 ('ja-JP','ja','Jpan','JP','Japanese (Japan)','日本語 (日本)','ltr','en-US','active',9000,datetime('now'),datetime('now')),
 ('ko-KR','ko','Kore','KR','Korean (Korea)','한국어 (대한민국)','ltr','en-US','active',9000,datetime('now'),datetime('now')),
 ('ar-SA','ar','Arab','SA','Arabic (Saudi Arabia)','العربية (السعودية)','rtl','en-US','active',9000,datetime('now'),datetime('now')),
 ('ar-AE','ar','Arab','AE','Arabic (UAE)','العربية (الإمارات)','rtl','ar-SA','active',9000,datetime('now'),datetime('now'));

INSERT OR IGNORE INTO storefront_markets(country_code,display_name,default_locale,default_currency,tax_inclusive_default,market_status,recommendation_region,merchandising_region,payment_provider,checkout_enabled,launched_at,created_at,updated_at)
SELECT code,name,
 CASE code WHEN 'GB' THEN 'en-GB' WHEN 'CA' THEN 'en-CA' WHEN 'AU' THEN 'en-AU' WHEN 'FR' THEN 'fr-FR' WHEN 'DE' THEN 'de-DE' WHEN 'ES' THEN 'es-ES' WHEN 'MX' THEN 'es-MX' WHEN 'IT' THEN 'it-IT' WHEN 'BR' THEN 'pt-BR' WHEN 'JP' THEN 'ja-JP' WHEN 'KR' THEN 'ko-KR' WHEN 'SA' THEN 'ar-SA' WHEN 'AE' THEN 'ar-AE' ELSE 'en-US' END,
 CASE code WHEN 'US' THEN 'USD' WHEN 'CA' THEN 'CAD' WHEN 'GB' THEN 'GBP' WHEN 'AU' THEN 'AUD' WHEN 'NZ' THEN 'NZD' WHEN 'JP' THEN 'JPY' WHEN 'KR' THEN 'KRW' WHEN 'BR' THEN 'BRL' WHEN 'MX' THEN 'MXN' WHEN 'IN' THEN 'INR' WHEN 'SG' THEN 'SGD' WHEN 'AE' THEN 'AED' WHEN 'SA' THEN 'SAR' WHEN 'ZA' THEN 'ZAR' WHEN 'CH' THEN 'CHF' ELSE 'EUR' END,
 CASE WHEN code IN ('US','CA') THEN 0 ELSE 1 END,'active',
 CASE WHEN code IN ('US','CA','MX') THEN 'north-america' WHEN code IN ('GB','IE','FR','DE','ES','IT','NL','BE','AT','CH') THEN 'europe' WHEN code IN ('JP','KR','SG','IN','AU','NZ') THEN 'asia-pacific' WHEN code IN ('AE','SA') THEN 'mena' WHEN code='BR' THEN 'latin-america' ELSE 'global' END,
 CASE WHEN code IN ('US','CA','MX') THEN 'north-america' WHEN code IN ('GB','IE','FR','DE','ES','IT','NL','BE','AT','CH') THEN 'europe' WHEN code IN ('JP','KR','SG','IN','AU','NZ') THEN 'asia-pacific' WHEN code IN ('AE','SA') THEN 'mena' WHEN code='BR' THEN 'latin-america' ELSE 'global' END,
 'stripe',1,datetime('now'),datetime('now'),datetime('now')
FROM territories WHERE code IN ('US','CA','GB','AU','NZ','IE','FR','DE','ES','IT','NL','BE','AT','CH','JP','KR','BR','MX','IN','SG','AE','SA','ZA');

INSERT OR IGNORE INTO storefront_market_locales(country_code,locale,priority,active)
SELECT country_code,default_locale,1,1 FROM storefront_markets;
INSERT OR IGNORE INTO storefront_market_locales(country_code,locale,priority,active) VALUES ('CA','fr-CA',2,1);
INSERT OR IGNORE INTO storefront_currency_options(country_code,currency,priority,active)
SELECT country_code,default_currency,1,1 FROM storefront_markets;

-- Regional storefront defaults connect market currency/tax presentation to the existing pricing policy.
-- Explicit publisher regional price schedules can satisfy a market without an FX quote; otherwise pricing fails closed.
INSERT OR IGNORE INTO pricing_region_rules(id,policy_id,territory_code,currency,floor_minor,ceiling_minor,tax_inclusive,fx_source,active,created_at,updated_at)
SELECT 'prr_default_'||lower(country_code),'pricing_default',country_code,default_currency,NULL,NULL,tax_inclusive_default,'provider',1,datetime('now'),datetime('now')
FROM storefront_markets;

INSERT OR IGNORE INTO storefront_payment_methods(country_code,payment_method,provider,currency,availability,priority,config_json,updated_at)
SELECT country_code,'card','stripe',default_currency,'available',1,'{}',datetime('now') FROM storefront_markets;
INSERT OR IGNORE INTO storefront_payment_methods(country_code,payment_method,provider,currency,availability,priority,config_json,updated_at) VALUES
 ('NL','ideal','stripe','EUR','planned',10,'{}',datetime('now')),('BE','bancontact','stripe','EUR','planned',10,'{}',datetime('now')),('DE','klarna','stripe','EUR','planned',20,'{}',datetime('now')),('AT','eps','stripe','EUR','planned',10,'{}',datetime('now')),('BR','pix','stripe','BRL','planned',10,'{}',datetime('now')),('BR','boleto','stripe','BRL','planned',20,'{}',datetime('now')),('JP','konbini','stripe','JPY','planned',10,'{}',datetime('now')),('SG','paynow','stripe','SGD','planned',10,'{}',datetime('now'));

-- Core UI bundles. The application falls back through the locale chain per message key; additional pages can be translated without code changes.
INSERT OR IGNORE INTO ui_translation_bundles(id,locale,version,status,source,message_count,translated_count,coverage_bps,checksum_sha256,created_at,activated_at) VALUES
 ('uib_en_us_v1','en-US',1,'active','fore',24,24,10000,'',datetime('now'),datetime('now')),
 ('uib_es_es_v1','es-ES',1,'active','fore',24,24,10000,'',datetime('now'),datetime('now')),
 ('uib_fr_fr_v1','fr-FR',1,'active','fore',24,24,10000,'',datetime('now'),datetime('now')),
 ('uib_de_de_v1','de-DE',1,'active','fore',24,24,10000,'',datetime('now'),datetime('now')),
 ('uib_ar_sa_v1','ar-SA',1,'active','fore',24,24,10000,'',datetime('now'),datetime('now'));

INSERT OR IGNORE INTO ui_translation_messages(bundle_id,message_key,message_value,updated_at) VALUES
 ('uib_en_us_v1','nav.bookstore','Bookstore',datetime('now')),('uib_en_us_v1','nav.audiobooks','Audiobooks',datetime('now')),('uib_en_us_v1','nav.library','My library',datetime('now')),('uib_en_us_v1','nav.wishlist','Wishlist',datetime('now')),('uib_en_us_v1','nav.cart','Cart',datetime('now')),('uib_en_us_v1','nav.orders','Orders',datetime('now')),('uib_en_us_v1','nav.notifications','Notifications',datetime('now')),('uib_en_us_v1','nav.shelves','Shelves',datetime('now')),('uib_en_us_v1','nav.stats','Stats',datetime('now')),('uib_en_us_v1','nav.highlights','Highlights & notes',datetime('now')),('uib_en_us_v1','nav.definitions','Word collection',datetime('now')),('uib_en_us_v1','nav.downloads','Downloads',datetime('now')),('uib_en_us_v1','nav.publishing','Cove Publishing',datetime('now')),('uib_en_us_v1','shell.readingRoom','Reading room',datetime('now')),('uib_en_us_v1','shell.yourReadingRoom','YOUR READING ROOM',datetime('now')),('uib_en_us_v1','shell.tagline1','A good book is',datetime('now')),('uib_en_us_v1','shell.tagline2','always a beginning.',datetime('now')),('uib_en_us_v1','shell.tagline3','YOUR BOOKSTORE. YOUR READING ROOM.',datetime('now')),('uib_en_us_v1','shell.skip','Skip to main content',datetime('now')),('uib_en_us_v1','shell.openNav','Open navigation',datetime('now')),('uib_en_us_v1','account.login','Log in',datetime('now')),('uib_en_us_v1','account.create','Create account',datetime('now')),('uib_en_us_v1','account.mine','My account',datetime('now')),('uib_en_us_v1','store.country','Storefront',datetime('now')),
 ('uib_es_es_v1','nav.bookstore','Librería',datetime('now')),('uib_es_es_v1','nav.audiobooks','Audiolibros',datetime('now')),('uib_es_es_v1','nav.library','Mi biblioteca',datetime('now')),('uib_es_es_v1','nav.wishlist','Lista de deseos',datetime('now')),('uib_es_es_v1','nav.cart','Carrito',datetime('now')),('uib_es_es_v1','nav.orders','Pedidos',datetime('now')),('uib_es_es_v1','nav.notifications','Notificaciones',datetime('now')),('uib_es_es_v1','nav.shelves','Estanterías',datetime('now')),('uib_es_es_v1','nav.stats','Estadísticas',datetime('now')),('uib_es_es_v1','nav.highlights','Subrayados y notas',datetime('now')),('uib_es_es_v1','nav.definitions','Colección de palabras',datetime('now')),('uib_es_es_v1','nav.downloads','Descargas',datetime('now')),('uib_es_es_v1','nav.publishing','Cove Publishing',datetime('now')),('uib_es_es_v1','shell.readingRoom','Sala de lectura',datetime('now')),('uib_es_es_v1','shell.yourReadingRoom','TU SALA DE LECTURA',datetime('now')),('uib_es_es_v1','shell.tagline1','Un buen libro es',datetime('now')),('uib_es_es_v1','shell.tagline2','siempre un comienzo.',datetime('now')),('uib_es_es_v1','shell.tagline3','TU LIBRERÍA. TU SALA DE LECTURA.',datetime('now')),('uib_es_es_v1','shell.skip','Saltar al contenido principal',datetime('now')),('uib_es_es_v1','shell.openNav','Abrir navegación',datetime('now')),('uib_es_es_v1','account.login','Iniciar sesión',datetime('now')),('uib_es_es_v1','account.create','Crear cuenta',datetime('now')),('uib_es_es_v1','account.mine','Mi cuenta',datetime('now')),('uib_es_es_v1','store.country','Tienda',datetime('now')),
 ('uib_fr_fr_v1','nav.bookstore','Librairie',datetime('now')),('uib_fr_fr_v1','nav.audiobooks','Livres audio',datetime('now')),('uib_fr_fr_v1','nav.library','Ma bibliothèque',datetime('now')),('uib_fr_fr_v1','nav.wishlist','Liste de souhaits',datetime('now')),('uib_fr_fr_v1','nav.cart','Panier',datetime('now')),('uib_fr_fr_v1','nav.orders','Commandes',datetime('now')),('uib_fr_fr_v1','nav.notifications','Notifications',datetime('now')),('uib_fr_fr_v1','nav.shelves','Étagères',datetime('now')),('uib_fr_fr_v1','nav.stats','Statistiques',datetime('now')),('uib_fr_fr_v1','nav.highlights','Surlignages et notes',datetime('now')),('uib_fr_fr_v1','nav.definitions','Collection de mots',datetime('now')),('uib_fr_fr_v1','nav.downloads','Téléchargements',datetime('now')),('uib_fr_fr_v1','nav.publishing','Cove Publishing',datetime('now')),('uib_fr_fr_v1','shell.readingRoom','Salon de lecture',datetime('now')),('uib_fr_fr_v1','shell.yourReadingRoom','VOTRE SALON DE LECTURE',datetime('now')),('uib_fr_fr_v1','shell.tagline1','Un bon livre est',datetime('now')),('uib_fr_fr_v1','shell.tagline2','toujours un commencement.',datetime('now')),('uib_fr_fr_v1','shell.tagline3','VOTRE LIBRAIRIE. VOTRE SALON DE LECTURE.',datetime('now')),('uib_fr_fr_v1','shell.skip','Aller au contenu principal',datetime('now')),('uib_fr_fr_v1','shell.openNav','Ouvrir la navigation',datetime('now')),('uib_fr_fr_v1','account.login','Se connecter',datetime('now')),('uib_fr_fr_v1','account.create','Créer un compte',datetime('now')),('uib_fr_fr_v1','account.mine','Mon compte',datetime('now')),('uib_fr_fr_v1','store.country','Boutique',datetime('now')),
 ('uib_de_de_v1','nav.bookstore','Buchhandlung',datetime('now')),('uib_de_de_v1','nav.audiobooks','Hörbücher',datetime('now')),('uib_de_de_v1','nav.library','Meine Bibliothek',datetime('now')),('uib_de_de_v1','nav.wishlist','Wunschliste',datetime('now')),('uib_de_de_v1','nav.cart','Warenkorb',datetime('now')),('uib_de_de_v1','nav.orders','Bestellungen',datetime('now')),('uib_de_de_v1','nav.notifications','Benachrichtigungen',datetime('now')),('uib_de_de_v1','nav.shelves','Regale',datetime('now')),('uib_de_de_v1','nav.stats','Statistiken',datetime('now')),('uib_de_de_v1','nav.highlights','Markierungen & Notizen',datetime('now')),('uib_de_de_v1','nav.definitions','Wortsammlung',datetime('now')),('uib_de_de_v1','nav.downloads','Downloads',datetime('now')),('uib_de_de_v1','nav.publishing','Cove Publishing',datetime('now')),('uib_de_de_v1','shell.readingRoom','Lesezimmer',datetime('now')),('uib_de_de_v1','shell.yourReadingRoom','DEIN LESEZIMMER',datetime('now')),('uib_de_de_v1','shell.tagline1','Ein gutes Buch ist',datetime('now')),('uib_de_de_v1','shell.tagline2','immer ein Anfang.',datetime('now')),('uib_de_de_v1','shell.tagline3','DEINE BUCHHANDLUNG. DEIN LESEZIMMER.',datetime('now')),('uib_de_de_v1','shell.skip','Zum Hauptinhalt springen',datetime('now')),('uib_de_de_v1','shell.openNav','Navigation öffnen',datetime('now')),('uib_de_de_v1','account.login','Anmelden',datetime('now')),('uib_de_de_v1','account.create','Konto erstellen',datetime('now')),('uib_de_de_v1','account.mine','Mein Konto',datetime('now')),('uib_de_de_v1','store.country','Shop',datetime('now')),
 ('uib_ar_sa_v1','nav.bookstore','متجر الكتب',datetime('now')),('uib_ar_sa_v1','nav.audiobooks','الكتب الصوتية',datetime('now')),('uib_ar_sa_v1','nav.library','مكتبتي',datetime('now')),('uib_ar_sa_v1','nav.wishlist','قائمة الرغبات',datetime('now')),('uib_ar_sa_v1','nav.cart','السلة',datetime('now')),('uib_ar_sa_v1','nav.orders','الطلبات',datetime('now')),('uib_ar_sa_v1','nav.notifications','الإشعارات',datetime('now')),('uib_ar_sa_v1','nav.shelves','الرفوف',datetime('now')),('uib_ar_sa_v1','nav.stats','الإحصاءات',datetime('now')),('uib_ar_sa_v1','nav.highlights','التظليل والملاحظات',datetime('now')),('uib_ar_sa_v1','nav.definitions','مجموعة الكلمات',datetime('now')),('uib_ar_sa_v1','nav.downloads','التنزيلات',datetime('now')),('uib_ar_sa_v1','nav.publishing','Cove Publishing',datetime('now')),('uib_ar_sa_v1','shell.readingRoom','غرفة القراءة',datetime('now')),('uib_ar_sa_v1','shell.yourReadingRoom','غرفة قراءتك',datetime('now')),('uib_ar_sa_v1','shell.tagline1','الكتاب الجيد هو',datetime('now')),('uib_ar_sa_v1','shell.tagline2','دائمًا بداية.',datetime('now')),('uib_ar_sa_v1','shell.tagline3','متجر كتبك. غرفة قراءتك.',datetime('now')),('uib_ar_sa_v1','shell.skip','انتقل إلى المحتوى الرئيسي',datetime('now')),('uib_ar_sa_v1','shell.openNav','فتح التنقل',datetime('now')),('uib_ar_sa_v1','account.login','تسجيل الدخول',datetime('now')),('uib_ar_sa_v1','account.create','إنشاء حساب',datetime('now')),('uib_ar_sa_v1','account.mine','حسابي',datetime('now')),('uib_ar_sa_v1','store.country','المتجر',datetime('now'));

-- Localized category examples; the localization table supports complete market-specific taxonomy translation without duplicating taxonomy identity.
INSERT OR IGNORE INTO storefront_taxonomy_node_localizations(taxonomy_node_id,locale,name,description,seo_title,seo_description,updated_at)
SELECT id,'es-ES','Ficción y literatura','Novelas, relatos, clásicos y ficción literaria.','','',datetime('now') FROM storefront_taxonomy_nodes WHERE id='tax_fiction';
INSERT OR IGNORE INTO storefront_taxonomy_node_localizations(taxonomy_node_id,locale,name,description,seo_title,seo_description,updated_at)
SELECT id,'fr-FR','Fiction et littérature','Romans, récits, classiques et fiction littéraire.','','',datetime('now') FROM storefront_taxonomy_nodes WHERE id='tax_fiction';
INSERT OR IGNORE INTO storefront_taxonomy_node_localizations(taxonomy_node_id,locale,name,description,seo_title,seo_description,updated_at)
SELECT id,'de-DE','Belletristik & Literatur','Romane, Erzählungen, Klassiker und literarische Belletristik.','','',datetime('now') FROM storefront_taxonomy_nodes WHERE id='tax_fiction';
INSERT OR IGNORE INTO storefront_taxonomy_node_localizations(taxonomy_node_id,locale,name,description,seo_title,seo_description,updated_at)
SELECT id,'ar-SA','الأدب والخيال','الروايات والقصص والكلاسيكيات والأدب الروائي.','','',datetime('now') FROM storefront_taxonomy_nodes WHERE id='tax_fiction';

-- Default service principals have no credentials until an authorized human issues one.
INSERT OR IGNORE INTO service_principals(id,name,description,owner_team,environment,status,created_at,updated_at) VALUES
 ('svc_catalog_pipeline','catalog-pipeline','Catalog harvesting, normalization and search indexing worker.','catalog','production','active',datetime('now'),datetime('now')),
 ('svc_audio_pipeline','audio-pipeline','Gutenberg/commercial audiobook preparation and cache worker.','catalog','production','active',datetime('now'),datetime('now')),
 ('svc_publishing_worker','publishing-worker','Publishing validation, release and partner-feed worker.','publishing','production','active',datetime('now'),datetime('now')),
 ('svc_ops_scheduler','operations-scheduler','Reliability checks, SLO calculations, synthetic tests and queue maintenance.','reliability','production','active',datetime('now'),datetime('now'));
INSERT OR IGNORE INTO service_principal_scopes(principal_id,scope,granted_at) VALUES
 ('svc_catalog_pipeline','catalog.ingest',datetime('now')),('svc_catalog_pipeline','search.reindex',datetime('now')),('svc_catalog_pipeline','pipeline.process',datetime('now')),
 ('svc_audio_pipeline','audio.ingest',datetime('now')),('svc_audio_pipeline','audio.prepare',datetime('now')),
 ('svc_publishing_worker','publishing.worker',datetime('now')),('svc_publishing_worker','partner.feed.process',datetime('now')),('svc_publishing_worker','notifications.deliver',datetime('now')),
 ('svc_ops_scheduler','operations.check',datetime('now')),('svc_ops_scheduler','operations.synthetic',datetime('now')),('svc_ops_scheduler','operations.queue',datetime('now')),('svc_ops_scheduler','operations.backup',datetime('now')),('svc_ops_scheduler','operations.alert',datetime('now'));

INSERT OR IGNORE INTO ops_queue_definitions(queue_key,name,owner_team,max_attempts,lease_seconds,warn_oldest_seconds,critical_oldest_seconds,dead_letter_retention_days,created_at,updated_at) VALUES
 ('notifications','Notification delivery','growth',8,120,300,1800,30,datetime('now'),datetime('now')),
 ('publisher-feeds','Publisher feed application','publishing',8,300,600,3600,90,datetime('now'),datetime('now')),
 ('catalog-ingest','Catalog ingestion','catalog',8,300,900,7200,30,datetime('now'),datetime('now')),
 ('search-index','Search indexing','catalog',8,180,600,3600,30,datetime('now'),datetime('now')),
 ('recommendations','Recommendation maintenance','discovery',8,180,900,7200,30,datetime('now'),datetime('now')),
 ('publishing-validation','Publishing validation','publishing',8,300,600,3600,90,datetime('now'),datetime('now'));

INSERT OR IGNORE INTO ops_slo_definitions(id,service_name,slo_key,description,indicator_type,target_bps,window_days,threshold_ms,threshold_seconds,status,created_at,updated_at) VALUES
 ('slo_store_api_availability','storefront-api','storefront-api-availability','Successful storefront API requests excluding expected 4xx responses.','availability',9990,30,NULL,NULL,'active',datetime('now'),datetime('now')),
 ('slo_store_api_latency','storefront-api','storefront-api-p95-latency','Storefront API requests completing within 750 ms.','latency',9900,30,750,NULL,'active',datetime('now'),datetime('now')),
 ('slo_catalog_freshness','catalog','catalog-freshness','Catalog ingest remains within the configured freshness window.','freshness',9990,30,NULL,21600,'active',datetime('now'),datetime('now')),
 ('slo_payment_webhooks','commerce','payment-webhook-success','Stripe webhook processing succeeds without backlog or repeated failures.','webhook_success',9990,30,NULL,600,'active',datetime('now'),datetime('now')),
 ('slo_synthetic_checkout','commerce','synthetic-checkout-success','Synthetic checkout quote/rights/price path succeeds.','synthetic_success',9950,30,NULL,NULL,'active',datetime('now'),datetime('now'));

INSERT OR IGNORE INTO ops_alert_rules(id,rule_key,name,severity,signal_type,config_json,notification_target,active,created_at,updated_at) VALUES
 ('alert_catalog_stale','catalog-stale','Catalog freshness exceeded','warning','freshness','{"thresholdSeconds":21600}','catalog-oncall',1,datetime('now'),datetime('now')),
 ('alert_feed_backlog','publisher-feed-backlog','Publisher feed backlog too old','warning','queue','{"queue":"publisher-feeds","thresholdSeconds":3600}','publishing-oncall',1,datetime('now'),datetime('now')),
 ('alert_payment_webhook','payment-webhook-failure','Payment webhook processing unhealthy','critical','webhook','{"thresholdSeconds":600}','commerce-oncall',1,datetime('now'),datetime('now')),
 ('alert_backup_stale','backup-stale','Verified backup is older than RPO policy','critical','backup','{}','platform-oncall',1,datetime('now'),datetime('now')),
 ('alert_restore_drill','restore-drill-overdue','Restore drill overdue or failed','critical','backup','{}','platform-oncall',1,datetime('now'),datetime('now')),
 ('alert_dlq','dead-letter-present','Dead-letter queue contains unreplayed jobs','warning','queue','{}','platform-oncall',1,datetime('now'),datetime('now')),
 ('alert_queue_backlog','queue-backlog','Operations queue backlog exceeded','warning','queue','{}','platform-oncall',1,datetime('now'),datetime('now')),
 ('alert_synthetic_checkout','synthetic-checkout-failing','Synthetic checkout failing','critical','synthetic','{"check":"checkout-us"}','commerce-oncall',1,datetime('now'),datetime('now')),
 ('alert_object_storage','object-storage-down','Object storage probe failing','critical','storage','{}','platform-oncall',1,datetime('now'),datetime('now')),
 ('alert_cdn_edge','cdn-edge-down','CDN edge probe failing','critical','storage','{}','platform-oncall',1,datetime('now'),datetime('now'));

INSERT OR IGNORE INTO ops_recovery_objectives(service_key,rpo_minutes,rto_minutes,backup_frequency_minutes,restore_drill_frequency_days,owner_team,runbook_url,updated_at) VALUES
 ('primary-database',15,60,15,30,'platform','docs/PRODUCTION_OPERATIONS.md',datetime('now')),
 ('asset-storage',60,240,60,90,'platform','docs/PRODUCTION_OPERATIONS.md',datetime('now')),
 ('search-index',1440,240,1440,90,'catalog','docs/PRODUCTION_OPERATIONS.md',datetime('now'));

INSERT OR IGNORE INTO ops_synthetic_checks(id,check_key,name,check_type,storefront_country,locale,config_json,schedule_minutes,active,created_at,updated_at) VALUES
 ('syn_store_us','storefront-us','US storefront browse','storefront','US','en-US','{}',5,1,datetime('now'),datetime('now')),
 ('syn_search_us','search-us','US catalog search','search','US','en-US','{"query":"Pride and Prejudice"}',5,1,datetime('now'),datetime('now')),
 ('syn_checkout_us','checkout-us','US checkout quote','checkout','US','en-US','{}',10,1,datetime('now'),datetime('now'));

INSERT OR IGNORE INTO ops_migration_controls(migration_name,backward_compatible,rollback_strategy,rollback_sql,minimum_previous_app_version,notes)
VALUES('0035_global_storefront_staff_ops_observability.sql',1,'expand_contract','','','Expand-only schema. Roll back application first; remove new tables only after all old binaries are serving and data retention requirements are satisfied.');
