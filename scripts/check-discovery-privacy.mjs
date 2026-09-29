import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const root=process.cwd(), db=new DatabaseSync(':memory:');
const migrations=fs.readdirSync(path.join(root,'drizzle')).filter(x=>/^\d{4}_.+\.sql$/.test(x)).sort();
for(const name of migrations) db.exec(fs.readFileSync(path.join(root,'drizzle',name),'utf8').replaceAll('--> statement-breakpoint',';'));
db.exec('PRAGMA foreign_keys=ON');
assert.ok(migrations.length>=38,'expected catalog identity migration chain');
assert.ok(migrations.includes('0037_catalog_identity_discovery_seo.sql'),'catalog identity migration missing');

const tables=new Set(db.prepare("select name from sqlite_master where type='table'").all().map(x=>x.name));
for(const name of ['catalog_entity_slugs','work_relationships','personal_export_events']) assert(tables.has(name),`missing ${name}`);
const seriesCols=new Set(db.prepare('pragma table_info(series)').all().map(x=>x.name));
for(const name of ['slug','series_type','hero_image_url','status']) assert(seriesCols.has(name),`series missing ${name}`);
const membershipCols=new Set(db.prepare('pragma table_info(series_memberships)').all().map(x=>x.name));
for(const name of ['relationship','reading_order','display_order']) assert(membershipCols.has(name),`series_memberships missing ${name}`);
const exportCols=new Set(db.prepare('pragma table_info(personal_export_events)').all().map(x=>x.name));
for(const name of ['id','user_id','product_id','external_book_id','export_kind','requested_at']) assert(exportCols.has(name),`export audit missing ${name}`);
for(const forbidden of ['note','quote','word','payload','content','epub','archive']) assert(!exportCols.has(forbidden),`export audit must not retain private payload field ${forbidden}`);

const at='2026-09-24T06:00:00.000Z';
db.prepare("insert into publishers(id,name,website,created_at,updated_at) values(?,?,?,?,?)").run('pub_discovery','Dragon House','',at,at);
db.prepare("insert into imprints(id,publisher_id,name,created_at,updated_at) values(?,?,?,?,?)").run('imp_discovery','pub_discovery','Dragon Orbit',at,at);
db.prepare("insert into contributors(id,name,sort_name,bio,created_at,updated_at) values(?,?,?,?,?,?)").run('author_discovery','Jordan Example','Example, Jordan','',at,at);
db.prepare("insert into series(id,name,description,publisher_id,created_at,updated_at) values(?,?,?,?,?,?)").run('series_discovery','The Stormlight Archive','Ordered epic fantasy','pub_discovery',at,at);
assert.equal(db.prepare("select slug from series where id='series_discovery'").get().slug,'the-stormlight-archive','series should receive a human-readable stable slug');
assert.equal(db.prepare("select slug from publishers where id='pub_discovery'").get().slug,'dragon-house');
assert.equal(db.prepare("select slug from imprints where id='imp_discovery'").get().slug,'dragon-orbit');
assert.equal(db.prepare("select slug from contributors where id='author_discovery'").get().slug,'jordan-example');
assert.equal(db.prepare("select entity_id from catalog_entity_slugs where entity_type='series' and slug='the-stormlight-archive' and canonical=1").get().entity_id,'series_discovery');

db.prepare("update series set slug='stormlight-archive',updated_at=? where id='series_discovery'").run(at);
assert.equal(db.prepare("select canonical from catalog_entity_slugs where entity_type='series' and slug='the-stormlight-archive'").get().canonical,0,'old public slug should remain a noncanonical alias');
assert.equal(db.prepare("select canonical from catalog_entity_slugs where entity_type='series' and slug='stormlight-archive'").get().canonical,1,'new slug should become canonical');

db.prepare("insert into series(id,name,description,publisher_id,created_at,updated_at) values(?,?,?,?,?,?)").run('series_collision','The Stormlight Archive','A separate same-name series','pub_discovery',at,at);
const collisionSlug=db.prepare("select slug from series where id='series_collision'").get().slug;
assert.notEqual(collisionSlug,'the-stormlight-archive','same-name entities must not share a route slug');
assert.match(collisionSlug,/^the-stormlight-archive-/);

for(const [i,relationship,order] of [[1,'main',1],[2,'prequel',0.5],[3,'novella',1.5],[4,'related',null]]){
  const wid=`work_${i}`, eid=`edition_${i}`;
  db.prepare("insert into works(id,title,created_at,updated_at) values(?,?,?,?)").run(wid,`Series Work ${i}`,at,at);
  db.prepare("insert into editions(id,work_id,publisher_id,imprint_id,title,release_status,created_at,updated_at) values(?,?,?,?,?,'available',?,?)").run(eid,wid,'pub_discovery','imp_discovery',`Series Work ${i}`,at,at);
  db.prepare("insert into series_memberships(series_id,edition_id,position,label,relationship,reading_order,display_order) values(?,?,?,?,?,?,?)").run('series_discovery',eid,order,'',relationship,order,i);
}
assert.deepEqual(db.prepare("select relationship from series_memberships where series_id='series_discovery' order by display_order").all().map(x=>x.relationship),['main','prequel','novella','related']);
assert.throws(()=>db.prepare("update series_memberships set relationship='random' where series_id='series_discovery'").run(),/CHECK constraint failed/i,'invalid series relationships must be rejected');

const epub=fs.readFileSync('src/features/fore/epub.ts','utf8');
const api=fs.readFileSync('src/features/fore/api.server.ts','utf8');
const discovery=fs.readFileSync('src/features/fore/discovery.server.ts','utf8');
const book=fs.readFileSync('src/features/fore/Book.tsx','utf8');
const collections=fs.readFileSync('src/features/fore/Collections.tsx','utf8');
const audioClient=fs.readFileSync('src/features/fore/audio-client.ts','utf8');
const seriesPage=fs.readFileSync('src/features/fore/Series.tsx','utf8');
const taxonomy=fs.readFileSync('src/features/fore/taxonomy.server.ts','utf8');
const routes=fs.readFileSync('src/routeTree.gen.ts','utf8');

function between(text,start,end){const a=text.indexOf(start),b=text.indexOf(end,a+start.length);assert(a>=0&&b>a,`could not isolate ${start}`);return text.slice(a,b);}
const contentOnly=between(epub,'export async function downloadBook','/** Personal-data export');
const dataOnly=between(epub,'export async function exportReadingData','/** Explicit private backup');
const backup=between(epub,'export async function downloadCoveBackup','export async function saveEpubOffline');
assert.match(contentOnly,/downloadableEpubBytes/); assert.doesNotMatch(contentOnly,/exports\/reading-data|annotations|definitions|reading-data\.json/,'book download must not fetch personal reading data');
assert.match(dataOnly,/exports\/reading-data/); assert.doesNotMatch(dataOnly,/epubBytes|book\/book\.epub/,'reading-data export must never fetch/package book bytes');
assert.match(dataOnly,/annotations\.json/); assert.match(dataOnly,/definitions\.json/); assert.match(dataOnly,/history\.json/);
assert.match(backup,/downloadableEpubBytes/); assert.match(backup,/purpose=private-backup/); assert.match(backup,/README-PRIVATE\.txt/); assert.match(backup,/containsPersonalData:true/);
assert.match(book,/Download book/); assert.match(book,/Export reading data/); assert.match(book,/Cove backup package/); assert.match(book,/combines the EPUB and your personal reading data/i); assert.match(book,/Publisher license: Cove reader only/,'personal reading-data export must remain visible when content download is disallowed');
assert.match(collections,/Download book/); assert.match(collections,/Export reading data/); assert.match(collections,/Cove backup package/);
assert.match(api,/path\.startsWith\("\/exports\/reading-data\/"\)/); assert.match(api,/const user\s*=\s*requiredUser\(request\)/,'personal export route must be behind required-user auth'); assert.match(api,/bits\[3\] === "download" && bits\[4\] === "epub"/,'book export must use a dedicated download endpoint'); assert.match(api,/if \(!asset\.downloadable\)/,'dedicated EPUB download endpoint must enforce publisher downloadability'); assert.match(api,/X-Cove-Export-Class": "book-content-only"/,'book export response should identify its privacy/content class');
assert.match(discovery,/personal_export_events/); assert.match(discovery,/containsBookContent:false/); const readingExportServer=discovery.slice(discovery.indexOf('export async function readingDataExport')); assert.doesNotMatch(readingExportServer,/digital_assets|asset_versions|source_url/i,'reading data export must not query book-asset tables');
const audioPackage=audioClient.slice(audioClient.indexOf('export async function downloadAudioPackage'));
assert.match(audioPackage,/fore-media-package/); assert.match(audioPackage,/containsPersonalData: false/); assert.match(audioPackage,/\/download\/epub/,'text+audio package must use the export-gated EPUB endpoint');
assert.doesNotMatch(audioPackage,/annotations\.json|definitions\.json|reading\.json|data\.annotations|data\.definitions|data\.library/,'media packages must never contain personal reading data');

for(const route of ['/edition/$id','/series/$id','/author/$id','/publisher/$id','/imprint/$id']) assert.ok(routes.includes(`'${route}'`),`missing first-class ${route} route`);
assert.match(seriesPage,/NEXT UNREAD INSTALLMENT/); assert.match(seriesPage,/Prequels/); assert.match(seriesPage,/Novellas/); assert.match(seriesPage,/Related works/); assert.match(seriesPage,/wishlist/); assert.match(seriesPage,/subscriptionAvailable/); assert.match(seriesPage,/Add series to cart/);
assert.match(discovery,/entitlements/,'series ownership must consult durable entitlements');
assert.match(discovery,/main\.length<=25/,'series bundle eligibility must cap main-title count');
assert.match(discovery,/uniqueWorks\.size===main\.length/,'series bundle must reject duplicate-work editions');
assert.match(taxonomy,/resolveEntityId\(db,"author"/); assert.match(taxonomy,/resolveEntityId\(db,"publisher"/); assert.match(taxonomy,/resolveEntityId\(db,"imprint"/); assert.match(taxonomy,/resolveEntityId\(db,"series"/); assert.match(taxonomy,/redirectTo:path!==canonical\?canonical:undefined/,'legacy entity IDs/slugs should canonicalize to stable public routes'); assert.match(taxonomy,/seriesRows/,'entity pages should expose related series discovery'); assert.match(collections,/e\.book\.downloadable===false/,'library exports must not present combined/content export as available for reader-only editions');

console.log(`Discovery/privacy regression checks passed across ${migrations.length} migrations: content/personal-data separation, private-backup warning/audit, stable entity slugs, first-class editions/entities, structured series relationships, durable ownership, next-unread and atomic series-cart foundations.`);
