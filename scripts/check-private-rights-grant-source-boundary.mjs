/* eslint-disable prettier/prettier -- Exact grant write ownership with frozen historical logic. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const read=path=>readFileSync(path,"utf8");
const sha=s=>createHash("sha256").update(s).digest("hex");
const owner=read("src/storefront-strangler/legal-authority.worker.ts");
const shared=read("src/features/fore/rights.server.ts");
const review=JSON.parse(read("docs/architecture/canonical-writer-review.json"));
const start=owner.indexOf("async function upsertRightsGrantPrivate(");
const end=owner.indexOf("\n/* eslint-enable @typescript-eslint/no-explicit-any */",start);
assert.ok(start>0&&end>start,"Exactly one private grant implementation is required");
const preserved=owner.slice(start,end).replace(
"async function upsertRightsGrantPrivate(db: CatalogDB, raw: unknown) {\n  const now=()=>new Date().toISOString();",
"export async function upsertRightsGrant(db: CatalogDB, raw: unknown) {");
assert.equal(sha(preserved),"efea1af346283611e2255495b1f29d9eb61a8e1b2a9a1b27d019290da00a66ee",
  "The entire former grant business transaction and SQL must be byte-exact");
assert.ok(owner.includes("await upsertRightsGrantPrivate(db, {"),"Publication materialization must use private grant writer");
assert.ok(!owner.includes('import {upsertRightsGrant'),"Private owner must never import shared direct D1 grant executor");
assert.equal((owner.match(/async function upsertRightsGrantPrivate\(/g)||[]).length,1);
const a=shared.indexOf("export async function upsertRightsGrant("),
 b=shared.indexOf("\nexport async function territoryExpansionPreview(",a);
assert.ok(a>=0&&b>a);
const stub=shared.slice(a,b);
assert.match(stub,/throw new ApiError\(503/);
assert.doesNotMatch(stub,/\.prepare\(|\.batch\(|\.run\(/);
assert.equal(review.sites.filter(x=>x.file==="src/features/fore/rights.server.ts"&&x.functionName==="upsertRightsGrant").length,0);
assert.equal(review.sites.filter(x=>x.disposition==="owner-command-required").length,371);
assert.equal(review.releaseApproval,false);
console.log("PASS: six grant SQL sites retired to unexported owner, legacy API fail closed, 371 remain, release blocked");
