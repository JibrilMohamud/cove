/* eslint-disable prettier/prettier -- Fixed owner SQL lineage / anti-bypass assertions. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const read=p=>readFileSync(p,"utf8"),sha=s=>createHash("sha256").update(s).digest("hex");
const api=read("src/features/fore/api.server.ts"),owner=read("src/storefront-strangler/legal-authority.worker.ts");
const review=JSON.parse(read("docs/architecture/canonical-writer-review.json"));
const lineage=JSON.parse(read("docs/architecture/retired-regional-ingestion-owner-lineage.json"));
const gateway=read("src/storefront-strangler/canonical-owner-command-gateway.ts");
const routing=read("src/storefront-strangler/publication-owner-routing.server.ts");
assert.equal(review.releaseApproval,false);
assert.equal(lineage.retired.length,6);
assert.equal(sha(api),lineage.currentSha256);
assert.ok(review.sites.filter(x=>x.disposition==="owner-command-required").length<=46);
assert.ok(lineage.retired.every(x=>x.table==="gutenberg_source_states"&&x.functionName==="runRegionalCatalogIngestion"));
assert.ok(lineage.retired.every(x=>!review.sites.some(y=>y.siteId===x.siteId)));
for(const sql of [
 "UPDATE gutenberg_source_states SET status='running',lease_token=?",
 "UPDATE gutenberg_source_states SET status='degraded',last_error=?",
 "UPDATE gutenberg_source_states SET status='idle',cursor=NULL,cycle_started_at=NULL,last_success_at=?",
 "UPDATE gutenberg_source_states SET status='idle',cursor=?,cycle_started_at=?",
 "UPDATE gutenberg_source_states SET status='failed',last_error=?"
]){assert.ok(!api.includes(sql),"Unretired regional SQL in shared API: "+sql);assert.ok(owner.includes(sql),"Owner lost historic SQL: "+sql);}
assert.match(owner,/if\(route==="\/catalog\/regional-state"\)/);
assert.match(owner,/st\.status='running' AND st\.lease_token=\? AND st\.lease_until>\?/);
assert.match(owner,/if\(Number\(pending\?\.n\|\|0\)>0\)/);
assert.match(owner,/runId:z\.string\(\)\.regex/);
assert.match(gateway,/case "catalog.regional-state":/);
assert.match(routing,/dispatchCatalogRegionalState/);
console.log("PASS: six source-state SQL mutations retired to active-lease/run-checked QA legal owner; production locked");
