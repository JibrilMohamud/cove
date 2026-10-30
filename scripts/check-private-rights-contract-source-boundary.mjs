/* eslint-disable prettier/prettier -- Audited source-retirement boundary, no production approval. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const digest=s=>createHash("sha256").update(s).digest("hex");
const owner=readFileSync("src/storefront-strangler/legal-authority.worker.ts","utf8");
const shared=readFileSync("src/features/fore/rights.server.ts","utf8");
const review=JSON.parse(readFileSync("docs/architecture/canonical-writer-review.json","utf8"));
const expectedSourceHash="9bfa170cca3c305d2137001b9d109e575d3c0f9a4487e655138ce9cd4a1e9b53";
const start=owner.indexOf("async function upsertRightsContractPrivate(");
const end=owner.indexOf("\n// The only physical executor of distribution-contract",start);
assert.ok(start>=0&&end>start,"Private owner contract executor must exist");
const privateBody=owner.slice(start,end).trimEnd().replace(
  "async function upsertRightsContractPrivate(db: CatalogDB, raw: unknown) {\n  const channelSchema=z.enum([\"retail\",\"subscription\",\"library\"]);\n  const now=()=>new Date().toISOString();",
  "export async function upsertRightsContract(db: CatalogDB, raw: unknown) {"
);
assert.equal(digest(privateBody),expectedSourceHash,
  "Owner-only SQL and business behavior must remain exactly equivalent to the reviewed legacy implementation");
assert.ok(!owner.includes('import {upsertRightsContract,upsertRightsGrant}'),"No direct legacy contract writer import");
assert.ok(owner.includes("await upsertRightsContractPrivate(db, {"),"Materializer must use owner-private writer");
assert.equal((owner.match(/async function upsertRightsContractPrivate\(/g)||[]).length,1);
const bodyStart=shared.indexOf("export async function upsertRightsContract("),
  bodyEnd=shared.indexOf("\nfunction languageSetForConflict(",bodyStart);
assert.ok(bodyStart>=0&&bodyEnd>bodyStart);
const body=shared.slice(bodyStart,bodyEnd);
assert.ok(body.includes("throw new ApiError(503,"));
assert.ok(!/\.prepare\(|\.batch\(|\.run\(/.test(body),
  "Shared rights contract must never issue protected SQL");
assert.equal(review.sites.filter(x=>x.file==="src/features/fore/rights.server.ts"&&x.functionName==="upsertRightsContract").length,0);
assert.equal(review.sites.filter(x=>x.disposition==="owner-command-required").length,377);
assert.equal(review.releaseApproval,false,"No production activation from source retirement");
console.log("PASS: private rights contract parity, no shared writer fallback, 377 owner-required audit sites and blocked release");
