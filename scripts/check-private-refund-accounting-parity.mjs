/* eslint-disable prettier/prettier -- Exact financial source parity is a release-safety invariant. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import ts from "typescript";
const read=p=>readFileSync(p,"utf8");
const legacy=read("src/features/fore/refund-accounting.server.ts");
const owner=read("src/storefront-strangler/legal-authority.worker.ts");
const executor=read("src/storefront-strangler/refund-accounting-owner-executor.ts");
const commerce=read("src/features/fore/commerce.server.ts");
const parse=(path,text)=>ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true);
for(const [path,text] of [["legacy",legacy],["private owner",owner],["executor",executor]])
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
assert.match(commerce,/await postRefundAccounting\(db, refundId, at, false\)/,
 "Legacy production refund posting must remain live until a separately certified production owner cutover.");
assert.match(commerce,/await postStageOwnerRefundAccounting\(env, String\(o\.id\), refundId\)/);
console.log("PASS: private legal owner refund batch is byte-for-byte equivalent to existing live source, with independent callback and no changed production refund behavior; rollout remains blocked.");
