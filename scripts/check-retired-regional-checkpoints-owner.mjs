/* eslint-disable prettier/prettier -- Private regional checkpoint audit. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const get=p=>readFileSync(p,"utf8");
const api=get("src/features/fore/api.server.ts");
const owner=get("src/storefront-strangler/legal-authority.worker.ts");
const gate=get("src/storefront-strangler/canonical-owner-command-gateway.ts");
const route=get("src/storefront-strangler/publication-owner-routing.server.ts");
const review=JSON.parse(get("docs/architecture/canonical-writer-review.json"));
const lineage=JSON.parse(get("docs/architecture/retired-regional-checkpoints-owner-lineage.json"));
assert.equal(review.releaseApproval,false);
assert.equal(lineage.sourceBefore,36);assert.equal(lineage.sourceAfter,33);
assert.equal(lineage.retired.length,3);
assert.equal(createHash("sha256").update(api).digest("hex"),lineage.currentSha256);
for(const x of lineage.retired){assert.equal(x.table,"gutenberg_source_states");
 assert.equal(x.functionName,"runRegionalCatalogIngestion");
 assert.ok(!review.sites.some(r=>r.siteId===x.siteId));}
assert.ok(review.sites.filter(x=>x.disposition==="owner-command-required").length<=33);
assert.ok(!api.includes("UPDATE gutenberg_source_states SET status='idle',cursor=NULL,cycle_started_at=NULL,last_success_at=?"));
assert.ok(!api.includes("UPDATE gutenberg_source_states SET status='idle',cursor=?,cycle_started_at=?"));
assert.ok(owner.includes("UPDATE gutenberg_source_states SET status='idle',cursor=NULL,cycle_started_at=NULL,last_success_at=?"));
assert.ok(owner.includes("UPDATE gutenberg_source_states SET status='idle',cursor=?,cycle_started_at=?"));
assert.match(owner,/if\(route==="\/catalog\/regional-state"\)/);
assert.match(owner,/st\.status='running' AND st\.lease_token=\?/);
assert.match(gate,/case "catalog.regional-state":/);
assert.match(route,/dispatchCatalogRegionalState/);
console.log("PASS: three regional source checkpoints require the private active-lease owner, release stays locked");
