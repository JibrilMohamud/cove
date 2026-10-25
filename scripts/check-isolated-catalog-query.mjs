/* eslint-disable prettier/prettier -- Keep isolated FTS / legal-lag proof together. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { transform } from "esbuild";
import fs from "node:fs";
const source = fs.readFileSync("src/storefront-strangler/catalog-index-query.server.ts","utf8");
const {code} = await transform(source,{loader:"ts",format:"esm"});
const {catalogSearchExpression,queryIsolatedCatalogIndex:query,queryIsolatedCatalogGraph:graphQuery} =
  await import("data:text/javascript;base64,"+Buffer.from(code).toString("base64"));
assert.equal(catalogSearchExpression('  Moby Dick!  '),'"Moby" AND "Dick"');
for(const bad of ["","a ".repeat(9),"a".repeat(162), 123]) {
 assert.throws(()=>catalogSearchExpression(bad));
}
const db=new DatabaseSync(":memory:");
db.exec(fs.readFileSync("infra/catalog-index/0001_isolated_search.sql","utf8"));
const put=db.prepare(`INSERT INTO catalog_index_documents
  (product_id,revision,visible,title,description) VALUES(?,?,?,?,?)`);
put.run("prd_gutenberg_2701",1,1,"Moby Dick","Whale");
put.run("prd_gutenberg_2702",1,1,"Other whale book","Moby");
put.run("prd_gutenberg_2703",2,0,"Moby withdrawn","Whale");
const wrapper={prepare(sql) {
 const stmt=db.prepare(sql);
 return {
   async first(){ return stmt.get()??null },
   bind(...args) {return {
     async first(){return stmt.get(...args)??null},
     async all(){return {results:stmt.all(...args)}}
   }}
 };
}};
const env={CATALOG_INDEX_DB:wrapper,COVE_CATALOG_SEARCH_ENABLED:"1"};
let result=await query(env,{query:"Moby",page:1,limit:10});
assert.deepEqual(result.ids,["prd_gutenberg_2701","prd_gutenberg_2702"]);
assert.equal(result.authoritative,false);
assert.equal(result.hasMore,false);
await assert.rejects(()=>query({...env,COVE_CATALOG_SEARCH_ENABLED:"0"},{query:"Moby"}),/disabled/);
for(const invalid of [{query:""},{query:"Moby",limit:65},{query:"Moby",page:11}])
 await assert.rejects(()=>query(env,invalid));
db.exec(fs.readFileSync("infra/catalog-index/0003_derived_graph.sql","utf8"));
db.prepare(`INSERT INTO catalog_graph_documents
  (source_id,revision,visible,work_id,edition_id,product_id,title,description,
   contributors_json,subjects_json,shelves_json,languages_json,assets_json,source_name,source_item_id)
  VALUES('2701',1,1,'wrk_gutenberg_2701','ed_gutenberg_2701',
    'prd_gutenberg_2701','Moby Dick','Whale','["Melville"]',
    '["Fiction"]','["Classics"]','["en"]','{"image/jpeg":"https://example.org/cover.jpg"}','pg_us','2701')`).run();
const books=await graphQuery(env,["prd_gutenberg_2701","prd_gutenberg_2702"]);
assert.equal(books.authoritative,false);
assert.equal(books.books.length,1);
assert.equal(books.books[0].authors[0],"Melville");
assert.equal(books.books[0].coverUrl,"https://example.org/cover.jpg");
await assert.rejects(()=>graphQuery(env,["prd_gutenberg_2701","prd_gutenberg_2701"]),/invalid/);
db.exec("CREATE TABLE entitlements(id TEXT)");
await assert.rejects(()=>query(env,{query:"Moby"}),/not_isolated/);
console.log("PASS: private isolated FTS term validation, bounded IDs, tombstone exclusion, identity fail-closed");
