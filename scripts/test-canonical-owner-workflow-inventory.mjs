/* eslint-disable prettier/prettier -- Fail closed on forged or unreviewed SQL classifications. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {currentWriterSites,REVIEW_PATH} from "./reconcile-canonical-writers.mjs";
import {buildWorkflowInventory,workflowId,WORKFLOW_SCHEMA} from "./canonical-owner-workflow-inventory.mjs";

const review=JSON.parse(readFileSync(REVIEW_PATH,"utf8"));
const sites=currentWriterSites();
const report=buildWorkflowInventory(review,sites);
const a=report.metrics;
assert.equal(report.schema,WORKFLOW_SCHEMA);
assert.equal(a.scannedSqlSites,review.sites.length);
assert.equal(a.ownerRequiredSqlSites,review.sites.filter(x=>x.disposition==="owner-command-required").length);
assert.equal(a.classifiedNonAuthorizingSqlSites,review.sites.filter(x=>x.disposition==="non-authorizing-write").length);
assert.equal(a.isolatedFixtureSqlSites,review.sites.filter(x=>x.disposition==="isolated-test-fixture").length);
assert.equal(a.ownerRequiredSqlSites+a.classifiedNonAuthorizingSqlSites+a.isolatedFixtureSqlSites+a.privateOwnerQaExecutorSqlSites,a.scannedSqlSites);
assert.equal(a.recordedCommandFamilies,new Set(review.sites.filter(x=>x.commandFamily&&x.disposition==="owner-command-required").map(x=>x.commandFamily)).size);
assert.equal(report.workflows.reduce((n,x)=>n+x.ownerRequiredSites,0),a.ownerRequiredSqlSites);
assert.equal(report.productionReleaseEligible,false);
assert.equal(report.productionOwnerCertified,false);
assert.equal(report.observedRuntimeWriterBypasses,null);
assert.equal(a.productionCertifiedCommandFamilies,0);
assert.ok(!report.workflows.some(x=>x.name==="publication.materialize"),
  "A new private QA executor must not be reported as a production writer family");
assert.ok(report.workflows.every(x=>x.productionStatus==="unverified"));
assert.ok(report.workflows.every(x=>x.files.length&&x.tables.length));
assert.equal(workflowId("commerce.postRefundAccounting"),workflowId("commerce.postRefundAccounting"));
assert.notEqual(workflowId("commerce.postRefundAccounting"),workflowId("commerce.finalizePaidOrder"));
assert.deepEqual(report,buildWorkflowInventory(review,sites),"Report must be deterministic");
const edited={...review,sites:review.sites.slice(1)};
assert.throws(()=>buildWorkflowInventory(edited,sites),/Unreviewed SQL|Stale SQL/);
const invented=[...sites,{...sites[0],siteId:"new-unreviewed-site"}];
assert.throws(()=>buildWorkflowInventory(review,invented),/Unreviewed SQL/);
// A zero-open-writer source inventory must still reject forged production certification.
const grant=review.sites.find(x=>x.disposition==="owner-command-required")||review.sites[0];
assert.ok(grant);
const forged={...review,sites:review.sites.map(x=>x.siteId===grant.siteId?{...x,productionOwnerGuarded:true}:x)};
assert.throws(()=>buildWorkflowInventory(forged,sites),/cannot assert deployed production ownership/);
console.log("PASS: source-bound workflow aggregation is deterministic; none falsely production-certified; release denial independent");
