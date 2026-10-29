/* eslint-disable prettier/prettier -- Workflow-level source evidence never certifies deployed ownership. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {currentWriterSites,reconcileWriterSites,REVIEW_PATH} from "./reconcile-canonical-writers.mjs";

export const WORKFLOW_SCHEMA="cove.canonical-workflow-inventory.v1";
export const workflowId=name=>{
  assert.match(name,/^[a-z][a-z0-9-]*\\.[a-zA-Z][a-zA-Z0-9_-]*$/);
  // Stable across unrelated changes to a large source file; not a permission.
  return createHash("sha256").update("cove-owner-command:"+name).digest("hex").slice(0,24);
};
const alphabetical=(a,b)=>a.localeCompare(b,"en");
const sorted=items=>[...items].sort(alphabetical);
export function buildWorkflowInventory(review,sites) {
  const checked=reconcileWriterSites(sites,review);
  assert.deepEqual(checked.unknown,[],"Unreviewed SQL requires independent review");
  assert.deepEqual(checked.stale,[],"Stale SQL review requires reconciliation");
  const counts={"owner-command-required":0,"non-authorizing-write":0,"isolated-test-fixture":0};
  const families=new Map(),byFile=new Map();
  for(const {review:row,...site} of checked.rows) {
    assert.ok(row,"Missing reviewed mutation");
    assert.equal(row.productionOwnerGuarded,false,
      "Source review cannot claim deployed production owner fencing");
    counts[row.disposition]++;
    const file=byFile.get(site.file)||{file:site.file,total:0,ownerRequired:0};
    file.total++;
    if(row.disposition==="owner-command-required") {
      file.ownerRequired++;
      const name=row.commandFamily;
      assert.equal(typeof name,"string");
      const existing=families.get(name)||{
        name,workflowId:workflowId(name),siteIds:new Set(),
        files:new Set(),tables:new Set(),operations:new Set()
      };
      assert.ok(!existing.siteIds.has(site.siteId),"Duplicate reviewed SQL site");
      existing.siteIds.add(site.siteId);
      existing.files.add(site.file);
      existing.tables.add(site.table);
      existing.operations.add(site.operation);
      families.set(name,existing);
    }
    byFile.set(site.file,file);
  }
  const workflows=[...families.values()].map(f=>({
    name:f.name,workflowId:f.workflowId,ownerRequiredSites:f.siteIds.size,
    files:sorted(f.files),tables:sorted(f.tables),operations:sorted(f.operations),
    productionStatus:"unverified",authorizationBoundary:"owner-command-required"
  })).sort((a,b)=>b.ownerRequiredSites-a.ownerRequiredSites||alphabetical(a.name,b.name));
  assert.equal(new Set(workflows.map(w=>w.workflowId)).size,workflows.length,
    "Command-family identifier collision");
  assert.equal(workflows.reduce((n,w)=>n+w.ownerRequiredSites,0),
    counts["owner-command-required"]);
  return {
    schema:WORKFLOW_SCHEMA,sourceReviewSchema:review.schema,
    productionReleaseEligible:false,productionOwnerCertified:false,
    observedRuntimeWriterBypasses:null,
    metrics:{
      scannedSqlSites:sites.length,
      ownerRequiredSqlSites:counts["owner-command-required"],
      classifiedNonAuthorizingSqlSites:counts["non-authorizing-write"],
      isolatedFixtureSqlSites:counts["isolated-test-fixture"],
      recordedCommandFamilies:workflows.length,
      productionCertifiedCommandFamilies:0
    },
    files:[...byFile.values()].sort((a,b)=>b.ownerRequired-a.ownerRequired||alphabetical(a.file,b.file)),
    workflows,
    limits:[
      "Command-family labels are review annotations, not proof of shared call graphs.",
      "Static SQL scanning cannot observe generated SQL, deployed historic workers, external jobs, service credentials or direct operator access.",
      "A successful source-only workflow inventory never authorizes owner-only deployment."
    ]
  };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const review=JSON.parse(readFileSync(REVIEW_PATH,"utf8"));
  const inventory=buildWorkflowInventory(review,currentWriterSites());
  const output=process.env.COVE_WORKFLOW_AUDIT_OUTPUT;
  if(output) {
    const target=resolve(output);mkdirSync(dirname(target),{recursive:true});
    writeFileSync(target,JSON.stringify(inventory,null,2)+String.fromCharCode(10),{mode:0o600});
  }
  const m=inventory.metrics;
  console.log("Workflow audit: "+m.ownerRequiredSqlSites+" owner-required SQL sites across "+
    m.recordedCommandFamilies+" recorded command families; "+m.productionCertifiedCommandFamilies+
    " independently certified in production.");
  console.log("BLOCKED: grouping and static classification cannot certify deployed writer ownership.");
  if(process.argv.includes("--release-gate"))process.exitCode=1;
}
