/* eslint-disable prettier/prettier -- Keep exact legal state assertions and source comparison adjacent for audit. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { transform } from "esbuild";

const source = fs.readFileSync("src/lib/catalog-ingestion-idempotency.ts", "utf8");
const api = fs.readFileSync("src/features/fore/api.server.ts", "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { unchangedNormalizedGutendexBook: same } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);
const book = {
  id: 2701, title: "Moby Dick", authors: [{name:"Herman Melville"}],
  summaries: ["A voyage"], subjects: ["fiction"], bookshelves: ["Adventure"],
  languages: ["en"], formats: { "application/epub+zip": "https://example.org/2701.epub",
    "text/html": "https://example.org/2701.html" },
  copyright: false, download_count: 42
};
const sourceUrl = book.formats["text/html"];
const row = {
  id:"2701", source_id:"pg_us", source_item_id:"2701",
  ingest_status:"active", rights_status:"public-domain",
  commercial_use_status:"approved", rights_territories_json:'["US"]',
  source_url:sourceUrl,rights_evidence_url:sourceUrl,
  updated_at:"2026-10-24T12:00:00Z", projection_updated_at:"2026-10-24T12:00:00Z",
  product_id:"prd_gutenberg_2701",
  title:book.title,projection_title:book.title,
  authors_json:JSON.stringify(book.authors),
  summary:book.summaries[0], subjects_json:JSON.stringify(book.subjects),
  bookshelves_json:JSON.stringify(book.bookshelves),
  languages_json:JSON.stringify(book.languages),
  formats_json:JSON.stringify(book.formats),
  download_count:42,projection_download_count:42,copyright:0
};
assert.equal(same(book,row,sourceUrl),true,"Exact completed projection skips only redundant canonical writes");
assert.equal(same(book,undefined,sourceUrl),false);
for(const patch of [
  {updated_at:"newer"}, {projection_updated_at:"older"}, {product_id:null},
  {rights_status:"quarantined"}, {rights_status:"pending"},
  {commercial_use_status:"pending"}, {rights_territories_json:'["CA"]'},
  {rights_evidence_url:"changed"}, {source_id:"pg_ca"},
  {source_item_id:"2700"}, {ingest_status:"stale"}, {source_url:"changed"},
  {authors_json:"[]"}, {summary:"changed"}, {subjects_json:"[]"},
  {bookshelves_json:"[]"}, {languages_json:"[]"}, {formats_json:"{}"},
  {download_count:40}, {projection_download_count:40},
  {title:"changed"}, {projection_title:"changed"}, {copyright:1}
]) assert.equal(same(book,{...row,...patch},sourceUrl),false,JSON.stringify(patch));
for(const patch of [
  {title:"changed"},{authors:[{name:"changed"}]}, {subjects:["changed"]},
  {bookshelves:["changed"]},{formats:{"application/epub+zip":"new"}},
  {download_count:43}, {copyright:true}
]) assert.equal(same({...book,...patch},row,sourceUrl),false,JSON.stringify(patch));
assert.match(api,/const unchangedIds = new Set\(unchanged\.map/);
assert.match(api,/const changed = accepted\.filter/);
assert.match(api,/for \(const book of changed\)\s*await dispatchCatalogFreeNormalization\(db,/,
  "Every changed book must use the independently authenticated private owner");
assert.doesNotMatch(api,/db\.batch\(commercialCatalogStatements/,
  "No legacy public catalog normalization SQL fallback may survive");
const owner=fs.readFileSync("src/storefront-strangler/legal-authority.worker.ts","utf8");
assert.match(owner,/if\(route==="\/catalog\/normalize-gutenberg"\)/);
assert.match(owner,/source\.commercial_use_status!=="approved"/);
assert.match(api,/for \(const book of accepted\)\s*await syncEditionTaxonomy/,
  "Even an unchanged book MUST recheck taxonomy and incomplete prior publication");
assert.match(api,/dispatchCatalogObservation\(db,/);
assert.doesNotMatch(api,/UPDATE gutenberg_source_cache SET last_seen_at=\?,source_updated_at=\?/);
assert.match(owner,/last_seen_at=\?,source_updated_at=\?/);
assert.match(owner,/c\.source_id=\x27pg_us\x27 AND c\.copyright=0/);
assert.match(api,/JOIN catalog_search_documents d ON d\.product_id=/);
assert.match(api,/JOIN products p ON p\.id=d\.product_id/);
assert.match(api,/\bunchanged: unchanged\.length\b/);
console.log("PASS: exact source content, rights evidence, canonical completeness, retry safety and source heartbeat");
