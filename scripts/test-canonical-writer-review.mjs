/* eslint-disable prettier/prettier -- Classification must not erase the release blocker or silently approve changed SQL. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {assertPrivateSettlementSourceBoundary} from "./owner-settlement-source-boundary.mjs";
import {assertFrozenExceptionLineage} from "./canonical-writer-exception-lineage.mjs";
import {currentWriterSites,identifyWriterSites,reconcileWriterSites,REVIEW_PATH} from "./reconcile-canonical-writers.mjs";

const review=JSON.parse(readFileSync(REVIEW_PATH,"utf8"));
const current=currentWriterSites();
const result=reconcileWriterSites(current,review);
assert.deepEqual(result.unknown,[]);assert.deepEqual(result.stale,[]);
// Live migration is monotonic: actually removed owner-required SQL can
// reduce these numbers, but a new writer or a changed SQL literal still fails
// exact source review and the independently frozen classification lineage.
assert.ok(current.length<=483,"New canonical SQL cannot expand the reviewed source inventory");
assert.ok(new Set(current.map(x=>x.file)).size<=29,
  "New source files with protected SQL require a separate reviewed architecture decision");
assert.equal(current.filter(x=>x.literal).length,current.length,
  "Every remaining scanner candidate must be an inspectable SQL literal");
const counts={};for(const x of review.sites)counts[x.disposition]=(counts[x.disposition]||0)+1;
assert.ok((counts["owner-command-required"]||0)<=426,"Open protected writer count increased");
assert.ok((counts["non-authorizing-write"]||0)<=33,"Nonauthorizing exception count increased");
assert.ok((counts["private-owner-qa-executor"]||0)<=23,"Private QA exception count increased");
assert.ok((counts["isolated-test-fixture"]||0)<=1,"Test fixture exception count increased");
assert.equal(Object.values(counts).reduce((a,b)=>a+b,0),current.length);
assert.equal(assertFrozenExceptionLineage(review.sites),true);
const versionEvents=review.sites.filter(x=>x.table==="publishing_owner_version_events");
assert.ok(versionEvents.length<=5);
assert.ok(versionEvents.filter(x=>x.disposition==="owner-command-required").length<=2);
assert.ok(versionEvents.filter(x=>x.disposition==="non-authorizing-write").length<=2);
const allAudioPlayback=review.sites.filter(x=>x.table==="commercial_audio_playback");
assert.ok(allAudioPlayback.length<=6);
assert.ok(allAudioPlayback.every(x=>x.disposition==="non-authorizing-write"&&x.productionOwnerGuarded===false));
const legalHistory=review.sites.filter(x=>["publishing_lifecycle_events","publication_version_distribution_events"].includes(x.table));
assert.ok(legalHistory.length<=10);
assert.ok(legalHistory.filter(x=>x.disposition==="owner-command-required").length<=9);
assert.ok(legalHistory.filter(x=>x.disposition==="non-authorizing-write").length<=1);
assert.ok(legalHistory.every(x=>x.productionOwnerGuarded===false));
const playback=review.sites.filter(x=>x.file==="src/features/fore/sync.server.ts"&&x.table==="commercial_audio_playback");
assert.ok(playback.length<=3);
assert.ok(playback.every(x=>x.disposition==="non-authorizing-write"&&x.productionOwnerGuarded===false));
const priority=["publishing.server.ts","commerce.server.ts","publishing-trust.server.ts","traditional-publishing.server.ts"];
assert.ok(current.filter(x=>priority.some(name=>x.file.endsWith("/"+name))).length<=260);
assert.ok(review.sites.every(x=>x.productionOwnerGuarded===false));
const fixture=review.sites.filter(x=>x.disposition==="isolated-test-fixture");
assert.ok(fixture.every(x=>x.file==="scripts/browser-qa-server.mjs"));

const file="src/features/fore/example.server.ts";
const original='export async function authenticate(db) { await db.prepare("UPDATE publisher_partner_credentials SET last_used_at=? WHERE id=?").run(); }';
const findings=[{file,line:1,table:"publisher_partner_credentials",operation:"UPDATE",domain:"publication_rights"}];
const old=identifyWriterSites(findings,()=>original)[0];
const recorded={schema:review.schema,releaseApproval:false,sites:[{
  ...old,disposition:"non-authorizing-write",productionOwnerGuarded:false,
  reason:"This exact update only records credential activity telemetry."
}]};
assert.deepEqual(reconcileWriterSites([old],recorded).unknown,[]);
// Same file, table, operation and total count: the old count baseline accepts
// this change, but a telemetry exemption must NEVER cover a status grant.
const changed=identifyWriterSites(findings,()=>original.replace("last_used_at=?","status='active'"));
assert.equal(reconcileWriterSites(changed,recorded).unknown.length,1);
assert.equal(reconcileWriterSites(changed,recorded).stale.length,1);
const renamed=identifyWriterSites(findings,()=>original.replace("function authenticate","function grantCredential"));
assert.equal(reconcileWriterSites(renamed,recorded).unknown.length,1);
const changedCaller=identifyWriterSites(findings,()=>original.replace("authenticate(db)","authenticate(productionDb)")
  .replace("await db.prepare","await productionDb.prepare"));
assert.equal(reconcileWriterSites(changedCaller,recorded).unknown.length,1,
  "Unchanged SQL must be reviewed again if its database/caller context changes");
const duplicate=identifyWriterSites([...findings,...findings],()=>original+"\n"+original);
assert.notEqual(duplicate[0].siteId,duplicate[1].siteId);
assert.throws(()=>reconcileWriterSites(current,{...review,sites:[...review.sites,review.sites[0]]}),/Duplicate/);
assert.throws(()=>reconcileWriterSites(current,{...review,releaseApproval:true}));
assert.throws(()=>reconcileWriterSites(current,{...review,sites:[{...review.sites[0],productionOwnerGuarded:true}]}),
  /cannot assert deployed production ownership/);
const release=spawnSync(process.execPath,["scripts/check-canonical-writer-closure.mjs","--release-gate"],{encoding:"utf8"});
assert.equal(release.status,1,"Reviewed classification must not open the owner-only release gate");
const syntheticBoundary=new Map([
  ["src/features/fore/paid-settlement-transaction.server.ts","export function transaction() {}"],
  ["src/storefront-strangler/paid-settlement-owner-executor.ts",'import {transaction} from "../features/fore/paid-settlement-transaction.server";'],
  ["src/storefront-strangler/legal-authority.worker.ts",'import "./paid-settlement-owner-executor"; import "./publication-materialization-command"; import "./refund-reservation-owner-executor";'],
  ["src/storefront-strangler/publication-materialization-command.ts","export function publication() {}"],
  ["src/storefront-strangler/refund-reservation-owner-executor.ts","export function reserve() {}"],
]);
assert.equal(assertPrivateSettlementSourceBoundary(syntheticBoundary),true);
for(const declaration of ['import "./paid-settlement-transaction.server";','export * from "./paid-settlement-transaction.server";','const x=import("./paid-settlement-transaction.server");'])
  assert.throws(()=>assertPrivateSettlementSourceBoundary(new Map([...syntheticBoundary,["src/features/fore/rogue.server.ts",declaration]])),/Non-owner runtime importer/);
// Zero live owner-required SQL is the intended terminal state. The negative
// laundering tests must still use a genuinely historical protected row, not
// assume the source inventory contains an unresolved authorizing writer.
const retired=JSON.parse(readFileSync("docs/architecture/retired-catalog-source-ingest-owner-lineage.json","utf8"));
const legacy=review.sites.find(x=>x.disposition==="owner-command-required")||retired.retired[0];
assert.equal(legacy.disposition,"owner-command-required");
const oldReview=review.sites.includes(legacy)?review.sites:[...review.sites,legacy];
const another=review.sites.find(x=>x.disposition==="non-authorizing-write");
assert.ok(another,"A reviewed telemetry exception is necessary for mutation testing");
assert.throws(()=>assertFrozenExceptionLineage(
  oldReview.map(x=>x===legacy?{...x,disposition:"non-authorizing-write"}:x)),/New or laundered/,
  "An unresolved production SQL statement cannot become nonauthorizing just to improve the metric");
assert.throws(()=>assertFrozenExceptionLineage(
  oldReview.map(x=>x===legacy?{...x,disposition:"private-owner-qa-executor"}:x)),/New or laundered/,
  "An unresolved production SQL statement cannot be laundered into an owner QA executor");
assert.throws(()=>assertFrozenExceptionLineage([...review.sites,another]),/New or laundered/,
  "Duplicate previously reviewed exceptions cannot bypass frozen multiplicities");
const withoutOne=review.sites.filter(x=>x!==review.sites[0]);
assert.equal(assertFrozenExceptionLineage(withoutOne),true,
  "A genuinely deleted source SQL site may lower the open count");
assert.equal(reconcileWriterSites(current,{...review,sites:withoutOne}).unknown.length,1,
  "The active source must still prevent deleting a review row without removing its SQL");
assert.throws(()=>reconcileWriterSites(current,{
  ...review,sites:oldReview.map(x=>x===legacy?{...x,disposition:"private-owner-qa-executor"}:x)
}),/cannot erase legacy/);
console.log("PASS: "+current.length+" exact SQL sites reconciled; "+(counts["owner-command-required"]||0)+" owner-required; frozen exception lineage prevents reclassification; source edits invalidate review; production release still denied");
