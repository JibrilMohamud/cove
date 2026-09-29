import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root=process.cwd(), read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const migrations=fs.readdirSync(path.join(root,'drizzle')).filter(f=>/^\d+.*\.sql$/.test(f)).sort();
assert.ok(migrations.length>=38,'expected catalog identity migration chain');
assert.ok(migrations.includes('0037_catalog_identity_discovery_seo.sql'),'catalog identity migration missing');
const db=new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
for(const f of migrations) db.exec(read(`drizzle/${f}`));
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);

const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
for(const t of ['publisher_partner_profiles','publisher_partner_credentials','publisher_ingestion_channels','publisher_feed_submissions','publisher_feed_items','publisher_feed_assets','publisher_asset_expectations','publisher_validation_responses','publisher_feed_cursors','publisher_catalog_mappings','publisher_partner_audit_events','rights_contract_versions','rights_contract_version_territories','rights_contract_version_formats','rights_contract_version_channels','publisher_contract_assignments','rights_contract_audit','work_identity_keys','work_redirects','edition_distinctions','public_domain_policy_versions','edition_duplicate_policy_decisions']) assert.ok(tables.has(t),`missing ${t}`);

const now='2026-09-25T12:00:00.000Z';
db.prepare("INSERT INTO publishing_accounts(id,account_type,legal_name,display_name,country_code,status,created_at,updated_at) VALUES('pa','company','Acme Publishing LLC','Acme','US','active',?,?)").run(now,now);
db.prepare("INSERT INTO rights_contracts(id,reference_code,name,status,language_match_mode,source,notes,created_at,updated_at) VALUES('rc','ACME-2026','Acme distribution','active','all','operator','',?,?)").run(now,now);
db.prepare("INSERT INTO publisher_feed_submissions(id,account_id,environment,feed_type,feed_format,mode,external_feed_id,source_filename,source_sha256,status,received_at) VALUES('feed','pa','sandbox','assets_manifest','fore_json','delta','asset-1','manifest.json',?,'accepted',?)").run('a'.repeat(64),now);
assert.equal(db.prepare("SELECT feed_type FROM publisher_feed_submissions WHERE id='feed'").get().feed_type,'assets_manifest');

db.prepare("INSERT INTO rights_contract_versions(id,contract_id,version_number,status,effective_from,retailer_commission_bps,created_at) VALUES('rcv','rc',1,'draft',?,2500,?)").run(now,now);
db.prepare("INSERT INTO rights_contract_version_territories(contract_version_id,territory_code,decision) VALUES('rcv','US','allow')").run();
db.prepare("INSERT INTO rights_contract_version_formats(contract_version_id,format,decision,drm_requirement,download_limit,device_limit,offline_permitted) VALUES('rcv','ebook','allow','watermark',5,3,1)").run();
db.prepare("INSERT INTO rights_contract_version_channels(contract_version_id,sales_channel,permitted,terms_json) VALUES('rcv','retail',1,'{}')").run();
db.prepare("UPDATE rights_contract_versions SET status='active',approved_at=?,approved_by_user_id='staff' WHERE id='rcv'").run(now);
let blocked=false; try{db.prepare("UPDATE rights_contract_versions SET retailer_commission_bps=1000 WHERE id='rcv'").run()}catch{blocked=true} assert.ok(blocked,'activated contract economics must be immutable');
blocked=false; try{db.prepare("UPDATE rights_contract_version_formats SET device_limit=99 WHERE contract_version_id='rcv' AND format='ebook'").run()}catch{blocked=true} assert.ok(blocked,'activated format policy must be immutable');
db.prepare("UPDATE rights_contract_versions SET status='superseded',effective_to='2027-01-01T00:00:00.000Z' WHERE id='rcv'").run();

const pd=db.prepare("SELECT * FROM public_domain_policy_versions WHERE status='active'").get();
assert.equal(pd.version,'fore-public-domain-editions-v1');
assert.match(pd.duplicate_policy_json,/identicalAssetHashIsDuplicate/);

const server=read('src/features/fore/traditional-publishing.server.ts');
for(const token of ['parseOnix','assets_manifest','uploadPartnerAssetBatch','publisher_asset_expectations','deliverPartnerValidationResponses','HMAC-SHA256','safePartnerCallbackUrl','processPartnerFeedQueue','saveContractVersion','reconcilePublicDomainWorks','editionDifferentiationDecision','work_identity_keys','partner.feed.applied']) assert.ok(server.includes(token),`traditional publishing server missing ${token}`);
for(const token of ['<!DOCTYPE|<!ENTITY','ONIX short-tag-only','sequence_number','idempotentReplay','checkCRC32','manifest.json','redirect: "error"','X-Cove-Signature','next_attempt_at','x-fore-channel-id','channel_id','applyAssetManifestItem']) assert.ok(server.includes(token),`ingestion hardening missing ${token}`);
const api=read('src/features/fore/api.server.ts');
for(const route of ['/partner/v1/feeds','/partner/v1/assets','/partner/v1/assets/batch','/publishing/partner/webhook-secret','/publishing-worker/partner-feeds/tick','/publishing-worker/partner-acknowledgements/tick','/admin/publishing/distribution-contract-version','/admin/publishing/contract-assignment','/works/']) assert.ok(api.includes(route),`API missing ${route}`);
const rights=read('src/features/fore/rights.server.ts'), delivery=read('src/features/fore/delivery.server.ts'), publishing=read('src/features/fore/publishing.server.ts');
for(const token of ['contract_policy_json','rights_contract_version_territories','rights_contract_version_formats','rights_contract_version_channels']) assert.ok(rights.includes(token),`rights enforcement missing ${token}`);
for(const token of ['postTerminationAccessPolicy','contractPolicy','deviceLimit','downloadLimit']) assert.ok(delivery.includes(token),`delivery contract enforcement missing ${token}`);
for(const token of ['differentiation_summary','contract_version_id','canonical_public_domain','edition_distinctions','byte-identical']) assert.ok(publishing.includes(token),`publishing policy missing ${token}`);
const work=read('src/features/fore/Work.tsx'), discovery=read('src/features/fore/discovery.server.ts');
assert.ok(work.includes('editions')); assert.ok(discovery.includes('workDetail')); assert.ok(discovery.includes('canonical_public_domain'));
assert.ok(fs.existsSync(path.join(root,'docs/TRADITIONAL_PUBLISHING_CONTRACTS.md')));
console.log(`Traditional publisher ingestion / contract policy / Work-Edition checks passed across ${migrations.length} migrations.`);
