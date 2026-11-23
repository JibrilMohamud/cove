/* eslint-disable prettier/prettier -- Source retirement evidence; never a production go-live gate. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const get=p=>readFileSync(p,"utf8");
const source=get("src/features/fore/preorder.server.ts"),
  owner=get("src/storefront-strangler/legal-authority.worker.ts"),
  routing=get("src/storefront-strangler/publication-owner-routing.server.ts"),
  gateway=get("src/storefront-strangler/canonical-owner-command-gateway.ts");
const review=JSON.parse(get("docs/architecture/canonical-writer-review.json"));
const att=JSON.parse(get("docs/architecture/retired-preorder-owner-lineage.json"));
assert.equal(att.retiredCount,15);
assert.equal(att.previousFindings,209);assert.equal(att.currentFindings,194);
assert.equal(new Set(att.retiredSites.map(s=>s.siteId)).size,15);
assert.equal(review.releaseApproval,false);
assert.ok(review.sites.filter(s=>s.disposition==="owner-command-required").length<=113);
assert.equal(review.sites.filter(s=>s.file==="src/features/fore/preorder.server.ts").length,0);
assert.ok(att.retiredSites.every(row=>!review.sites.some(s=>s.siteId===row.siteId)));
assert.doesNotMatch(source,/\b(?:INSERT(?: OR IGNORE)? INTO|UPDATE|DELETE FROM)\s+(?:preorders|preorder_release_plans|entitlements|preorder_refund_jobs|publishing_outbox)\b/i);
assert.match(source,/dispatchPrivatePreorderAction/);
assert.match(owner,/const privatePreorder=\(\(\)=>/);
assert.match(owner,/if\(route==="\/preorder\/private-action"\)/);
assert.match(owner,/Preorder release requires independently verified paid owner authorization/);
assert.match(owner,/if\(a\.input\.success\) return new Response\(null,\{status:409/);
assert.match(owner,/if\(due\) throw new ApiError\(503/);
assert.match(gateway,/"preorder.owner-action":\{path:"\/preorder\/private-action"/);
assert.match(routing,/if\(!context\)throw new ApiError\(503,"Preorder primary writer is not privately owned/);
console.log("PASS: 15 previously public preorder SQL mutations moved to the isolated QA owner; 194 sites still outstanding; production denied");
