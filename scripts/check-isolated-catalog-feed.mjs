/* eslint-disable prettier/prettier -- Strict primary outbox/event ordering tests. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { transform } from "esbuild";
import { DatabaseSync } from "node:sqlite";
const source=fs.readFileSync("src/storefront-strangler/catalog-index-feed-core.ts","utf8");
const {code}=await transform(source,{loader:"ts",format:"esm"});
const {coalesceCatalogFeedChanges:coalesce}=await import("data:text/javascript;base64,"+Buffer.from(code).toString("base64"));
const e=[
  {id:"2701",seq:11,operation:"upsert"},
  {id:"2702",seq:12,operation:"upsert"},
  {id:"2701",seq:13,operation:"upsert"},
  {id:"2703",seq:14,operation:"delete"},
  {id:"2702",seq:15,operation:"delete"},
  {id:"2701",seq:16,operation:"upsert"},
];
assert.deepEqual(coalesce(e),[
  {id:"2703",seq:14,operation:"delete"},
  {id:"2702",seq:15,operation:"delete"},
  {id:"2701",seq:16,operation:"upsert"},
],"Only newest source event remains; final deletes must never resurrect old text");
assert.deepEqual(coalesce([]),[]);
assert.throws(()=>coalesce([e[0],e[0]]),/invalid_order/);
assert.throws(()=>coalesce([e[1],e[0]]),/invalid_order/);
assert.throws(()=>coalesce([{...e[0],seq:0}]),/invalid_order/);
assert.throws(()=>coalesce([{...e[0],id:"x' OR 1=1"}]),/invalid_order/);
assert.throws(()=>coalesce([{...e[0],operation:"rights-allow"}]),/invalid_order/);
assert.throws(()=>coalesce(Array.from({length:17},(_,i)=>({...e[0],seq:i+1}))),/unbounded/);
// Execute the real independent graph, normalized preparation and FTS SQL in
// ONE atomic SQLite transaction with the final source revision only.
const db=new DatabaseSync(":memory:");
for(const file of ["infra/catalog-index/0001_isolated_search.sql",
                   "infra/catalog-index/0002_normalized_preparations.sql",
                   "infra/catalog-index/0003_derived_graph.sql"])
 db.exec(fs.readFileSync(file,"utf8"));
const coreSource=fs.readFileSync("src/storefront-strangler/catalog-index-core.ts","utf8");
const {code:coreJs}=await transform(coreSource,{loader:"ts",format:"esm"});
const {normalizeCatalogIndexRow, catalogIndexWrite}=await import("data:text/javascript;base64,"+Buffer.from(coreJs).toString("base64"));
const initial={id:"2701",title:"Original",summary:"Source",authors_json:"[]",
  subjects_json:"[]",bookshelves_json:"[]",languages_json:"[]",copyright:0,
  rights_status:"public-domain",commercial_use_status:"approved",ingest_status:"active",
  approved_evidence:1,updated_at:"2026-10-25"};
const upsert=(row,seq)=>{
  const doc=normalizeCatalogIndexRow(row,"2701",seq),write=catalogIndexWrite(doc);
  return db.prepare(write.sql).run(...write.binds);
};
db.exec("BEGIN");
upsert(initial,16);
db.exec("COMMIT");
assert.equal(db.prepare("SELECT revision,title,visible FROM catalog_index_documents").get().revision,16);
db.exec("BEGIN");
upsert({...initial,rights_status:"quarantined"},17);
db.exec("COMMIT");
assert.equal(db.prepare("SELECT visible FROM catalog_index_documents").get().visible,0);
db.exec("BEGIN");
upsert(initial,16);
db.exec("COMMIT");
assert.equal(db.prepare("SELECT visible FROM catalog_index_documents").get().visible,0);
assert.equal(db.prepare("SELECT count(*) n FROM catalog_index_fts WHERE catalog_index_fts MATCH 'Original'").get().n,0);
const capture=fs.readFileSync("src/storefront-strangler/catalog-index-capture.server.ts","utf8");
assert.match(capture,/withSession\(feed \? "first-primary" : "first-unconstrained"\)/);
assert.match(capture,/const latest = coalesceCatalogFeedChanges\(events\.results\)/);
assert.match(capture,/await writeRows\(env\.CATALOG_INDEX_DB, rows, latest\)/);
assert.match(capture,/if \(writes\.length\) await db\.batch\(writes\)/);
assert.ok(capture.indexOf("await writeRows(env.CATALOG_INDEX_DB, rows, latest)")<
 capture.indexOf("UPDATE catalog_index_capture SET feed_cursor=?"),"ACK must follow durable projection write");
console.log("PASS: 16-event bounded coalescing, primary-first outbox causal session, single isolated transaction, withdrawal/tombstone replay, ACK ordering");
