/* eslint-disable prettier/prettier -- Exact financial source parity is a release-safety invariant. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import ts from "typescript";
const read=p=>readFileSync(p,"utf8");
const legacy=read("scripts/test-refund-accounting-legacy-source.ts");
const retired=read("src/features/fore/refund-accounting.server.ts");
const owner=read("src/storefront-strangler/legal-authority.worker.ts");
const executor=read("src/storefront-strangler/refund-accounting-owner-executor.ts");
const commerce=read("src/features/fore/commerce.server.ts");
const parse=(path,text)=>ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true);
for(const [path,text] of [["historical fixture",legacy],["retired shared module",retired],["private owner",owner],["executor",executor]])
 assert.equal(parse(path+".ts",text).parseDiagnostics.length,0,path+" must parse");
const originalStart=legacy.indexOf("type RefundRecord=");
const ownerStart=owner.indexOf("type RefundRecord=");
const ownerStop=owner.indexOf("/* eslint-enable @typescript-eslint/no-explicit-any */",ownerStart);
assert.ok(originalStart>=0&&ownerStart>=0&&ownerStop>ownerStart);
const original=legacy.slice(originalStart).trim();
const physical=owner.slice(ownerStart,ownerStop).trim()
  .replace("async function postRefundAccountingPrivate(", "export async function postRefundAccounting(");
assert.equal(physical,original,
 "Any change to active legacy refund posting must be consciously mirrored and tested in private owner; do not independently drift refund ledger, tender restoration or idempotent markers.");
assert.match(owner,/async function postRefundAccountingPrivate\(/);
assert.doesNotMatch(executor,/from ["']\.\.\/features\/fore\/refund-accounting\.server/);
assert.match(executor,/await post\(db,x\.refundId,at,true\)/);
assert.match(owner,/executeOwnerRefundAccounting\(env\.PRIMARY_DB,sql,raw,postRefundAccountingPrivate\)/);
assert.match(retired,/throw new ApiError\(503/,"Retired D1 writer must fail closed");
assert.doesNotMatch(retired,/INSERT INTO|UPDATE commerce_|UPDATE entitlements|UPDATE preorders/,
 "No canonical refund mutation may remain in shared module");
assert.match(commerce,/if \(env\.COVE_LEGAL_CONSUMER_STAGE_ENABLED !== "1"\)\s*throw new ApiError\(503, "Refunds require the private financial owner\."\)/,
 "Legacy refund route must reject owner-disabled calls BEFORE contacting Stripe");
const guard=commerce.indexOf('export async function refundOrder(');
const firstProvider=commerce.indexOf('const existing = await db',guard);
const denial=commerce.indexOf('throw new ApiError(503, "Refunds require the private financial owner.");',guard);
assert.ok(denial>guard&&denial<firstProvider,
 "Owner-disabled refund rejection must precede all legacy invoice/provider operations");
assert.match(commerce,/await postStageOwnerRefundAccounting\(env, String\(o\.id\), refundId\)/);
console.log("PASS: 11 shared-D1 refund posting statements retired; exact frozen legacy finance batch remains private-owner parity tested; owner-disabled refund rejects before provider writes.");
