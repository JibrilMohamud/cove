/* eslint-disable prettier/prettier -- Byte-bound private catalog observation source lineage. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const read=p=>readFileSync(p,"utf8"),sha=s=>createHash("sha256").update(s).digest("hex");
const api=read("src/features/fore/api.server.ts"),owner=read("src/storefront-strangler/legal-authority.worker.ts");
const review=JSON.parse(read("docs/architecture/canonical-writer-review.json"));
const lineage=JSON.parse(read("docs/architecture/retired-us-catalog-observation-owner-lineage.json"));
const gateway=read("src/storefront-strangler/canonical-owner-command-gateway.ts");
const routing=read("src/storefront-strangler/publication-owner-routing.server.ts");
assert.equal(review.releaseApproval,false);
assert.equal(lineage.retired.length,3);
assert.equal(sha(api),lineage.currentSha256);
assert.ok(review.sites.filter(x=>x.disposition==="owner-command-required").length<=43);
assert.ok(lineage.retired.every(x=>x.functionName==="runCatalogIngestion"));
assert.ok(lineage.retired.every(x=>!review.sites.some(y=>y.siteId===x.siteId)));
for(const token of [
 "UPDATE gutenberg_source_cache SET last_seen_at=?,source_updated_at=?",
 "SET download_count=?,source_updated_at=?,last_seen_at=?,updated_at=?",
 "UPDATE catalog_search_documents"
]) {
 assert.ok(!api.includes(token),"Shared popularity SQL remained: "+token);
 assert.ok(owner.includes(token),"Original SQL absent from legal owner: "+token);
}
assert.match(owner,/if\(route==="\/catalog\/observe-us"\)/);
assert.match(owner,/c\.source_id='pg_us' AND c\.copyright=0/);
assert.match(owner,/await db\.batch\(statements\)/);
assert.match(gateway,/case "catalog.observe-us":/);
assert.match(routing,/dispatchCatalogObservation/);
console.log("PASS: three US catalog metadata mutations retired under private active-US CAS owner; legal release locked");
