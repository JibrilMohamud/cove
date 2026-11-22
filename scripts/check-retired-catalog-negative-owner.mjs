/* eslint-disable prettier/prettier -- Exact negative catalog retirement source assertions. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const read=p=>readFileSync(p,"utf8"),sha=s=>createHash("sha256").update(s).digest("hex");
const source=read("src/features/fore/api.server.ts"),owner=read("src/storefront-strangler/legal-authority.worker.ts");
const review=JSON.parse(read("docs/architecture/canonical-writer-review.json"));
const lineage=JSON.parse(read("docs/architecture/retired-catalog-negative-owner-lineage.json"));
const routes=read("src/storefront-strangler/canonical-owner-command-gateway.ts");
const routing=read("src/storefront-strangler/publication-owner-routing.server.ts");
assert.equal(lineage.retired.length,7);
assert.equal(review.releaseApproval,false);
assert.ok(review.sites.filter(x=>x.disposition==="owner-command-required").length<=52);
assert.equal(sha(source),lineage.currentSha256);
for(const site of lineage.retired)assert.ok(!review.sites.some(x=>x.siteId===site.siteId));
for(const token of [
 "UPDATE products SET storefront_status='inactive',updated_at=?",
 "UPDATE offers SET active=0,updated_at=?",
 "UPDATE editions SET release_status='unavailable',updated_at=?",
 "UPDATE rights_grants SET status='suspended',updated_at=? WHERE source=?",
 "UPDATE gutenberg_source_cache SET epub_status='retry',epub_next_attempt_at='',epub_last_error='Stored EPUB failed validation; repair required.'"
]){assert.ok(!source.includes(token),"Public direct writer remained: "+token);assert.ok(owner.includes(token),"Owner mutation missing: "+token);}
assert.match(owner,/if\(route==="\/catalog\/withdraw-stale"\)/);
assert.match(owner,/if\(route==="\/catalog\/negative-source"\)/);
assert.match(owner,/lease_token=\? AND lease_until>\?/);
assert.match(owner,/const staleCount=Number\(candidate\?\.n\|\|0\)/);
assert.match(owner,/await db.batch\(\[/);
assert.match(routes,/case "catalog.withdraw-stale":/);
assert.match(routes,/case "catalog.negative-source":/);
assert.match(routing,/dispatchCatalogStaleWithdrawal/);
assert.match(routing,/dispatchCatalogNegativeSource/);
console.log("PASS: seven negative-only catalog SQL sites retired to independently lease-verified QA owner; production owner locked");
