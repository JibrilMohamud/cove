/* eslint-disable prettier/prettier -- Reviewed one-off source lineage assertions. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const r=p=>readFileSync(p,"utf8");
const source=r("src/features/fore/rights.server.ts"),owner=r("src/storefront-strangler/legal-authority.worker.ts");
const review=JSON.parse(r("docs/architecture/canonical-writer-review.json"));
const lineage=JSON.parse(r("docs/architecture/retired-rights-config-owner-lineage.json"));
assert.equal(review.releaseApproval,false);
assert.equal(review.sites.filter(x=>x.disposition==="owner-command-required").length,59);
assert.equal(lineage.retired.length,6);
assert.ok(lineage.retired.every(x=>!review.sites.some(y=>y.siteId===x.siteId)));
for(const sql of [/INSERT INTO rights_parties/,/DELETE FROM territory_set_members/,/INSERT INTO territory_set_members/,/INSERT INTO territory_sets/,/DELETE FROM territory_set_rules/,/INSERT INTO territory_set_rules/]) {
  assert.doesNotMatch(source,sql);assert.match(owner,sql);
}
assert.match(owner,/const privateRightsConfiguration=/);
assert.match(owner,/if\(route==="\/rights\/private-configuration"\)/);
assert.match(owner,/commerce.manage/);
assert.match(owner,/status:z.enum\(\["inactive","archived"\]\)/);
assert.match(owner,/if\(this.rightsConfigExecution\)/);
assert.match(r("src/features/fore/api.server.ts"),/upsertRightsParty\(database\(env\), await body\(request\), financeStaff.userId\)/);
assert.match(r("src/storefront-strangler/canonical-owner-command-gateway.ts"),/case "rights.private-configuration":/);
console.log("PASS: six private rights writer sites; owner rejects positive territory rules and unauthorized staff; release remains locked");
