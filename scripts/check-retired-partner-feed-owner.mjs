/* eslint-disable prettier/prettier -- Source-level negative retirement evidence. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const source=readFileSync("src/features/fore/traditional-publishing.server.ts","utf8");
const owner=readFileSync("src/storefront-strangler/legal-authority.worker.ts","utf8");
const gateway=readFileSync("src/storefront-strangler/canonical-owner-command-gateway.ts","utf8");
const proxy=readFileSync("src/storefront-strangler/publication-owner-routing.server.ts","utf8");
const review=JSON.parse(readFileSync("docs/architecture/canonical-writer-review.json","utf8"));
const rows=review.sites.filter(x=>x.file==="src/features/fore/traditional-publishing.server.ts");
assert.equal(rows.filter(x=>x.disposition==="owner-command-required").length,0);
const partnerLineage=JSON.parse(readFileSync("docs/architecture/retired-traditional-partner-owner-lineage.json","utf8"));
assert.equal(partnerLineage.retiredCount,13);
assert.equal(partnerLineage.siteReview.length,13);
assert.ok(partnerLineage.siteReview.every(x=>!review.sites.some(r=>r.siteId===x.siteId)));
assert.ok(review.sites.filter(x=>x.disposition==="owner-command-required").length<=260,
  "A later audited retirement may reduce, but never increase, this previously certified source count");
assert.equal(review.releaseApproval,false);
assert.match(source,/export async function processPartnerFeedQueue\(db: CatalogDB, limit = 25\) \{\s*return dispatchPartnerFeedProcessing\(db, limit\);/);
for(const name of ["applyMetadataItem","applyAssetManifestItem","applyDeltaItem","reconcileFullPartnerSnapshot"])
  assert.doesNotMatch(source,new RegExp("async function "+name+"\\("));
assert.match(source,/async function matchAssetExpectations\(/);
assert.equal(partnerLineage.siteReview.filter(x=>x.functionName==="matchAssetExpectations").length,1);
assert.match(owner,/const processPartnerFeedQueuePrivate = \(\(\) => \{/);
assert.match(owner,/environment='sandbox' AND feed_type<>'assets_manifest'/);
assert.match(owner,/submission.environment !== "sandbox" \|\| submission.feed_type === "assets_manifest"/);
assert.match(owner,/if \(!qaOwnerLeaseLive\(env\)\)/);
assert.match(owner,/if\(this.partnerFeedRunning\)return new Response\(null,\{status:409/);
assert.match(owner,/await processPartnerFeedQueuePrivate\(env.PRIMARY_DB,Number\(q.limit\)\)/);
assert.match(proxy,/if\(!context\)throw new ApiError\(503,"Partner feed application requires its private owner\."\)/);
assert.match(gateway,/"partner.process-feed":\{path:"\/publishing\/partner\/process-feed"/);
assert.match(gateway,/case "partner.process-feed":[\s\S]*?ack.ownerFirst!==true/);
// Preserve every removed literal's previous independent source identity.
// A source rename or SQL disappearance from the owner may not launder the audit.
const lineage=JSON.parse(readFileSync("docs/architecture/retired-partner-feed-source-lineage.json","utf8"));
assert.equal(lineage.schema,"cove.retired-owner-writer-source-lineage.v1");
assert.equal(lineage.productionReleaseEligible,false);
assert.equal(lineage.rows.length,26);
assert.equal(lineage.rows.filter(x=>x.disposition==="owner-command-required").length,25);
assert.equal(lineage.rows.filter(x=>x.disposition==="non-authorizing-write").length,1);
for(const entry of lineage.rows){
  assert.ok(!review.sites.some(x=>x.siteId===entry.siteId),
    "The retired caller site still appears in live audit: "+entry.siteId);
}
const {createHash}=await import("node:crypto");
const ts=(await import("typescript")).default;
const sourceFile=ts.createSourceFile("legal-authority.worker.ts",owner,ts.ScriptTarget.Latest,true);
assert.equal(sourceFile.parseDiagnostics.length,0);
const begin=owner.indexOf("const processPartnerFeedQueuePrivate = (() => {");
const end=owner.indexOf("export class CoveLegalAuthority",begin);
assert.ok(begin>=0&&end>begin);
const privateLiterals=new Set();
function visit(node){
  if(node.getStart(sourceFile)>=begin&&node.end<=end&&
     (ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)||ts.isTemplateExpression(node)))
    privateLiterals.add(createHash("sha256").update(node.getText(sourceFile)).digest("hex"));
  ts.forEachChild(node,visit);
}
visit(sourceFile);
for(const row of lineage.rows)
  assert.ok(privateLiterals.has(row.sqlSha256),
    "Retired SQL literal has no byte-exact private-owner counterpart: "+row.functionName+" "+row.table);
console.log("PASS: 25 private owner-only partner SQL writers retired, no more than 260 unresolved; production positive feed activation denied.");
