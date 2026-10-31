/* QA-only source retirement assertions. SQL-table regex scans remain unchanged. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const rd=p=>readFileSync(p,"utf8");
const review=JSON.parse(rd("docs/architecture/canonical-writer-review.json"));
const lineage=JSON.parse(rd("docs/architecture/retired-moderation-owner-lineage.json"));
const shared=rd("src/features/fore/moderation.server.ts");
const owner=rd("src/storefront-strangler/legal-authority.worker.ts");
const gateway=rd("src/storefront-strangler/canonical-owner-command-gateway.ts");
assert.equal(review.releaseApproval,false);
assert.equal(lineage.retired.length,5);
assert.ok(review.sites.filter(x=>x.disposition==="owner-command-required").length<=65);
assert.ok(lineage.retired.every(x=>!review.sites.some(y=>y.siteId===x.siteId)));
assert.match(shared,/return dispatchPrivateModerationAction\(db,staff.userId,x\)/);
for(const mutation of [/UPDATE publishing_accounts SET status=/,/UPDATE publishing_release_lifecycles SET state=/,/UPDATE products SET storefront_status=/,/UPDATE editions SET release_status=/,/INSERT INTO publishing_lifecycle_events/]) {
  assert.doesNotMatch(shared,mutation);
  assert.match(owner,mutation);
}
assert.match(owner,/if\(route==="\/moderation\/private-action"\)/);
assert.match(owner,/staff_principals WHERE user_id=\? AND status='active'/);
assert.match(owner,/moderationExecution=true/);
assert.match(owner,/restore_title","copyright_restore","approve_submission/);
assert.match(gateway,/case "moderation.execute-action":/);
console.log("PASS: five moderation canonical SQL sites privately transplanted; source lineage and QA denial verified");
