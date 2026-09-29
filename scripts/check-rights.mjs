import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const root=process.cwd(),db=new DatabaseSync(':memory:');
const migrations=fs.readdirSync(path.join(root,'drizzle')).filter(x=>/^\d{4}_.+\.sql$/.test(x)).sort();
for(const name of migrations) db.exec(fs.readFileSync(path.join(root,'drizzle',name),'utf8').replaceAll('--> statement-breakpoint',';'));
db.exec('PRAGMA foreign_keys=ON');

const tables=new Set(db.prepare("select name from sqlite_master where type='table'").all().map(x=>x.name));
for(const t of ['rights_parties','rights_grants','rights_decisions','rights_grant_audit','territory_sets','territory_set_rules','territory_set_members','territory_historical_entities','territory_historical_successors','rights_contracts','rights_contract_languages','rights_grant_territory_scopes','rights_grant_territories','rights_grant_scope_snapshots','rights_configuration_audit']) assert(tables.has(t),`missing ${t}`);
const views=new Set(db.prepare("select name from sqlite_master where type='view'").all().map(x=>x.name));
assert(views.has('retail_product_availability'),'missing fail-closed retail rights view');
assert(views.has('product_channel_availability'),'missing unified channel rights view');
const grantCols=new Set(db.prepare('pragma table_info(rights_grants)').all().map(x=>x.name));
for(const c of ['rightsholder_party_id','territory_code','format','sales_channel','starts_at','ends_at','license_type','drm_requirement','subscription_permitted','library_permitted','decision','status','promotion_restrictions_json','contract_reference','source','notes','contract_id','exclusivity','scope_summary'])assert(grantCols.has(c),`rights_grants missing ${c}`);
const decisionCols=new Set(db.prepare('pragma table_info(rights_decisions)').all().map(x=>x.name));
for(const c of ['contract_id','scope_summary','exclusivity','language_rights_json']) assert(decisionCols.has(c),`rights_decisions missing ${c}`);
assert(new Set(db.prepare('pragma table_info(offers)').all().map(x=>x.name)).has('sales_channel'),'offers missing sales_channel');
const itemCols=new Set(db.prepare('pragma table_info(commerce_order_items)').all().map(x=>x.name));
for(const c of ['rights_decision_id','rights_grant_id','rights_snapshot_json'])assert(itemCols.has(c),`order items missing ${c}`);

const at='2026-09-24T05:00:00.000Z';
db.prepare("insert into publishers(id,name,created_at,updated_at) values('pub','Rights House',?,?)").run(at,at);
db.prepare("insert into works(id,title,created_at,updated_at) values('work','Territorial Book',?,?)").run(at,at);
db.prepare("insert into editions(id,work_id,publisher_id,title,drm_status,release_status,created_at,updated_at) values('ed','work','pub','Territorial Book','none','available',?,?)").run(at,at);
db.prepare("insert into products(id,edition_id,sku,format,storefront_status,source_name,source_external_id,created_at,updated_at) values('ebook','ed','SKU-E','ebook','active','publisher','e1',?,?),('audio','ed','SKU-A','audiobook','active','publisher','a1',?,?)").run(at,at,at,at);
db.prepare("insert into digital_assets(id,edition_id,kind,drm_status,created_at,updated_at) values('asset-e','ed','epub','none',?,?),('asset-a','ed','audio','none',?,?)").run(at,at,at,at);
// 0016 seeds the global territory registry. Keep this legacy insert to prove aliases do not break old callers.
for(const [code,name] of [['US','United States'],['CA','Canada'],['UK','United Kingdom'],['AU','Australia']]) db.prepare('insert or ignore into territories(code,name) values(?,?)').run(code,name);
db.prepare("insert into rights_parties(id,display_name,party_type,status,created_at,updated_at) values('rp','Rights House','publisher','active',?,?)").run(at,at);
const ins=db.prepare(`insert into rights_grants(id,edition_id,rightsholder_id,rightsholder_party_id,territory_code,format,sales_channel,starts_at,ends_at,license_type,drm_requirement,subscription_permitted,library_permitted,decision,status,promotion_restrictions_json,contract_reference,source,notes,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const grant=(id,territory,format,channel='retail',decision='allow',drm='none',sub=0,lib=0,start=null,end=null)=>ins.run(id,'ed','pub','rp',territory,format,channel,start,end,'licensed',drm,sub,lib,decision,'active','{"discountsPermitted":false}','contract-1','test','',at,at);
grant('us-e','US','ebook'); grant('ca-e','CA','ebook'); grant('uk-deny','UK','ebook','retail','deny');
assert.equal(db.prepare("select count(*) n from rights_grant_audit where grant_id in ('us-e','ca-e','uk-deny') and action='insert'").get().n,3,'every legal grant insert must be audited');
db.prepare("update rights_grants set notes='amended' where id='ca-e'").run();
assert.equal(db.prepare("select count(*) n from rights_grant_audit where grant_id='ca-e' and action='update'").get().n,1,'grant edits must create append-only snapshots');
assert.throws(()=>db.prepare("delete from rights_grants where id='ca-e'").run(),/revoke or expire/i,'rights grants must be revoked/expired, never deleted');
assert.throws(()=>db.prepare("update rights_grant_audit set action='baseline' where grant_id='ca-e'").run(),/append-only/i,'grant audit must be append-only');
assert.throws(()=>db.prepare("insert into rights_grants(id,edition_id,rightsholder_party_id,territory_code,format,sales_channel,license_type,created_at) values('bad-party','ed','missing-party','US','ebook','retail','licensed',?)").run(at),/unknown rights party/i,'orphan rightsholders must be rejected');

const available=(product,territory)=>!!db.prepare('select 1 ok from retail_product_availability where product_id=? and territory_code=? limit 1').get(product,territory);
assert.equal(available('ebook','US'),true,'US ebook retail right should be available');
assert.equal(available('ebook','CA'),true,'Canada ebook retail right should be available');
assert.equal(available('ebook','UK'),false,'legacy UK storefront code must not be a sellable market');
assert.equal(available('ebook','GB'),false,'legacy UK deny must canonicalize to GB and block the canonical market');
assert.equal(available('ebook','AU'),false,'territory without a grant must fail closed');
assert.equal(available('audio','US'),false,'ebook right must never imply audiobook right');
assert.equal(db.prepare("select count(*) n from rights_grants where edition_id='ed' and territory_code in ('US','CA') and format='ebook' and (sales_channel='subscription' or subscription_permitted=1)").get().n,0,'retail right must not imply subscription');
assert.equal(db.prepare("select count(*) n from rights_grants where edition_id='ed' and territory_code in ('US','CA') and format='ebook' and (sales_channel='library' or library_permitted=1)").get().n,0,'retail right must not imply library distribution');
const channelAvailable=(product,territory,channel)=>!!db.prepare('select 1 ok from product_channel_availability where product_id=? and territory_code=? and sales_channel=? limit 1').get(product,territory,channel);
assert.equal(channelAvailable('ebook','CA','subscription'),false,'retail-only Canada grant must not leak into subscription');
assert.equal(channelAvailable('ebook','CA','library'),false,'retail-only Canada grant must not leak into library');
grant('ca-sub','CA','ebook','subscription');
grant('ca-lib','CA','ebook','library');
assert.equal(channelAvailable('ebook','CA','subscription'),true,'independent subscription grant should enable subscription only');
assert.equal(channelAvailable('ebook','CA','library'),true,'independent library grant should enable library only');
grant('ca-sub-deny','CA','ebook','subscription','deny');
assert.equal(channelAvailable('ebook','CA','subscription'),false,'channel-specific deny must override channel allow');
assert.equal(channelAvailable('ebook','CA','library'),true,'subscription deny must not revoke an independent library grant');

grant('us-a-lcp','US','audiobook','retail','allow','lcp');
assert.equal(available('audio','US'),false,'DRM mismatch must block availability');
db.prepare("update digital_assets set drm_status='lcp',updated_at=? where id='asset-a'").run(at);
assert.equal(available('audio','US'),true,'matching audiobook DRM should permit its independently licensed format');

grant('us-deny','US','ebook','retail','deny');
assert.equal(available('ebook','US'),false,'explicit deny must override allow');
grant('expired','AU','ebook','retail','allow','none',0,0,'2020-01-01T00:00:00Z','2021-01-01T00:00:00Z');
assert.equal(available('ebook','AU'),false,'expired grants must not sell');
db.prepare("insert into rights_decisions(id,product_id,edition_id,grant_id,territory_code,format,sales_channel,decision,reason_code,evaluated_at) values('decision-test','ebook','ed','uk-deny','UK','ebook','retail','deny','EXPLICIT_DENY',?)").run(at);
assert.throws(()=>db.prepare("update rights_decisions set reason_code='rewritten' where id='decision-test'").run(),/append-only/i,'rights decisions must be immutable evidence');

// Global territory registry and named system sets.
assert(db.prepare("select count(*) n from territories where iso_status='official' and is_sellable=1").get().n>=249,'official ISO market registry is incomplete');
assert.equal(db.prepare("select territory_code from territory_aliases where alias_code='UK'").get().territory_code,'GB','UK alias must canonicalize to GB');
assert.equal(db.prepare("select count(*) n from territory_set_members where set_id='rset_eu'").get().n,27,'EU system set must resolve to 27 markets');
assert.equal(db.prepare("select count(*) n from territory_set_members where set_id='rset_eea'").get().n,30,'EEA system set must resolve to 30 markets');
assert.equal(db.prepare("select count(*) n from territory_set_members where set_id='rset_anz'").get().n,2,'ANZ system set must resolve to AU/NZ');
assert.equal(db.prepare("select count(*) n from territory_set_members where set_id='rset_us_ca'").get().n,2,'US_CA system set must resolve to 2 markets');
assert.equal(db.prepare("select count(*) n from territory_set_members where set_id='rset_gb_ie'").get().n,2,'GB_IE system set must resolve to 2 markets');
assert(db.prepare("select count(*) n from territory_set_members where set_id='rset_world'").get().n>=249,'WORLD must contain every sellable market');
assert.equal(db.prepare("select count(*) n from territory_historical_successors where historical_entity_id='hist_su'").get().n,15,'Soviet Union must expand to 15 configured successor markets');
assert.equal(db.prepare("select count(*) n from territory_historical_entities where historical_code='CS'").get().n,2,'ambiguous historical CS code requires dated entity mappings');

// A contract-language-scoped multi-country grant proves runtime discovery uses the resolved snapshot,
// not the legacy single territory column.
db.prepare("insert into works(id,title,created_at,updated_at) values('work2','Language Scoped Book',?,?)").run(at,at);
db.prepare("insert into editions(id,work_id,publisher_id,title,drm_status,release_status,created_at,updated_at) values('ed2','work2','pub','Language Scoped Book','none','available',?,?)").run(at,at);
db.prepare("insert into products(id,edition_id,sku,format,storefront_status,source_name,source_external_id,created_at,updated_at) values('ebook2','ed2','SKU-E2','ebook','active','publisher','e2',?,?)").run(at,at);
db.prepare("insert into digital_assets(id,edition_id,kind,drm_status,created_at,updated_at) values('asset-e2','ed2','epub','none',?,?)").run(at,at);
db.prepare("insert into edition_languages(edition_id,language_code,kind) values('ed2','en','content')").run();
db.prepare("insert into rights_contracts(id,reference_code,name,rightsholder_party_id,status,effective_from,effective_to,language_match_mode,source,notes,created_at,updated_at) values('contract-en','CTR-EN','English Retail License','rp','active',null,null,'all','test','',?,?)").run(at,at);
db.prepare("insert into rights_contract_languages(id,contract_id,language_code,decision,format,sales_channel,created_at) values('contract-en-lang','contract-en','en','allow','ebook','retail',?)").run(at);
db.prepare(`insert into rights_grants(id,edition_id,rightsholder_id,rightsholder_party_id,territory_code,format,sales_channel,license_type,drm_requirement,subscription_permitted,library_permitted,decision,status,promotion_restrictions_json,contract_reference,source,notes,created_at,updated_at,contract_id,exclusivity,scope_summary)
values('multi-en','ed2','pub','rp','ZZ','ebook','retail','licensed','none',0,0,'allow','active','{}','CTR-EN','test','',?,?, 'contract-en','exclusive','WORLD excluding GB/AU')`).run(at,at);
for(const code of ['US','CA','FR']) db.prepare("insert into rights_grant_territories(grant_id,territory_code,resolved_from,snapshotted_at) values('multi-en',?,'test-snapshot',?)").run(code,at);
db.prepare("insert into rights_grant_territory_scopes(id,grant_id,effect,target_type,territory_set_id,position,created_at) values('multi-world','multi-en','include','set','rset_world',0,?)").run(at);
db.prepare("insert into rights_grant_territory_scopes(id,grant_id,effect,target_type,territory_code,position,created_at) values('multi-ex-gb','multi-en','exclude','territory','GB',1,?),('multi-ex-au','multi-en','exclude','territory','AU',2,?)").run(at,at);
db.prepare("insert into rights_grant_scope_snapshots(id,grant_id,scope_json,territories_json,recorded_at) values('snap-multi-en','multi-en','{\"mode\":\"worldwide\",\"exclude\":[\"GB\",\"AU\"]}','[\"CA\",\"FR\",\"US\"]',?)").run(at);
assert.equal(channelAvailable('ebook2','US','retail'),true,'snapshotted multi-territory grant must enable US');
assert.equal(channelAvailable('ebook2','FR','retail'),true,'snapshotted multi-territory grant must enable France');
assert.equal(channelAvailable('ebook2','GB','retail'),false,'country omitted/excluded from the snapshot must fail closed');
assert.equal(channelAvailable('ebook2','AU','retail'),false,'worldwide exclusion must remain unavailable');
// Change the reusable WORLD template. The executed grant snapshot must not change.
db.prepare("delete from territory_set_members where set_id='rset_world' and territory_code='FR'").run();
assert.equal(channelAvailable('ebook2','FR','retail'),true,'editing a reusable territory set must not rewrite an existing grant snapshot');
// Language rights are contractual, not metadata-only.
db.prepare("delete from edition_languages where edition_id='ed2'").run();
db.prepare("insert into edition_languages(edition_id,language_code,kind) values('ed2','fr','content')").run();
assert.equal(channelAvailable('ebook2','US','retail'),false,'English-only contract must block a French content edition');
db.prepare("delete from edition_languages where edition_id='ed2'").run();
db.prepare("insert into edition_languages(edition_id,language_code,kind) values('ed2','en','content')").run();
assert.equal(channelAvailable('ebook2','US','retail'),true,'restoring licensed language must restore eligibility');
assert.throws(()=>db.prepare("update rights_grant_scope_snapshots set territories_json='[]' where id='snap-multi-en'").run(),/append-only/i,'grant territory snapshots must be immutable');
// Configuration audits are also legal evidence.
db.prepare("insert into rights_configuration_audit(id,entity_type,entity_id,action,snapshot_json,recorded_at) values('cfg-test','territory_set','custom','create','{}',?)").run(at);
assert.throws(()=>db.prepare("delete from rights_configuration_audit where id='cfg-test'").run(),/append-only/i,'configuration audit must be immutable');

const rights=fs.readFileSync('src/features/fore/rights.server.ts','utf8');
const api=fs.readFileSync('src/features/fore/api.server.ts','utf8');
const localization=fs.readFileSync('src/features/fore/localization.server.ts','utf8');
const commerce=fs.readFileSync('src/features/fore/commerce.server.ts','utf8');
const search=fs.readFileSync('src/features/fore/search.server.ts','utf8');
const staff=fs.readFileSync('src/features/fore/StorefrontAdmin.tsx','utf8');
const audio=fs.readFileSync('src/features/fore/audio.server.ts','utf8');
for(const needle of ['resolveProductRights','EXPLICIT_DENY','DRM_REQUIREMENT_UNMET','promotionPermitted','rights_decisions','salesChannel','EXCLUSIVE_LICENSE_OVERLAP','LANGUAGE_RIGHTS_UNAVAILABLE','territoryExpansionPreview','rights_grant_territories','territory_historical_successors','scopeSummary'])assert(rights.includes(needle),`rights engine missing ${needle}`);
for(const needle of ['public-domain-acquisition','full-file-delivery','/admin/commerce/rights-grant','/admin/commerce/rights-contract','/admin/commerce/territory-set','/admin/commerce/territory-expand','storefront/context'])assert(api.includes(needle),`API enforcement missing ${needle}`);
for(const needle of ['cf-ipcountry','rightsCountry','country_source','billing','account'])assert(localization.toLowerCase().includes(needle.toLowerCase()),`storefront rights context missing ${needle}`);
for(const needle of ['rightsSnapshot','rightsGrantId','rights_decision_id','promotionPermitted','billingAddress.country','contractId','scopeSummary','languageRights','exclusivity'])assert(commerce.includes(needle),`checkout audit/enforcement missing ${needle}`);
assert(search.includes('retail_product_availability'),'search does not use retail rights projection');
assert(search.includes('product_channel_availability'),'subscription/library search does not use unified rights projection');
assert(search.includes('contextualizeChannelEligibility'),'catalog channel badges are not territory-contextualized');
for(const needle of ['Rights, contracts & territorial availability','License conflicts','Territory set','Expand scope','Rights contract']) assert(staff.includes(needle),`operator rights console missing ${needle}`);
assert(audio.includes('storefrontTerritory !== "US"'),'legacy U.S.-only audiobook feed is not territory-gated');
console.log(`commercial rights regression checks passed (${migrations.length} migrations)`);
