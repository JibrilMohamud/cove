/* eslint-disable prettier/prettier -- Intentionally compact topology assertions. */
import {test} from "node:test";
import assert from "node:assert/strict";
import {assessProductionCutover,coversPublicWww,PRODUCTION_D1} from "./check-live-production-cutover.mjs";

const healthyBackend={bindings:[{name:"DB",type:"d1",id:PRODUCTION_D1}]};
const caseData={canonicalCandidates:458,backend:healthyBackend,frontend:null,owner:null,
  routes:[],domains:[{hostname:"api.covereads.com",service:"cove-persistence-backend"}],
  publicOrigin:{server:"Vercel"}};

test("mainline blocked state remains safe but never earns a certificate",()=>{
  const r=assessProductionCutover(caseData);
  assert.equal(r.safeToMaintainCurrentRoute,true);
  assert.equal(r.certifiedForOwnerOnlyCutover,false);
  assert.equal(r.evidence.publicWorkerAttached,false);
  assert.match(r.blocks.join(" " ),/458 unverified/);
  assert.match(r.blocks.join(" "),/LEGAL_AUTHORITY/);
});

test("detects accidental public Worker route while writes remain unverified",()=>{
  const r=assessProductionCutover({...caseData,routes:[{pattern:"www.covereads.com/*",script:"cove"}]});
  assert.equal(r.safeToMaintainCurrentRoute,false);
  assert.match(r.failures.join(" "),/unsafe public Cloudflare SSR cutover/);
});

test("detects accidental public custom domain without owner",()=>{
  const r=assessProductionCutover({...caseData,
    domains:[{hostname:"www.covereads.com",service:"cove"}]});
  assert.equal(r.safeToMaintainCurrentRoute,false);
});

test("rejects exact QA database or service even when no public route",()=>{
  const r=assessProductionCutover({...caseData,
    backend:{bindings:[{name:"DB",type:"d1",id:"5e3a6b69-6f3d-4b19-b837-01f7aa56ce87"},
      {name:"LEGAL_AUTHORITY",type:"service",service:"cove-legal-authority-private-qa-example"}]}});
  assert.equal(r.safeToMaintainCurrentRoute,false);
  assert.match(r.failures.join(" "),/synthetic QA/);
});

test("correct production owner does not override unresolved writers or rollout checks",()=>{
  const r=assessProductionCutover({...caseData,
    backend:{bindings:[...healthyBackend.bindings,
      {name:"LEGAL_AUTHORITY",type:"service",service:"cove-legal-authority-production"}]},
    owner:{bindings:[]},canonicalCandidates:0});
  assert.equal(r.safeToMaintainCurrentRoute,true);
  assert.equal(r.certifiedForOwnerOnlyCutover,false);
  assert.match(r.blocks.join(" "),/rollback rehearsal/);
});

test("route matching only covers public homepage",()=>{
  assert.equal(coversPublicWww("api.covereads.com/*"),false);
  assert.equal(coversPublicWww("www.covereads.com/books/*"),true);
  assert.equal(coversPublicWww("*.covereads.com/*"),true);
  assert.equal(coversPublicWww("*covereads.com/*"),true);
});

test("exact production namespace is bound even when Cloudflare omits script_name",()=>{
  const binding={name:"LEGAL_AUTHORITY",type:"durable_object_namespace",
    namespace_id:"83d7eadf3957436389a7b072120a9829",class_name:"CoveLegalAuthority"};
  const data={...caseData,backend:{bindings:[...healthyBackend.bindings,binding]},
    owner:{bindings:[{name:"COVE_RIGHTS_OWNER_ENABLED",type:"plain_text",text:"0"}]}};
  const r=assessProductionCutover(data);
  assert.equal(r.safeToMaintainCurrentRoute,true);
  assert.equal(r.evidence.productionOwnerBound,true);
  assert.equal(r.evidence.productionOwnerEnabled,false);
  assert.match(r.blocks.join(" "),/owner remains disabled/);
  assert.equal(r.certifiedForOwnerOnlyCutover,false);
  for(const change of [{namespace_id:"qa"},{class_name:"Other"},{script_name:"qa"}]) {
    assert.equal(assessProductionCutover({...data,backend:{bindings:[...healthyBackend.bindings,
      {...binding,...change}]}}).safeToMaintainCurrentRoute,false);
  }
  assert.equal(assessProductionCutover({...data,owner:{bindings:[
    {name:"COVE_RIGHTS_OWNER_ENABLED",type:"plain_text",text:"1"}]}}).safeToMaintainCurrentRoute,false);
});

