/* eslint-disable prettier/prettier -- Exact provenance safety must remain adjacent to regression assertions. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { transform } from "esbuild";
const source=fs.readFileSync("src/lib/catalog-ingestion-idempotency.ts","utf8");
const api=fs.readFileSync("src/features/fore/api.server.ts","utf8");
const {code}=await transform(source,{loader:"ts",format:"esm"});
const {unchangedNormalizedGutendexBook:same,popularityOnlyGutendexBook:popularity}=await import(
  "data:text/javascript;base64,"+Buffer.from(code).toString("base64"));
const book={
  id:2701,title:"Moby Dick",authors:[{name:"Herman Melville"}],
  summaries:["Voyage"],subjects:["fiction"],bookshelves:["Adventure"],
  languages:["en"],formats:{"application/epub+zip":"https://example.org/2701.epub",
    "text/html":"https://example.org/2701.html"},copyright:false,download_count:11,
};
const url=book.formats["text/html"];
const row={
  id:"2701",source_id:"pg_us",source_item_id:"2701",ingest_status:"active",
  rights_status:"public-domain",commercial_use_status:"approved",
  rights_territories_json:'["US"]',rights_evidence_url:url,source_url:url,
  updated_at:"2026-10-24T12:00:00Z",projection_updated_at:"2026-10-24T12:00:00Z",
  product_id:"prd_gutenberg_2701",title:book.title,projection_title:book.title,
  authors_json:JSON.stringify(book.authors),summary:book.summaries[0],
  subjects_json:JSON.stringify(book.subjects),bookshelves_json:JSON.stringify(book.bookshelves),
  languages_json:JSON.stringify(book.languages),formats_json:JSON.stringify(book.formats),
  download_count:10,projection_download_count:10,copyright:0
};
assert.equal(same(book,row,url),false);
assert.equal(popularity(book,row,url),true);
assert.equal(popularity({...book,download_count:10},row,url),false);
for(const count of [-1,1.5,undefined,"not-a-number"]) assert.equal(
  popularity({...book,download_count:count},row,url),false);
for(const patch of [
  {updated_at:"changed"}, {projection_updated_at:"changed"},{product_id:null},
  {projection_download_count:8},{rights_status:"withdrawn"},
  {commercial_use_status:"pending"},{rights_territories_json:'["CA"]'},
  {rights_evidence_url:"replaced"},{source_url:"replaced"},{source_id:"pg_ca"},
  {copyright:1},{ingest_status:"stale"},{title:"changed"},
  {projection_title:"changed"},{authors_json:"[]"},{summary:"changed"},
  {formats_json:"{}"},{subjects_json:"[]"},{bookshelves_json:"[]"},
  {languages_json:"[]"}
]) assert.equal(popularity(book,{...row,...patch},url),false,JSON.stringify(patch));
for(const patch of [
  {title:"changed"},{authors:[]},{summaries:["changed"]},
  {subjects:[]},{bookshelves:[]},{languages:[]},
  {formats:{"text/html":"another url"}},{copyright:true}
]) assert.equal(popularity({...book,...patch},row,url),false,JSON.stringify(patch));
assert.match(api,/const popularityIds = new Set/);
assert.match(api,/for \(const book of changed\)\s+await dispatchCatalogFreeNormalization\(db,/,
  "Changed rights-scoped catalog rows can be normalized only by the private owner");
assert.doesNotMatch(api,/db\.batch\(commercialCatalogStatements/,
  "Never restore a direct public D1 catalog writer");
assert.match(api,/for \(const book of accepted\)\s+await syncEditionTaxonomy/);
console.log("PASS: popularity-only classification; all legal, source and canonical mismatches fail closed");
