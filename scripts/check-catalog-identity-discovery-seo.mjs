import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const root=process.cwd();
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const migrations=fs.readdirSync(path.join(root,'drizzle')).filter(x=>/^\d+.*\.sql$/.test(x)).sort();
const catalogMigration='0037_catalog_identity_discovery_seo.sql';
const catalogMigrationIndex=migrations.indexOf(catalogMigration);
assert.ok(catalogMigrationIndex>=0,'catalog identity migration missing');
assert.ok(migrations.length>=38,'expected catalog identity migration chain');

// Exercise the migration against an already-populated Gutenberg-shaped catalog, not only an empty DB.
const db=new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
for(const file of migrations.slice(0,catalogMigrationIndex)) db.exec(read(`drizzle/${file}`));
const at='2026-09-25T00:00:00.000Z';
const source=db.prepare("SELECT id FROM gutenberg_sources WHERE id='pg_us' LIMIT 1").get();
assert.ok(source,'Project Gutenberg source seed must exist before identity migration');
db.prepare(`INSERT INTO gutenberg_source_cache(id,title,authors_json,summary,subjects_json,bookshelves_json,languages_json,formats_json,download_count,copyright,source_url,source_updated_at,first_ingested_at,updated_at,last_seen_at,source_id,source_item_id)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('1342','Pride and Prejudice','[{"name":"Austen, Jane"}]','A classic novel.','["Courtship -- Fiction","England -- Fiction"]','["Best Books Ever Listings"]','["en"]','{"application/epub+zip":"https://www.gutenberg.org/ebooks/1342.epub3.images"}',1000,0,'https://www.gutenberg.org/ebooks/1342',at,at,at,at,'pg_us','1342');
db.prepare("INSERT INTO works(id,title,description,created_at,updated_at,work_type,canonical_status) VALUES(?,?,?,?,?,'public_domain','canonical')").run('wrk_gutenberg_1342','Pride and Prejudice','A classic novel.',at,at);
db.prepare("INSERT INTO editions(id,work_id,title,language,edition_type,canonical_public_domain,created_at,updated_at) VALUES(?,?,?,'en','canonical_public_domain',1,?,?)").run('ed_gutenberg_1342','wrk_gutenberg_1342','Pride and Prejudice',at,at);
db.prepare("INSERT INTO products(id,edition_id,sku,format,source_name,source_external_id,created_at,updated_at) VALUES(?,?,?,'ebook','gutenberg','1342',?,?)").run('prd_gutenberg_1342','ed_gutenberg_1342','GUTENBERG-US-1342',at,at);
db.prepare("INSERT INTO contributors(id,name,sort_name,created_at,updated_at) VALUES(?,?,?,?,?)").run('con_jane','Austen, Jane','Austen, Jane',at,at);
db.prepare("INSERT INTO edition_contributors(edition_id,contributor_id,role,position) VALUES(?,?, 'author',0)").run('ed_gutenberg_1342','con_jane');
db.prepare("INSERT INTO edition_languages(edition_id,language_code,kind) VALUES(?,?,'content')").run('ed_gutenberg_1342','en');
db.prepare("INSERT INTO categories(id,scheme,name) VALUES('cat_subject_1','gutenberg-subject','Courtship -- Fiction')").run();
db.prepare("INSERT INTO categories(id,scheme,name) VALUES('cat_shelf_1','gutenberg-bookshelf','Best Books Ever Listings')").run();
db.prepare("INSERT INTO edition_categories(edition_id,category_id,position) VALUES('ed_gutenberg_1342','cat_subject_1',0)").run();
db.prepare("INSERT INTO edition_categories(edition_id,category_id,position) VALUES('ed_gutenberg_1342','cat_shelf_1',1000)").run();
db.prepare(`INSERT INTO catalog_search_documents(product_id,external_book_id,title,contributors_text,subjects_text,bookshelves_text,categories_text,languages_text,description,download_count,first_ingested_at,updated_at)
 VALUES('prd_gutenberg_1342','1342','Pride and Prejudice','Austen, Jane','Courtship -- Fiction','Best Books Ever Listings','Courtship -- Fiction | Best Books Ever Listings','en','A classic novel.',1000,?,?)`).run(at,at);

db.exec(read(`drizzle/${catalogMigration}`));
assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);

const ids=db.prepare("SELECT w.public_id work_public,e.public_id edition_public,p.public_id product_public FROM works w JOIN editions e ON e.work_id=w.id JOIN products p ON p.edition_id=e.id WHERE p.id='prd_gutenberg_1342'").get();
assert.match(ids.work_public,/^wrk_[a-f0-9]{32}$/);
assert.match(ids.edition_public,/^edn_[a-f0-9]{32}$/);
assert.match(ids.product_public,/^prd_[a-f0-9]{32}$/);
for(const [type,value] of [['work',ids.work_public],['edition',ids.edition_public],['product',ids.product_public]]){
  const row=db.prepare("SELECT canonical,alias_kind FROM catalog_public_aliases WHERE entity_type=? AND alias=?").get(type,value);
  assert.equal(row?.canonical,1);assert.equal(row?.alias_kind,'fore-public-id');
}
assert.equal(db.prepare("SELECT entity_id FROM catalog_public_aliases WHERE entity_type='product' AND alias='1342'").get().entity_id,'prd_gutenberg_1342');
for(const type of ['work','edition','product']) assert.equal(db.prepare("SELECT value FROM external_identifiers WHERE entity_type=? AND scheme='gutenberg'").get(type).value,'1342');
assert.equal(db.prepare("SELECT COUNT(*) n FROM categories WHERE scheme='gutenberg-subject'").get().n,0,'subjects must no longer masquerade as retail categories');
assert.equal(db.prepare("SELECT COUNT(*) n FROM edition_subjects es JOIN subjects s ON s.id=es.subject_id WHERE es.edition_id='ed_gutenberg_1342' AND s.scheme='gutenberg'").get().n,1);
assert.equal(db.prepare("SELECT COUNT(*) n FROM edition_categories ec JOIN categories c ON c.id=ec.category_id WHERE ec.edition_id='ed_gutenberg_1342' AND c.scheme='gutenberg-bookshelf'").get().n,1);
assert.equal(db.prepare("SELECT COUNT(*) n FROM work_contributors WHERE work_id='wrk_gutenberg_1342' AND contributor_id='con_jane' AND role='author'").get().n,1);
assert.equal(db.prepare("SELECT direction FROM languages WHERE code='en'").get().direction,'ltr');
const search=db.prepare("SELECT subjects_text,categories_text FROM catalog_search_documents WHERE product_id='prd_gutenberg_1342'").get();
assert.match(search.subjects_text,/Courtship/);assert.doesNotMatch(search.categories_text,/Courtship/);assert.match(search.categories_text,/Best Books/);

// New rows created after the migration must also get opaque IDs and canonical aliases automatically.
db.prepare("INSERT INTO works(id,title,created_at,updated_at) VALUES('internal_work_2','Future Work',?,?)").run(at,at);
db.prepare("INSERT INTO editions(id,work_id,title,created_at,updated_at) VALUES('internal_edition_2','internal_work_2','Future Edition',?,?)").run(at,at);
db.prepare("INSERT INTO products(id,edition_id,sku,format,source_name,source_external_id,created_at,updated_at) VALUES('internal_product_2','internal_edition_2','SKU-2','ebook','publisher-api','partner-42',?,?)").run(at,at);
const fresh=db.prepare("SELECT w.public_id w,e.public_id e,p.public_id p FROM works w JOIN editions e ON e.work_id=w.id JOIN products p ON p.edition_id=e.id WHERE p.id='internal_product_2'").get();
assert.match(fresh.w,/^wrk_[a-f0-9]{32}$/);assert.match(fresh.e,/^edn_[a-f0-9]{32}$/);assert.match(fresh.p,/^prd_[a-f0-9]{32}$/);
assert.equal(db.prepare("SELECT COUNT(*) n FROM catalog_public_aliases WHERE entity_type='product' AND alias=? AND canonical=1").get(fresh.p).n,1);
assert.equal(db.prepare("SELECT COUNT(*) n FROM catalog_public_aliases WHERE entity_type='product' AND alias='partner-42'").get().n,0,'ambiguous publisher source IDs must not become global aliases');
assert.throws(()=>db.prepare("UPDATE products SET public_id='prd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE id='internal_product_2'").run(),/immutable/i);

const catalog=read('src/features/fore/catalog-model.server.ts');
for(const token of ['id: row.product_public_id || row.product_id','sourceExternalId: row.source_external_id','work_contributors','edition_subjects','externalIdentifiers']) assert.ok(catalog.includes(token),`catalog model missing ${token}`);
assert.ok(catalog.includes("INSERT OR IGNORE INTO work_contributors"),'new Gutenberg ingests must normalize work authorship');
assert.ok(catalog.includes("INSERT OR IGNORE INTO subjects"),'new Gutenberg ingests must normalize subjects');
assert.ok(catalog.includes("c.source_id='pg_us'"),'generic Gutenberg identifiers must be restricted to the canonical US source');
assert.doesNotMatch(catalog,/gutenberg-subject[^\n]*edition_categories/,'Gutenberg subjects must not be reintroduced as category relations');

const service=read('src/features/fore/service.ts');
assert.match(service,/prd_\[a-f0-9\]\{32\}/,'public product IDs must pass route validation');
const searchSrc=read('src/features/fore/search.server.ts');
for(const token of ['publicProductId','subjects: string[]','edition_subjects','SEARCH_SETTINGS_VERSION = 9']) assert.ok(searchSrc.includes(token),`search missing ${token}`);
assert.ok(searchSrc.includes('bookId: String(h.publicProductId || h.externalBookId)'),'search suggestions must navigate with Cove product IDs');

const client=read('src/features/fore/client.ts');
assert.ok(client.includes('Canonical Cove public product identifier'));
assert.ok(client.includes('book.publicProductId ? "/books/"'));
const store=read('src/features/fore/Store.tsx');
assert.doesNotMatch(store,/The Cove Edit/,'Cove Edit content/behavior must come from CMS data, not React literals');
const merch=read('src/features/fore/merchandising.server.ts');
for(const token of ['merch_slots','merch_collections','merch_placements']) assert.ok(merch.includes(token),`merchandising CMS missing ${token}`);
const admin=read('src/features/fore/StorefrontAdmin.tsx');
assert.ok(admin.includes('Merchandising')||admin.includes('merch'),'internal merchandising admin surface is required');

const seo=read('src/features/fore/seo-loader.ts');
for(const token of ['loadBookSeo','loadAuthorSeo','loadCategorySeo','loadWorkSeo','loadEditionSeo','authorLabel?` by ${authorLabel}`']) assert.ok(seo.includes(token),`SEO loader missing ${token}`);
const sitemap=read('src/features/fore/seo.server.ts');
for(const token of ['/books/${encodeURIComponent(String(r.ref))}','/work/${encodeURIComponent(String(r.ref))}','/edition/${encodeURIComponent(String(r.ref))}','/author/','/ebooks/']) assert.ok(sitemap.includes(token),`sitemap missing ${token}`);
for(const route of ['src/routes/books/$id.tsx','src/routes/work/$id.tsx','src/routes/edition/$id.tsx','src/routes/author/$id.tsx']) assert.ok(fs.existsSync(path.join(root,route)),`missing indexable route ${route}`);

const retail=read('src/features/fore/retail.server.ts'),recommendations=read('src/features/fore/recommendations.server.ts');
for(const token of ['setWishlistItem','wishlist_items','alert_price_drop']) assert.ok(retail.includes(token),`wishlist missing ${token}`);
assert.ok(recommendations.includes('wishlistProduct'),'recommendation-facing wishlist mutation is required');
const sync=read('src/features/fore/sync.server.ts');assert.ok(sync.includes('entityType:"wishlist"')||sync.includes('"wishlist"'),'wishlist must participate in cross-device sync');
const workUi=read('src/features/fore/Work.tsx'),editionUi=read('src/features/fore/Edition.tsx');
assert.ok(workUi.includes('View edition')&&workUi.includes('canonicalPublicDomain'),'Work page must expose structured editions');
assert.ok(workUi.includes('Audio editions')&&workUi.includes('/listen/'),'Work page must surface linked public-domain audio editions');
const discovery=read('src/features/fore/discovery.server.ts');
assert.ok(discovery.includes('FROM audio_editions WHERE book_id IN')&&discovery.includes('territory.toUpperCase()==="US"'),'legacy Gutenberg audio siblings must be Work-linked and territory-gated');
assert.ok(seo.includes('result.audioEditions')&&seo.includes('"@type":"Audiobook"'),'Work SEO must include audiobook examples');
const community=read('src/features/fore/community.server.ts');
assert.ok(community.includes('(resolvedBook as any).uploaded && input.visibility === "public"'),'opaque product IDs must preserve personal-upload review privacy');
assert.ok(editionUi.includes('publicProductId'),'Edition page must resolve to canonical Cove product identity');

console.log(`Catalog identity, normalized discovery, CMS, SEO, wishlist, and Work/Edition checks passed across ${migrations.length} migrations with populated-catalog migration coverage.`);
