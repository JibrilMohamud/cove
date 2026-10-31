/* eslint-disable prettier/prettier -- Final source-exact owner-writer closure audit, never a release approval. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
const read=p=>readFileSync(p,"utf8");
const src=read("src/features/fore/api.server.ts");
const owner=read("src/storefront-strangler/legal-authority.worker.ts");
const gateway=read("src/storefront-strangler/canonical-owner-command-gateway.ts");
const routing=read("src/storefront-strangler/publication-owner-routing.server.ts");
const review=JSON.parse(read("docs/architecture/canonical-writer-review.json"));
const lineage=JSON.parse(read("docs/architecture/retired-catalog-source-ingest-owner-lineage.json"));
assert.equal(review.releaseApproval,false);
assert.equal(lineage.releaseApproval,false);
assert.equal(lineage.productionCertified,false);
assert.equal(lineage.sourceBefore,1);
assert.equal(lineage.sourceAfter,0);
assert.equal(createHash("sha256").update(src).digest("hex"),lineage.currentSha256);
assert.equal(lineage.retired.length,1);
assert.equal(lineage.retired[0].table,"gutenberg_source_cache");
assert.ok(!review.sites.some(r=>r.siteId===lineage.retired[0].siteId));
assert.equal(review.sites.filter(x=>x.disposition==="owner-command-required").length,0);
assert.doesNotMatch(src,/\bINSERT INTO gutenberg_source_cache\(/);
const start=src.indexOf("export function catalogInsert(");
const stop=src.indexOf("async function ensureCatalogState(",start);
assert.ok(start>0&&stop>start);
assert.match(src.slice(start,stop),/return\s+\{\s*cacheId:\s*String\(book\.id\),\s*sourceId,\s*fields:\s*\[/);
assert.doesNotMatch(src.slice(start,stop),/\.prepare\(/);
assert.ok((src.match(/dispatchPrivateCatalogSourceBatch\(db,/g)||[]).length>=5);
assert.match(routing,/if\(!context\)throw new ApiError\(503,"Catalog source ingestion requires private legal authority."\)/);
assert.match(gateway,/"catalog\.observe-source-ingest":\{path:"\/catalog\/private-source-ingest"/);
assert.match(gateway,/case "catalog\.observe-source-ingest":/);
assert.match(owner,/if\(route==="\/catalog\/private-source-ingest"\)/);
for(const guard of [
  "args[27]=\"pending\"","args[32]=\"pending\"",
  "rights_territories_json","rights_evidence_url","rightsFingerprint",
  "gutenberg_sources WHERE id=? AND enabled=1","marketIsWithdrawn(sql,t)",
  "gutenberg_rights_evidence WHERE cache_id=?",
  "rights_grants SET status='suspended'",
  "UPDATE gutenberg_source_cache SET rights_status=CASE WHEN rights_status IN ('quarantined','rejected')",
  "INSERT INTO gutenberg_source_cache(","await db.batch(statements)",
  "cove.owner-catalog-source-ingest.v1"
]) assert.ok(owner.includes(guard),"Missing independent source owner protection: "+guard);
console.log("PASS: 0 owner-required shared SQL sites, all original source upserts retired; production authority remains disabled.");
