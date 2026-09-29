import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const root=process.cwd(),db=new DatabaseSync(':memory:');
const migrations=fs.readdirSync(path.join(root,'drizzle')).filter(x=>/^\d{4}_.+\.sql$/.test(x)).sort();
for(const name of migrations) db.exec(fs.readFileSync(path.join(root,'drizzle',name),'utf8').replaceAll('--> statement-breakpoint',';'));
db.exec('PRAGMA foreign_keys=ON');

const tables=new Set(db.prepare("select name from sqlite_master where type='table'").all().map(x=>x.name));
for(const t of ['gutenberg_sources','gutenberg_source_states','gutenberg_rights_evidence','gutenberg_ingest_runs']) assert(tables.has(t),`missing ${t}`);
const cacheCols=new Set(db.prepare('pragma table_info(gutenberg_source_cache)').all().map(x=>x.name));
for(const c of ['source_id','source_item_id','source_project','source_license_url','rights_status','rights_territories_json','rights_evidence_url','rights_checked_at','rights_evidence_id','commercial_use_status','trademark_cleanup_required','canonicalization_version','source_metadata_json','content_hash']) assert(cacheCols.has(c),`source cache missing ${c}`);
assert(new Set(db.prepare('pragma table_info(rights_grants)').all().map(x=>x.name)).has('source_evidence_id'),'rights grant missing source evidence pointer');
assert(new Set(db.prepare('pragma table_info(rights_decisions)').all().map(x=>x.name)).has('source_evidence_id'),'rights decision missing source evidence pointer');

const sources=db.prepare('select id,default_territory_code,jurisdiction_mode,feed_kind,enabled from gutenberg_sources order by priority').all();
assert.deepEqual(sources.map(x=>x.id),['pg_us','pg_ca','pg_au','pg_eu']);
assert.equal(sources.find(x=>x.id==='pg_us').default_territory_code,'US');
assert.equal(sources.find(x=>x.id==='pg_ca').default_territory_code,'CA');
assert.equal(sources.find(x=>x.id==='pg_au').default_territory_code,'AU');
assert.equal(sources.find(x=>x.id==='pg_eu').default_territory_code,null,'Europe must never receive a blanket default territory');
assert.equal(sources.find(x=>x.id==='pg_eu').jurisdiction_mode,'per-item-territories');
assert.equal(sources.find(x=>x.id==='pg_eu').feed_kind,'rights-manifest');
assert.equal(db.prepare('select count(*) n from gutenberg_source_states').get().n,4,'each source needs independent backoff/health state');
const stateCols=new Set(db.prepare('pragma table_info(gutenberg_source_states)').all().map(x=>x.name));
for(const c of ['cursor','cycle_started_at','etag','last_modified','content_hash','lease_token','lease_until']) assert(stateCols.has(c),`source state missing ${c}`);
assert.equal(sources.find(x=>x.id==='pg_au').feed_kind,'html-catalog','Australia should use the current HTML author catalog');

const at='2026-09-24T06:00:00.000Z';
function seedEdition(tag,sourceId,sourceItem,territories){
  const external=`${tag}_book`,work=`wrk_${tag}`,ed=`ed_${tag}`,prd=`prd_${tag}`;
  db.prepare(`insert into gutenberg_source_cache(id,title,authors_json,summary,subjects_json,bookshelves_json,languages_json,formats_json,download_count,copyright,source_url,source_updated_at,first_ingested_at,updated_at,last_seen_at,ingest_status,ingest_attempts,last_error,epub_status,epub_attempts,epub_next_attempt_at,epub_last_error,source_id,source_item_id,source_project,source_license_url,rights_status,rights_territories_json,rights_evidence_url,commercial_use_status,trademark_cleanup_required,canonicalization_version,source_metadata_json,content_hash)
    values(?,?,'[]','','[]','[]','["en"]','{"application/epub+zip":"https://example.invalid/book.epub"}',0,0,?,?,?, ?,?,'active',0,'','completed',0,'','',?,?,?,?, 'public-domain',?,?, 'approved',1,'regional-gutenberg-v1','{}','hash')`)
    .run(external,`${tag} title`,`https://example.invalid/${sourceItem}`,at,at,at,at,sourceId,sourceItem,sourceId,`https://example.invalid/license`,JSON.stringify(territories),`https://example.invalid/evidence/${sourceItem}`);
  db.prepare('insert into works(id,title,created_at,updated_at) values(?,?,?,?)').run(work,`${tag} title`,at,at);
  db.prepare("insert into editions(id,work_id,title,drm_status,release_status,created_at,updated_at) values(?,?,?,'none','available',?,?)").run(ed,work,`${tag} title`,at,at);
  db.prepare("insert into products(id,edition_id,sku,format,storefront_status,source_name,source_external_id,created_at,updated_at) values(?,?,?,'ebook','active','gutenberg',?,?,?)").run(prd,ed,`SKU-${tag}`,external,at,at);
  db.prepare("insert into digital_assets(id,edition_id,kind,drm_status,created_at,updated_at) values(?,?,'epub','none',?,?)").run(`asset_${tag}`,ed,at,at);
  return {external,ed,prd};
}
function evidence(cache,source,item,territory){
  const id=`ev_${source}_${territory}_${item}`;
  db.prepare(`insert into gutenberg_rights_evidence(id,source_id,cache_id,source_item_id,determination,territory_code,evidence_url,evidence_type,evidence_hash,parser_version,status,checked_at,created_at)
    values(?,?,?,?, 'public-domain',?,'https://example.invalid/evidence','source-catalog','sha256','v1','approved',?,?)`).run(id,source,cache,item,territory,at,at);
  return id;
}
function grant(id,ed,territory,evidenceId,source){
  db.prepare(`insert into rights_grants(id,edition_id,territory_code,format,sales_channel,license_type,drm_requirement,decision,status,source,source_evidence_id,created_at,updated_at)
    values(?, ?,?,'ebook','retail','public-domain','none','allow','active',?,?,?,?)`).run(id,ed,territory,source,evidenceId,at,at);
}
const ca=seedEdition('ca','pg_ca','ca-1',['CA']); const caEv=evidence(ca.external,'pg_ca','ca-1','CA'); grant('grant-ca',ca.ed,'CA',caEv,'gutenberg-pg_ca-public-domain');
const au=seedEdition('au','pg_au','au-1',['AU']); const auEv=evidence(au.external,'pg_au','au-1','AU'); grant('grant-au',au.ed,'AU',auEv,'gutenberg-pg_au-public-domain');
const eu=seedEdition('eu','pg_eu','eu-1',['FR','DE']); const frEv=evidence(eu.external,'pg_eu','eu-1','FR'),deEv=evidence(eu.external,'pg_eu','eu-1','DE'); grant('grant-fr',eu.ed,'FR',frEv,'gutenberg-pg_eu-public-domain'); grant('grant-de',eu.ed,'DE',deEv,'gutenberg-pg_eu-public-domain');
const available=(product,territory)=>!!db.prepare("select 1 ok from product_channel_availability where product_id=? and territory_code=? and sales_channel='retail'").get(product,territory);
assert.equal(available(ca.prd,'CA'),true); assert.equal(available(ca.prd,'US'),false); assert.equal(available(ca.prd,'AU'),false);
assert.equal(available(au.prd,'AU'),true); assert.equal(available(au.prd,'CA'),false); assert.equal(available(au.prd,'NZ'),false);
assert.equal(available(eu.prd,'FR'),true); assert.equal(available(eu.prd,'DE'),true); assert.equal(available(eu.prd,'ES'),false,'European evidence must not leak to neighboring EU states');
assert.equal(available(eu.prd,'GB'),false,'European source must remain exact-country scoped');

assert.throws(()=>db.prepare(`insert into rights_grants(id,edition_id,territory_code,format,sales_channel,license_type,decision,status,source,created_at,updated_at)
  values('no-evidence',?,'CA','ebook','retail','public-domain','allow','active','gutenberg-pg_ca-public-domain',?,?)`).run(ca.ed,at,at),/require source evidence/i);
assert.throws(()=>db.prepare(`insert into rights_grants(id,edition_id,territory_code,format,sales_channel,license_type,decision,status,source,source_evidence_id,created_at,updated_at)
  values('wrong-evidence',?,'US','ebook','retail','public-domain','allow','active','gutenberg-pg_ca-public-domain',?,?,?)`).run(ca.ed,caEv,at,at),/does not match approved source evidence/i);
assert.throws(()=>db.prepare(`insert into rights_grants(id,edition_id,territory_code,format,sales_channel,license_type,decision,status,source,source_evidence_id,created_at,updated_at)
  values('wrong-source',?,'CA','ebook','retail','public-domain','allow','active','gutenberg-pg_au-public-domain',?,?,?)`).run(ca.ed,caEv,at,at),/does not match approved source evidence/i);
assert.throws(()=>db.prepare(`insert into rights_grants(id,edition_id,territory_code,format,sales_channel,license_type,decision,status,source,source_evidence_id,created_at,updated_at)
  values('wrong-edition',?,'CA','ebook','retail','public-domain','allow','active','gutenberg-pg_ca-public-domain',?,?,?)`).run(au.ed,caEv,at,at),/does not match approved source evidence/i);
const grantAudit=db.prepare("select json_extract(snapshot_json,'$.sourceEvidenceId') evidence from rights_grant_audit where grant_id='grant-ca' order by recorded_at desc limit 1").get();
assert.equal(grantAudit.evidence,caEv,'grant audit must snapshot the exact source evidence id');
assert.throws(()=>db.prepare("update gutenberg_rights_evidence set status='rejected' where id=?").run(caEv),/append-only/i);
assert.throws(()=>db.prepare('delete from gutenberg_rights_evidence where id=?').run(caEv),/append-only/i);
db.prepare("update gutenberg_source_cache set rights_status='pending' where id=?").run(ca.external);
assert.equal(db.prepare("select status from rights_grants where id='grant-ca'").get().status,'suspended','losing regional verification must suspend source-derived rights');
assert.equal(available(ca.prd,'CA'),false,'a regional item must fail closed immediately when source verification is lost');

const source=fs.readFileSync(path.join(root,'src/features/fore/gutenberg-federation.server.ts'),'utf8');
for(const needle of ['parseCanadaCatalog','parseAustraliaHtmlCatalog','plusfifty-a-m.html','plusfifty-n-z.html','parseEuropeManifest','canonicalizeRegionalEpub','canonicalizeRegionalDocument','regional-gutenberg-v2','regional-gutenberg-html-v1','blanket','trustedRegionalAssetUrl','copyrighted/permission-only']) assert(source.includes(needle),`federation source missing ${needle}`);
const api=fs.readFileSync(path.join(root,'src/features/fore/api.server.ts'),'utf8');
assert(api.includes("This regional public-domain edition must be served from Cove's verified canonical cache"),'regional customer delivery must never bypass canonical cache');
assert(api.includes('gutenberg_ingest_runs'),'ingestion must create source audit records');
assert(api.includes('snapshotHash: result.bodyHash'),'multi-document catalogs must hash-dedupe unchanged snapshots');
assert(api.includes('ROW_NUMBER() OVER(PARTITION BY source_id'),'asset queue must fair-share work across sources');
assert(api.includes('canonicalAssetSource'),'regional queue must prefer EPUB but support trusted HTML normalization');
assert(api.includes('sourceFormat: sourceAsset.mimeType'),'canonical object metadata must preserve the upstream format used');
assert(api.includes("rights_status='public-domain',commercial_use_status='approved'"),'rights must activate only after asset verification');

console.log(`regional Gutenberg federation regression checks passed (${migrations.length} migrations)`);
