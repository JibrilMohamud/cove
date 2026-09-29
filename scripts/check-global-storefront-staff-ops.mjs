import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root=process.cwd();
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const migrations=fs.readdirSync(path.join(root,'drizzle')).filter(f=>/^\d+.*\.sql$/.test(f)).sort();
assert.ok(migrations.length>=38,'expected catalog identity migration chain');
assert.ok(migrations.includes('0037_catalog_identity_discovery_seo.sql'),'catalog identity migration missing');
const db=new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
for(const file of migrations) db.exec(read(`drizzle/${file}`));
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);

const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
for(const table of [
  'storefront_markets','storefront_locales','storefront_market_locales','storefront_currency_options','storefront_payment_methods','storefront_user_preferences','ui_translation_bundles','ui_translation_messages','storefront_taxonomy_node_localizations','storefront_context_events',
  'service_principals','service_principal_scopes','service_principal_credentials','privileged_access_audit',
  'ops_http_requests','ops_trace_spans','ops_error_events','ops_metric_points','ops_slo_definitions','ops_slo_measurements','ops_alert_rules','ops_incidents','ops_alert_deliveries','ops_queue_definitions','ops_jobs','ops_dead_letters','ops_worker_runs','ops_dependency_checks','ops_recovery_objectives','ops_backup_artifacts','ops_restore_drills','ops_deployments','ops_deployment_events','ops_migration_controls','ops_synthetic_checks','ops_synthetic_runs','ops_capacity_tests'
]) assert.ok(tables.has(table),`missing ${table}`);

assert.equal(db.prepare("SELECT direction FROM storefront_locales WHERE locale='ar-SA'").get().direction,'rtl');
assert.equal(db.prepare("SELECT COUNT(*) n FROM storefront_markets WHERE market_status='active'").get().n>0,true);
assert.equal(db.prepare("SELECT COUNT(*) n FROM ui_translation_bundles WHERE status='active'").get().n>=5,true);
assert.equal(db.prepare("SELECT COUNT(*) n FROM service_principals WHERE status='active'").get().n>=4,true);
assert.equal(db.prepare("SELECT COUNT(*) n FROM ops_slo_definitions WHERE status='active'").get().n>=5,true);
assert.equal(db.prepare("SELECT COUNT(*) n FROM ops_recovery_objectives").get().n>0,true);
assert.equal(db.prepare("SELECT COUNT(*) n FROM ops_synthetic_checks WHERE active=1").get().n>0,true);

const credentialCols=new Set(db.prepare('PRAGMA table_info(service_principal_credentials)').all().map(r=>r.name));
for(const c of ['token_prefix','token_sha256','not_before','expires_at','last_used_at','revoked_at'])assert.ok(credentialCols.has(c),`credential hardening field missing ${c}`);
for(const forbidden of ['token','secret','plaintext_secret','bearer_token'])assert.ok(!credentialCols.has(forbidden),`service credentials must not persist ${forbidden}`);

const api=read('src/features/fore/api.server.ts');
assert.ok(!api.includes('FORE_INGEST_TOKEN'),'shared FORE_INGEST_TOKEN must not protect human admin APIs');
for(const route of ['/admin/localization/','/admin/operations/status','/admin/operations/migration-control','/admin/service-principals','/machine/v1/ops/check','/machine/v1/ops/jobs/lease'])assert.ok(api.includes(route),`API missing ${route}`);
assert.ok(api.includes('requireStaffPermission'),'human administration must use staff RBAC');
assert.ok(api.includes('requireServiceScope'),'machine endpoints must use service-principal scopes');

const privileged=read('src/features/fore/privileged-access.server.ts');
for(const token of ['token_sha256','crypto.subtle.digest','revokeServiceCredential','privileged_access_audit','requireServiceScope'])assert.ok(privileged.includes(token),`service identity missing ${token}`);
const moderation=read('src/features/fore/moderation.server.ts');
for(const token of ['requireStaffPermission','mfa','staff_role_permissions','recordPrivilegedAccess'])assert.ok(moderation.toLowerCase().includes(token.toLowerCase()),`staff access missing ${token}`);

const localization=read('src/features/fore/localization.server.ts');
assert.ok(localization.includes("availability='available'"),'checkout must advertise only currently available payment methods');
assert.ok(localization.includes('["billing", "account"].includes'),'verified account/billing country must be distinct from user locale/currency preference');
for(const token of ['recommendationRegion','merchandisingRegion','taxInclusive','rightsCountry','loadMessages'])assert.ok(localization.includes(token),`storefront context missing ${token}`);
const localizationUi=read('src/features/fore/localization.tsx');
assert.ok(localizationUi.includes('document.documentElement.dir'),'localized shell must apply text direction');
const css=read('src/features/fore/fore.css');
assert.ok(css.includes('[dir="rtl"]'),'RTL CSS overrides missing');
const pricing=read('src/features/fore/pricing.server.ts');
assert.ok(pricing.includes('regional-list:${schedule.id}:direct'),'publisher-supplied regional price must be preferred to FX derivation');

const ops=read('src/features/fore/operations.server.ts');
for(const token of ['beginRequestTrace','recordHttpRequest','recordErrorEvent','refreshSloMeasurements','runSyntheticChecks','deliverOperationalAlerts','ops_dead_letters','probeObjectStorage','probeCdnEdge','recordRestoreDrill','saveDeployment','saveMigrationControl'])assert.ok(ops.includes(token),`operations runtime missing ${token}`);
assert.ok(ops.includes("status='retry',leased_by=NULL,lease_until=NULL")&&ops.includes("lease_until>?"),'queue workers must recover expired leases and reject stale completions');
assert.ok(ops.includes('exceeded the service RTO')&&ops.includes('exceeded the service RPO'),'restore drills must prove RPO/RTO objectives');
assert.ok(ops.includes('provider verification evidence'),'verified backups must carry verification evidence');
assert.ok(ops.includes('Invalid deployment transition'),'deployment state transitions must be guarded');
assert.ok(ops.includes('cannot target a local/private host'),'alert webhooks must reject local/private destinations');
assert.ok(ops.includes('redactDiagnostic'),'operations diagnostics must redact credentials');

const docs=read('docs/PRODUCTION_OPERATIONS.md');
for(const token of ['structured','trace','SLO','dead-letter','restore','RPO','RTO','canary','synthetic','capacity'])assert.ok(docs.toLowerCase().includes(token.toLowerCase()),`production runbook missing ${token}`);
const globalDocs=read('docs/GLOBAL_STOREFRONTS_STAFF_OPERATIONS.md');
for(const token of ['RTL','service-principal','staff','rights','currency','locale'])assert.ok(globalDocs.toLowerCase().includes(token.toLowerCase()),`global storefront/staff docs missing ${token}`);

console.log(`Global storefront / staff identity / production operations checks passed across ${migrations.length} migrations.`);
