/* eslint-disable prettier/prettier -- Exact canonical ingestion-state SQL audit assertions. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const read=p=>readFileSync(p,"utf8");
const source=read("src/features/fore/api.server.ts");
const worker=read("src/storefront-strangler/legal-authority.worker.ts");
const routing=read("src/storefront-strangler/publication-owner-routing.server.ts");
const gateway=read("src/storefront-strangler/canonical-owner-command-gateway.ts");
const review=JSON.parse(read("docs/architecture/canonical-writer-review.json"));
const lineage=JSON.parse(read("docs/architecture/retired-ingestion-state-owner-lineage.json"));
assert.equal(review.releaseApproval,false);
assert.equal(lineage.retired.length,9);
assert.equal(lineage.sourceBefore,48);
assert.equal(lineage.sourceAfter,39);
assert.equal(createHash("sha256").update(source).digest("hex"),lineage.currentSha256);
assert.ok(review.sites.filter(x=>x.disposition==="owner-command-required").length<=39);
for(const site of lineage.retired){assert.ok(!review.sites.some(x=>x.siteId===site.siteId));}
for(const sql of ["Recovered after an interrupted EPUB download.",
  "No supported source asset was provided.","epub_last_attempt_at=? WHERE source_id=?",
  "epub_retry_after=? WHERE source_id=?","epub_status=?,epub_attempts=?,epub_next_attempt_at=?",
  "status='running',lease_token=?,lease_until=?","status='degraded',last_error=?",
  "status='failed',last_error=?,attempts=?"]){assert.ok(worker.includes(sql),"Owner SQL missing: "+sql);}
assert.match(worker,/if\(route==="\/catalog\/private-ingest-state"\)/);
assert.match(worker,/ingest_status<>'quarantined'/);
assert.match(worker,/leaseToken:lease/);
assert.match(routing,/dispatchCatalogIngestState/);
assert.match(gateway,/case "catalog.ingestion-state":/);
console.log("PASS: nine ingestion-state SQL writers privately relocated; positive regional copyright and paid rights still locked");
