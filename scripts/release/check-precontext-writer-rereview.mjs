/* eslint-disable prettier/prettier -- Exact, source-bound independent legal writer review, not release approval. */
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {currentWriterSites,reconcileWriterSites} from "../reconcile-canonical-writers.mjs";

const BASE="c25fa51c2e380428cd91a045d458574160b5dead";
const SOURCE="src/features/fore/api.server.ts";
const REVIEW="docs/architecture/canonical-writer-review.json";
const HELPER="  // Fixed, request-local numeric markers only. Never serialize the error,\n  // request identity, SQL, headers or input into diagnostics.\n  async function observedPreContext<T>(\n    name: \"legal\" | \"auth\" | \"identity\",\n    run: () => Promise<T>,\n  ): Promise<T> {\n    try {\n      return await run();\n    } catch (error) {\n      timings[`fault_pre_${name}`] = 1;\n      throw error;\n    }\n  }\n";
const PATCHES=[
  [
    "    const legalResponse = await observedPreContext(\"legal\", () =>\n      handleLegalContact(request, env, path),\n    );",
    "    const legalResponse = await handleLegalContact(request, env, path);"
  ],
  [
    "    const authResponse = await observedPreContext(\"auth\", () => auth.handle(path));",
    "    const authResponse = await auth.handle(path);"
  ],
  [
    "    await observedPreContext(\"identity\", () => auth.identify());",
    "    await auth.identify();"
  ],
  [
    "    const machineDb = (() => {\n      try {\n        return database(env);\n      } catch (error) {\n        timings.fault_pre_database = 1;\n        throw error;\n      }\n    })();",
    "    const machineDb = database(env);"
  ]
];

const originalFile=execFileSync("git",["show",BASE+":"+SOURCE],{
  encoding:"utf8",maxBuffer:1024*1024,
});
const candidate=readFileSync(SOURCE,"utf8");
// The October owner migration deliberately removes the 33 historical API
// canonical writers. The old diagnostic-only proof (below) cannot claim this
// API file is unchanged. Admit ONLY the independently pinned integrated source
// bytes, and require an exact zero-authorizing-site review plus all four
// precontext diagnostics. Any further code edit requires a new source review;
// neither path is production release approval.
// Re-reviewed 2026-11-23: guest-only single-snapshot/R2 deferral; zero protected
// API SQL writers, original four precontext denial markers unchanged.
const INTEGRATED_API_SHA256="ba30108f629d7e8c6c488ac34f831ce1f36814f96c4c4f9c0763418db78ed262";
if(createHash("sha256").update(candidate).digest("hex")===INTEGRATED_API_SHA256){
  assert.ok(candidate.includes(HELPER),"Integrated API lost bounded diagnostic helper");
  for(const [added] of PATCHES)
    assert.ok(candidate.includes(added),"Integrated API lost a reviewed precontext marker");
  const integratedReview=JSON.parse(readFileSync(REVIEW,"utf8"));
  assert.equal(integratedReview.releaseApproval,false);
  const integratedSites=currentWriterSites();
  const integratedResult=reconcileWriterSites(integratedSites,integratedReview);
  assert.deepEqual(integratedResult.unknown,[],"Integrated source contains unreviewed protected SQL");
  assert.deepEqual(integratedResult.stale,[],"Reviewed integrated SQL sites drifted");
  assert.equal(integratedSites.filter(x=>x.file===SOURCE).length,0,
    "Integrated API must have no remaining protected source SQL");
  assert.equal(integratedReview.sites.filter(x=>x.disposition==="owner-command-required").length,0,
    "Owner migration cannot leave direct protected source writers");
  assert.ok(integratedReview.sites.every(x=>x.productionOwnerGuarded===false),
    "A source proof cannot claim physical production ownership");
  console.log("PASS: exact pinned migrated API, zero owner-required source SQL, and unchanged bounded precontext diagnostics; deployed authority still NO-GO.");
  process.exit(0);
}
function exactReplaceOnce(haystack,needle,replacement) {
  assert.ok(needle.length>0&&haystack.split(needle).length===2,
    "Expected one and only one reviewed diagnostic insertion");
  return haystack.replace(needle,replacement);
}
let reconstructed=exactReplaceOnce(candidate,HELPER,"");
for(const [added,replaced] of PATCHES)
  reconstructed=exactReplaceOnce(reconstructed,added,replaced);
assert.equal(reconstructed,originalFile,
  "Legal SQL source, authorization guards, and every other line must be byte-exact main");

const previous=JSON.parse(execFileSync("git",["show",BASE+":"+REVIEW],{
  encoding:"utf8",maxBuffer:1024*1024,
}));
const reviewed=JSON.parse(readFileSync(REVIEW,"utf8"));
assert.equal(reviewed.releaseApproval,false);
assert.equal(previous.releaseApproval,false);
assert.equal(previous.schema,reviewed.schema);
assert.equal(previous.reviewedSourceCommit,reviewed.reviewedSourceCommit);
assert.equal(previous.scope,reviewed.scope);
assert.equal(previous.sites.length,reviewed.sites.length);

const key=x=>JSON.stringify([x.file,x.functionName,x.table,x.operation,x.sqlSha256]);
const oldFile=previous.sites.filter(x=>x.file===SOURCE);
const newFile=reviewed.sites.filter(x=>x.file===SOURCE);
assert.equal(oldFile.length,33,"Existing canonical SQL site count must not drift");
assert.equal(newFile.length,33,"Exact same set of mandatory owner-only writers");
const oldBy=new Map(oldFile.map(x=>[key(x),x]));
const newBy=new Map(newFile.map(x=>[key(x),x]));
assert.equal(oldBy.size,33);
assert.equal(newBy.size,33);
for(const [siteKey,old] of oldBy) {
  const next=newBy.get(siteKey);
  assert.ok(next,"Original SQL/function identity must have one new review");
  const {siteId:oldId,line:oldLine,...oldStable}=old;
  const {siteId:newId,line:newLine,...newStable}=next;
  assert.deepEqual(newStable,oldStable,"No change to writer disposition, reason or owner guard");
  assert.equal(next.disposition,"owner-command-required");
  assert.equal(next.productionOwnerGuarded,false);
  assert.ok(next.commandFamily && next.reason?.length>20);
  assert.ok(oldId!==newId,"File hash change must invalidate original site identity");
  assert.ok(Number.isInteger(newLine) && newLine>=oldLine);
}
// A separately source-attested EPUB quarantine guard was added after this
// pre-context review baseline. Verify the exact *same four* preexisting SQL
// literals are still owner-command-required; never approve altered SQL or any
// other unrelated review by treating a changed file hash as authority.
const EPUB="src/features/fore/regional-epub-asset-repair.server.ts";
const ATTEST="docs/architecture/au-epub-history-quarantine-source-attestation-20261122.json";
const receipt=JSON.parse(readFileSync(ATTEST,"utf8"));
assert.equal(receipt.schema,"cove.canonical-writer-source-attestation.v1");
assert.equal(receipt.releaseApproval,false);
assert.equal(receipt.files.length,1);
assert.equal(receipt.files[0].path,EPUB);
const sourceHash=createHash("sha256").update(readFileSync(EPUB,"utf8")).digest("hex");
assert.equal(sourceHash,receipt.files[0].sha256,"Unattested EPUB source change denied");
const inventory=currentWriterSites();
const activeByKey=new Map(inventory.filter(x=>x.file===EPUB).map(x=>[key(x),x]));
const reviewedByKey=new Map(reviewed.sites.filter(x=>x.file===EPUB).map(x=>[key(x),x]));
const baselineEpub=previous.sites.filter(x=>x.file===EPUB);
assert.equal(baselineEpub.length,4,"EPUB SQL review count changed");
assert.equal(activeByKey.size,4,"EPUB SQL sites changed");
assert.equal(reviewedByKey.size,4,"EPUB reviewed writer count changed");
for(const old of previous.sites.filter(x=>x.file!==SOURCE)) {
  if(old.file!==EPUB) {
    const unchanged=reviewed.sites.find(x=>x.siteId===old.siteId);
    assert.deepEqual(unchanged,old,"No unrelated SQL review can be changed");
    continue;
  }
  const next=reviewedByKey.get(key(old)),active=activeByKey.get(key(old));
  assert.ok(next&&active,"Changed/removed EPUB SQL literal denied");
  const {siteId:before,line:priorLine,...beforeStable}=old;
  const {siteId:after,line:newLine,...afterStable}=next;
  assert.deepEqual(afterStable,beforeStable,"Unapproved EPUB SQL disposition change");
  assert.equal(next.disposition,"owner-command-required");
  assert.equal(next.productionOwnerGuarded,false);
  assert.equal(after,active.siteId,"EPUB review not bound to current source SHA");
  assert.equal(newLine,active.line,"EPUB line-number witness mismatch");
  assert.notEqual(before,after,"Source SHA change must invalidate old approval");
  assert.ok(newLine>priorLine,"Guard must precede EPUB writer sites");
}
const result=reconcileWriterSites(inventory,reviewed);
assert.equal(result.unknown.length,0,"Unknown source SQL still blocks release");
assert.equal(result.stale.length,0,"Old reviewed sites must be reconciled");
assert.equal(result.rows.length,reviewed.sites.length);
console.log("PASS: only reviewed numeric pre-context diagnostics added; all 33 original SQL bodies/guards unmodified, mandatory owner dispositions unchanged.");
console.log("BLOCKED: production legal owner, all outstanding authorizing SQL, and physical D1 principal remain uncertified.");
