import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const migrations = fs.readdirSync("drizzle").filter((x) => /^\d+_.*\.sql$/.test(x)).sort();
assert.ok(migrations.includes("0007_commercial_storefront.sql"), "commercial storefront migration is missing");

const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys=ON");
for (const file of migrations.filter((x) => x < "0007_")) db.exec(fs.readFileSync(path.join("drizzle", file), "utf8"));

const now = "2026-09-23T04:00:00Z";
db.prepare("INSERT INTO publishers(id,name,website,created_at,updated_at) VALUES(?,?,?,?,?)").run("pub_test", "Test House", "https://publisher.example", now, now);
db.prepare("INSERT INTO works(id,title,original_language,original_publication_date,min_age,max_age,content_warnings,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run("work_fantasy", "Moonfire", "en", null, null, null, "", now, now);
db.prepare("INSERT INTO contributors(id,name,sort_name,bio,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("author_test", "Doe, Jane", "Doe, Jane", "Fantasy novelist", now, now);
db.prepare(`INSERT INTO editions(id,work_id,publisher_id,imprint_id,title,subtitle,description,edition_number,language,original_language,publication_date,release_date,preorder_date,isbn13,publisher_identifier,page_estimate,word_count,reading_time_minutes,file_size_bytes,epub_version,layout,drm_status,downloadable,release_status,subscription_eligible,library_eligible,publisher_description,editorial_reviews,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("edition_fantasy","work_fantasy","pub_test",null,"Moonfire","","Epic fantasy","","en","en","2026-07-01","2026-08-01",null,null,"",null,null,null,null,"3","reflowable","none",1,"available",0,0,"","",now,now);
db.prepare("INSERT INTO products(id,edition_id,sku,format,storefront_status,source_name,source_external_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run("product_fantasy","edition_fantasy","sku_fantasy","ebook","active","gutenberg","999999","2026-08-02T00:00:00Z","2026-09-01T00:00:00Z");
db.prepare("INSERT INTO edition_contributors(edition_id,contributor_id,role,position) VALUES(?,?,?,?)").run("edition_fantasy","author_test","author",0);
db.prepare("INSERT INTO categories(id,scheme,code,name,parent_id) VALUES(?,?,?,?,?)").run("cat_fantasy","gutenberg-subject","","Fantasy fiction",null);
db.prepare("INSERT INTO edition_categories(edition_id,category_id) VALUES(?,?)").run("edition_fantasy","cat_fantasy");
db.prepare("INSERT INTO edition_languages(edition_id,language_code,kind) VALUES(?,?,?)").run("edition_fantasy","en","content");
db.prepare("INSERT INTO rights_grants(id,edition_id,rightsholder_id,territory_code,format,sales_channel,starts_at,ends_at,license_type,drm_requirement,subscription_permitted,library_permitted,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("right_test","edition_fantasy",null,"US","ebook","retail",null,null,"public-domain","none",0,0,now);
db.prepare(`INSERT INTO catalog_search_documents(product_id,external_book_id,title,contributors_text,subjects_text,categories_text,languages_text,description,download_count,first_ingested_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run("product_fantasy","999999","Moonfire","Doe, Jane","Fantasy fiction","Fantasy fiction","en","Epic fantasy",123,"2026-08-02T00:00:00Z","2026-09-01T00:00:00Z");

db.exec(fs.readFileSync("drizzle/0007_commercial_storefront.sql", "utf8"));
db.exec(fs.readFileSync("drizzle/0008_storefront_operations_hardening.sql", "utf8"));
const mapped = db.prepare(`SELECT n.path FROM edition_taxonomy_nodes et JOIN storefront_taxonomy_nodes n ON n.id=et.taxonomy_node_id WHERE et.edition_id=? ORDER BY n.depth,n.path`).all("edition_fantasy").map((x) => x.path);
assert.deepEqual(mapped, ["fiction", "fiction/fantasy"]);
assert.match(db.prepare("SELECT taxonomy_text FROM catalog_search_documents WHERE product_id=?").get("product_fantasy").taxonomy_text, /fiction\/fantasy/);
assert.equal(db.prepare("SELECT COUNT(*) count FROM storefront_taxonomy_nodes").get().count, 42);
assert.equal(db.prepare("SELECT COUNT(*) count FROM storefront_taxonomy_mappings").get().count, 49);
assert.equal(db.prepare("SELECT COUNT(*) count FROM storefront_pages").get().count, 4);
assert.equal(db.prepare("SELECT COUNT(*) count FROM merch_slots").get().count, 4);
assert.ok(db.prepare("SELECT COUNT(*) count FROM merch_placements").get().count >= 3);
assert.equal(db.prepare("SELECT max_placements FROM merch_slots WHERE slot_key='home.hero'").get().max_placements, 1);
assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='storefront_redirects'").get());

// Stable entity identity must be usable independently of display names.
db.prepare("INSERT INTO series(id,name,description,publisher_id,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("series_test","Moonfire Saga","","pub_test",now,now);
db.prepare("INSERT INTO series_memberships(series_id,edition_id,position,label) VALUES(?,?,?,?)").run("series_test","edition_fantasy",1,"Book 1");
assert.equal(db.prepare("SELECT p.id FROM products p JOIN editions e ON e.id=p.edition_id WHERE EXISTS(SELECT 1 FROM edition_contributors ec WHERE ec.edition_id=e.id AND ec.contributor_id=?) AND e.publisher_id=? AND EXISTS(SELECT 1 FROM series_memberships sm WHERE sm.edition_id=e.id AND sm.series_id=?)").get("author_test","pub_test","series_test").id,"product_fantasy");

// Commercial dates are separate concepts; future inventory must not masquerade as released/published.
function addDateSample(suffix, publication, release, created, updated, status = "available", preorder = null) {
  db.prepare("INSERT INTO works(id,title,original_language,content_warnings,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(`w_${suffix}`,suffix,"en","",created,updated);
  db.prepare("INSERT INTO editions(id,work_id,title,subtitle,description,edition_number,language,publication_date,release_date,preorder_date,publisher_identifier,epub_version,layout,drm_status,downloadable,release_status,subscription_eligible,library_eligible,publisher_description,editorial_reviews,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(`e_${suffix}`,`w_${suffix}`,suffix,"","","","en",publication,release,preorder,"","3","reflowable","none",1,status,0,0,"","",created,updated);
  db.prepare("INSERT INTO products(id,edition_id,sku,format,storefront_status,source_name,source_external_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(`p_${suffix}`,`e_${suffix}`,`sku_${suffix}`,"ebook","active","fore",`fore_${suffix}`,created,updated);
  db.prepare("INSERT INTO catalog_search_documents(product_id,external_book_id,title,contributors_text,subjects_text,categories_text,languages_text,description,download_count,first_ingested_at,updated_at,publication_date,release_date,preorder_date,product_created_at,product_updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(`p_${suffix}`,`fore_${suffix}`,suffix,"","","","en","",0,created,updated,publication,release,preorder,created,updated);
}
addDateSample("alpha","2020-01-01","2024-01-01","2026-09-20T00:00:00Z","2026-09-20T01:00:00Z");
addDateSample("beta","2025-01-01","2025-06-01","2026-08-01T00:00:00Z","2026-09-22T00:00:00Z");
addDateSample("gamma","2026-08-01","2026-08-15","2026-09-01T00:00:00Z","2026-09-10T00:00:00Z");
addDateSample("future","2026-11-01","2026-11-15","2026-09-22T00:00:00Z","2026-09-22T00:00:00Z","preorder","2026-09-01");
const auditNow = "2026-09-23T04:00:00Z";
const base = "SELECT p.source_external_id id FROM catalog_search_documents d JOIN products p ON p.id=d.product_id JOIN editions e ON e.id=p.edition_id WHERE p.source_name='fore' AND p.storefront_status='active'";
const ids = (sql, ...args) => db.prepare(sql).all(...args).map((x) => x.id);
assert.deepEqual(ids(base+" AND COALESCE(e.release_date,e.publication_date)<=? ORDER BY COALESCE(e.release_date,e.publication_date,'0001-01-01') DESC",auditNow),["fore_gamma","fore_beta","fore_alpha"]);
assert.deepEqual(ids(base+" AND e.publication_date IS NOT NULL AND e.publication_date<=? ORDER BY e.publication_date DESC",auditNow),["fore_gamma","fore_beta","fore_alpha"]);
assert.equal(ids(base+" ORDER BY COALESCE(d.product_created_at,d.first_ingested_at) DESC,d.external_book_id DESC")[0],"fore_future");
assert.equal(ids(base+" ORDER BY COALESCE(d.product_updated_at,d.updated_at) DESC,d.external_book_id DESC")[0],"fore_future");
assert.deepEqual(ids(base+" AND (e.release_date>? OR e.release_status='preorder') ORDER BY COALESCE(e.release_date,e.preorder_date,'9999-12-31') ASC",auditNow),["fore_future"]);

const store = fs.readFileSync("src/features/fore/Store.tsx","utf8");
const search = fs.readFileSync("src/features/fore/search.server.ts","utf8");
const routes = fs.readFileSync("src/routeTree.gen.ts","utf8");
const merch = fs.readFileSync("src/features/fore/merchandising.server.ts","utf8");
const taxonomy = fs.readFileSync("src/features/fore/taxonomy.server.ts","utf8");
assert.doesNotMatch(store, /books\.find\([^\n]*1342/);
assert.doesNotMatch(search, /CAST\(id AS INTEGER\)\s+DESC/i);
for (const label of ["Recently released","Recently published","Recently added to Cove","Recently updated","Coming soon"]) assert.match(store,new RegExp(label));
for (const route of ["/ebooks/$","/author/$id","/series/$id","/publisher/$id","/campaign/$slug","/staff/storefront"]) assert.ok(routes.includes(`'${route}'`),`route ${route} missing`);
assert.match(store,/history\[mode === "replace" \? "replaceState" : "pushState"\]/);
assert.match(store,/home\.campaign/);
assert.match(store,/IntersectionObserver/);
assert.match(store,/pageViewId/);
assert.match(store,/noindex,follow/);
assert.match(merch,/chooseWeighted/);
assert.match(merch,/max_placements/);
assert.match(merch,/INSERT OR IGNORE INTO merch_events/);
assert.match(merch,/A click can only be attributed after a valid placement impression/);
assert.match(taxonomy,/storefront_redirects/);
assert.match(taxonomy,/cannot be moved underneath one of its descendants/);
assert.match(taxonomy,/refreshTaxonomyProjection/);
assert.match(taxonomy,/COUNT\(DISTINCT p\.id\) product_count/);

console.log("Storefront regression checks passed: date semantics, taxonomy backfill, entity URLs, URL state/SEO, CMS seeds, sticky merchandising, impression hardening, and taxonomy redirects.");
