/* eslint-disable prettier/prettier -- Explicit revision and withdrawal adversarial checks. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { transform } from "esbuild";

const core=fs.readFileSync("src/storefront-strangler/catalog-index-core.ts","utf8");
const graph=fs.readFileSync("src/storefront-strangler/catalog-graph-core.ts","utf8");
const importLine='import { normalizeCatalogIndexRow, type RawCatalogIndexRow } from "./catalog-index-core";';
assert.ok(graph.includes(importLine));
const {code}=await transform(
  graph.replace(importLine,core.replace(/^\/\* eslint-disable [^\n]*\n/,"").replace(/export /g,"") ),
  {loader:"ts",format:"esm"}
);
const {prepareIsolatedCatalogGraph, catalogGraphWrite}=
  await import("data:text/javascript;base64,"+Buffer.from(code).toString("base64"));
const row={
  id:"2701",title:"  Moby Dick  ",summary:"  Ocean and obsession  ",
  authors_json:'[{"name":"Herman Melville"}]',subjects_json:'["Whaling","Fiction"]',
  bookshelves_json:'["Adventure"]',languages_json:'["en","fr"]',
  formats_json:JSON.stringify({"image/jpeg":"https://example.org/c.jpg",
    "application/epub+zip":"https://example.org/b.epub",
    "text/html":"javascript:alert(1)"}),
  source_id:"pg_us",source_item_id:"2701",
  rights_status:"public-domain",commercial_use_status:"approved",
  ingest_status:"active",copyright:0,updated_at:"2026-10-25"
};
const d=prepareIsolatedCatalogGraph(row,"2701",4);
assert.equal(d.title,"Moby Dick");
assert.deepEqual(JSON.parse(d.contributorsJson),["Herman Melville"]);
assert.deepEqual(JSON.parse(d.subjectsJson),["Whaling","Fiction"]);
assert.deepEqual(JSON.parse(d.shelvesJson),["Adventure"]);
assert.deepEqual(JSON.parse(d.languagesJson),["en","fr"]);
assert.ok(JSON.parse(d.assetsJson)["image/jpeg"]);
assert.equal(JSON.parse(d.assetsJson)["text/html"],undefined);
assert.equal(d.workId,"wrk_gutenberg_2701");
const sql=new DatabaseSync(":memory:");
sql.exec(fs.readFileSync("infra/catalog-index/0003_derived_graph.sql","utf8"));
const put=x=>{
  const statement=catalogGraphWrite(x);
  return sql.prepare(statement.sql).run(...statement.binds).changes;
};
assert.equal(put(d),1);
assert.equal(put(prepareIsolatedCatalogGraph({...row,title:"Old"}, "2701",3)),0);
assert.equal(sql.prepare("SELECT title FROM catalog_graph_documents").get().title,"Moby Dick");
const withdrawn=prepareIsolatedCatalogGraph({...row,rights_status:"quarantined"},"2701",5);
assert.equal(withdrawn.visible,0);
assert.equal(put(withdrawn),1);
const latest=sql.prepare("SELECT revision,visible,contributors_json,assets_json FROM catalog_graph_documents").get();
assert.equal(latest.revision,5);
assert.equal(latest.visible,0);
assert.deepEqual(JSON.parse(latest.contributors_json),[]);
assert.deepEqual(JSON.parse(latest.assets_json),{});
assert.equal(put(d),0,"Replay after withdrawal must not restore independent graph");
assert.throws(()=>prepareIsolatedCatalogGraph({...row,formats_json:"x".repeat(65537)},"2701",7),/unbounded/);
const api=fs.readFileSync("src/features/fore/api.server.ts","utf8");
const range=api.slice(api.indexOf("async function getBook("),api.indexOf("function fallbackCatalog("));
assert.match(range,/if \(env\.FORE_ENVIRONMENT === "production"\)/);
assert.ok(range.indexOf("if (env.FORE_ENVIRONMENT === \"production\")")<
  range.indexOf("commercialCatalogStatements(db, id"),
  "Production no-write guard must precede all lazy canonical graph writes");
console.log("PASS isolated full metadata graph: monotonic revisions, no unsafe asset URL, quarantine hides, stale replay denied, production GET cannot normalize");
