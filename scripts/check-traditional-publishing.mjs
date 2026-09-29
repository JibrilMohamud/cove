import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root=process.cwd(), read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const migrations=fs.readdirSync(path.join(root,'drizzle')).filter(x=>/^\d{4}_.+\.sql$/.test(x)).sort();
assert.ok(migrations.includes('0037_catalog_identity_discovery_seo.sql'),'catalog identity migration missing');
assert.ok(migrations.length>=38,'expected catalog identity migration chain');
const migration=read('drizzle/0033_traditional_publishing_contracts_work_editions.sql');
for(const table of ['publisher_partner_profiles','publisher_partner_credentials','publisher_ingestion_channels','publisher_feed_submissions','publisher_feed_items','publisher_feed_assets','publisher_validation_responses','publisher_feed_cursors','publisher_catalog_mappings','publisher_partner_audit_events','rights_contract_versions','rights_contract_version_territories','rights_contract_version_formats','rights_contract_version_channels','publisher_contract_assignments','rights_contract_audit','work_identity_keys','work_redirects','edition_distinctions','public_domain_policy_versions','edition_duplicate_policy_decisions']) assert.ok(migration.includes(`CREATE TABLE ${table}`)||migration.includes(`CREATE TABLE IF NOT EXISTS ${table}`),`missing ${table}`);
assert.ok(migration.includes("feed_type IN ('metadata','price','availability','territory','assets_manifest')"),'feed types must explicitly include metadata/delta and asset-manifest workflows');
assert.ok(migration.includes("canonical_public_domain"));
assert.ok(migration.includes("new_translation"));
assert.ok(migration.includes("post_termination_access_policy"));
assert.ok(migration.includes("contract_version_id"));

const db=new DatabaseSync(':memory:');
for(const name of migrations) db.exec(read(`drizzle/${name}`).replaceAll('--> statement-breakpoint',';'));
db.exec('PRAGMA foreign_keys=ON');
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[],'migration chain must have clean foreign keys');
const cols=(t)=>new Set(db.prepare(`pragma table_info(${t})`).all().map(x=>String(x.name)));
for(const c of ['secret_hash','key_prefix','environment','scopes_json','ip_allowlist_json','status']) assert(cols('publisher_partner_credentials').has(c),`partner credential missing ${c}`);
assert(!cols('publisher_partner_credentials').has('secret'),'partner API secrets must not be stored in plaintext');
for(const c of ['retailer_commission_bps','payment_schedule_json','returns_policy_json','subscription_terms_json','marketing_permissions_json','drm_requirements_json','delivery_rules_json','termination_policy_json','post_termination_access_policy']) assert(cols('rights_contract_versions').has(c),`contract version missing ${c}`);
for(const c of ['edition_type','differentiation_status','differentiation_summary','canonical_public_domain']) assert(cols('editions').has(c),`edition classification missing ${c}`);

const server=read('src/features/fore/traditional-publishing.server.ts');
for(const token of ['authenticatePartnerRequest','submitPartnerFeed','parseOnix','processPartnerFeedQueue','uploadPartnerAssetBatch','deliverPartnerValidationResponses','certifyPartnerProfile','saveContractVersion','assignPublisherContract','reconcilePublicDomainWorks','rebuildWorkIdentityKeys','candidateWorkIdentityKeys','X-Cove-Signature','Idempotency-Key','x-fore-full-feed-delete-missing','INITIAL_PRICE_REQUIRED','INITIAL_TERRITORY_REQUIRED']) assert.ok(server.includes(token),`traditional publisher server missing ${token}`);
assert.doesNotMatch(server,/productionStatus\s*=\s*x\.productionStatus/,'publisher admins must not self-certify production');
assert.match(server,/secret_hash/);assert.match(server,/crypto\.subtle\.digest\("SHA-256"/);assert.match(server,/totalExtracted>300\*1024\*1024/,'bulk archive expansion must be bounded');
assert.ok(server.includes('private network addresses'),'callback URLs must reject obvious private-network targets');

const rights=read('src/features/fore/rights.server.ts');
for(const token of ['resolveContractPolicyForGrant','contractVersionId','contract_policy_json','rights_contract_version_territories','rights_contract_version_formats','rights_contract_version_channels']) assert.ok(rights.includes(token),`rights engine missing ${token}`);
const delivery=read('src/features/fore/delivery.server.ts');
for(const token of ['postTerminationAccessPolicy','preserve_perpetual_purchases','preserve_downloaded_only','block_future_downloads','revoke_all','contract_delivery_blocked']) assert.ok(delivery.includes(token),`delivery contract enforcement missing ${token}`);
const publishing=read('src/features/fore/publishing.server.ts');
for(const token of ['rightsContractVersionId','publishingAccountId','retailer_commission_bps','payment_schedule_json','scheduled commercial release','byte-identical']) assert.ok(publishing.includes(token),`publication materialization missing ${token}`);
const catalog=read('src/features/fore/catalog-model.server.ts');assert.ok(catalog.includes("canonical_public_domain"));assert.ok(catalog.includes("work_type='public_domain'"));
const discovery=read('src/features/fore/discovery.server.ts');for(const token of ['workDetail','work_redirects','editionType','availableInTerritory']) assert.ok(discovery.includes(token),`work discovery missing ${token}`);
const api=read('src/features/fore/api.server.ts');for(const token of ['/partner/v1/feeds','/partner/v1/assets/batch','/partner/v1/ping','/publishing-worker/partner-feeds/tick','/publishing-worker/partner-acknowledgements/tick','/publishing-worker/work-reconciliation/tick','/admin/publishing/distribution-contract-version','/admin/publishing/partner-certification','/publishing/partner/webhook-secret','/works/']) assert.ok(api.includes(token),`API missing ${token}`);
const ui=read('src/features/fore/TraditionalPublishing.tsx');for(const token of ['Acknowledgement callback URL','Reveal HMAC signing secret','X-Cove-Full-Feed-Delete-Missing','assets/batch','Distribution contracts']) assert.ok(ui.includes(token),`publisher dashboard missing ${token}`);
const workUi=read('src/features/fore/Work.tsx');for(const token of ['Canonical free edition','New translation','Unavailable in your territory']) assert.ok(workUi.includes(token),`work page missing ${token}`);
const routes=read('src/routeTree.gen.ts');assert.ok(routes.includes("'/work/$id'"),'generated route tree must include Work page');
console.log(`Traditional publishing / contracts / Work-edition checks passed across ${migrations.length} migrations.`);
