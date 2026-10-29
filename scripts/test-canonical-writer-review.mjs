/* eslint-disable prettier/prettier -- Classification must not erase the release blocker or silently approve changed SQL. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {currentWriterSites,identifyWriterSites,reconcileWriterSites,REVIEW_PATH} from "./reconcile-canonical-writers.mjs";

const review=JSON.parse(readFileSync(REVIEW_PATH,"utf8"));
const current=currentWriterSites();
const result=reconcileWriterSites(current,review);
assert.deepEqual(result.unknown,[]);assert.deepEqual(result.stale,[]);
assert.equal(current.length,460);
assert.equal(new Set(current.map(x=>x.file)).size,26);
assert.equal(current.filter(x=>x.literal).length,460,
  "All existing scan candidates are executable SQL literals; only the isolated fixture is outside deployed production");
const counts={};for(const x of review.sites)counts[x.disposition]=(counts[x.disposition]||0)+1;
assert.deepEqual(counts,{"isolated-test-fixture":1,"owner-command-required":422,"non-authorizing-write":37});
const legalHistory=review.sites.filter(x=>["publishing_lifecycle_events","publication_version_distribution_events"].includes(x.table));
assert.equal(legalHistory.length,10);
assert.ok(legalHistory.every(x=>x.disposition==="non-authorizing-write"&&x.productionOwnerGuarded===false));
const playback=review.sites.filter(x=>x.file==="src/features/fore/sync.server.ts"&&x.table==="commercial_audio_playback");
assert.equal(playback.length,3);
assert.ok(playback.every(x=>x.disposition==="non-authorizing-write"&&x.productionOwnerGuarded===false));
const priority=["publishing.server.ts","commerce.server.ts","publishing-trust.server.ts","traditional-publishing.server.ts"];
assert.equal(current.filter(x=>priority.some(name=>x.file.endsWith("/"+name))).length,260);
assert.ok(review.sites.every(x=>x.productionOwnerGuarded===false));
const fixture=review.sites.filter(x=>x.disposition==="isolated-test-fixture");
assert.equal(fixture[0].file,"scripts/browser-qa-server.mjs");

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
console.log("PASS: all 460 sites reconciled; 260 priority-file candidates; semantic SQL edits invalidate review; production release still denied");
