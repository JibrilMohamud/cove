/* eslint-disable prettier/prettier -- Adversarial deployed-principal inventory proof. */
import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {
  CANONICAL_D1,OWNER_SCRIPT,assessDeployedCanonicalD1Principals,collectCanonicalD1Fleet,compareKnownUnsafeFleet
} from "./audit-live-canonical-d1-principals.mjs";
const owner={bindings:[
  {type:"d1",name:"PRIMARY_DB",id:CANONICAL_D1},
  {type:"plain_text",name:"COVE_RIGHTS_OWNER_ENABLED",text:"0"}
]};
const other={bindings:[
  {type:"d1",name:"SOURCE_DB",id:CANONICAL_D1},
  {type:"plain_text",name:"FORE_CONTENT_PROCESSOR_ENABLED",text:"1"},
  {type:"service",name:"ARCHIVE",service:"cove-archive"}
]};
const innocuous={bindings:[{type:"d1",name:"CONTENT_DB",id:"400c3af3-5d40-41fd-83cc-98228e40ddac"},
  {type:"service",name:"OTHER",service:"cove-disabled-qa"}]};
const params={
  scripts:[{id:OWNER_SCRIPT},{id:"cove-disabled-qa"},{id:"cove-customer-gateway"}],
  settingsByName:{
    [OWNER_SCRIPT]:owner,"cove-disabled-qa":other,"cove-customer-gateway":innocuous
  },
  schedulesByName:{[OWNER_SCRIPT]:[], "cove-disabled-qa":["* * * * *"]},
  subdomainsByName:{[OWNER_SCRIPT]:{enabled:false},"cove-disabled-qa":{enabled:false}},
  routes:[{script:"cove-disabled-qa",pattern:"qa.example.com/*"}],
  domains:[{service:"cove-disabled-qa",hostname:"test.example.com"}]
};
test("names cannot excuse enabled canonical D1 writers, schedule, ingress or service references",()=>{
  const report=assessDeployedCanonicalD1Principals(params);
  assert.equal(report.workerScriptsInspected,3);
  assert.equal(report.directCanonicalBindings,2);
  assert.equal(report.nonOwnerBindings,1);
  assert.equal(report.boundScriptsWithCrons,1);
  assert.equal(report.boundScriptsWithNetworkIngress,1);
  assert.equal(report.releaseEligible,false);
  assert.equal(report.ownerEnabled,false);
  assert.ok(report.blockerCodes.includes("non_owner_workers_retain_canonical_d1_binding"));
  assert.ok(report.blockerCodes.includes("non_owner_cron_can_use_canonical_d1"));
  assert.equal(report.principals[0].script,"cove-disabled-qa");
  assert.deepEqual(report.principals[0].modeFlags,[
    {name:"FORE_CONTENT_PROCESSOR_ENABLED",value:"1"}]);
  assert.deepEqual(report.principals[0].inboundServiceBindings,
    [{script:"cove-customer-gateway",binding:"OTHER"}]);
  assert.deepEqual(report.principals[0].customRoutes,["qa.example.com/*"]);
  assert.deepEqual(report.principals[0].customDomains,["test.example.com"]);
});
test("no synthetic or source-only configuration can self-certify deployment",()=>{
  const clean=assessDeployedCanonicalD1Principals({
    scripts:[{id:OWNER_SCRIPT}],settingsByName:{
      [OWNER_SCRIPT]:{bindings:[
        {name:"PRIMARY_DB",type:"d1",id:CANONICAL_D1},
        {name:"COVE_RIGHTS_OWNER_ENABLED",type:"plain_text",text:"1"}]}
    },schedulesByName:{[OWNER_SCRIPT]:[]},
    subdomainsByName:{[OWNER_SCRIPT]:{enabled:false}}
  });
  assert.equal(clean.nonOwnerBindings,0);
  assert.deepEqual(clean.blockerCodes,[]);
  assert.equal(clean.releaseEligible,false);
  assert.equal(clean.productionAuthorized,false);
  assert.equal(clean.independentDeploymentAuthorizationRequired,true);
});
test("43 retired captures never regain production D1 or restart, and 14-binding unsafe baseline is pinned",()=>{
  const retired=JSON.parse(readFileSync("docs/architecture/historical-publication-capture-d1-isolation-20261029.json","utf8"));
  const baseline=JSON.parse(readFileSync("docs/architecture/deployed-canonical-d1-baseline.json","utf8"));
  assert.equal(retired.scripts.length,43);
  assert.equal(baseline.knownDirectBindings.length,12);
  assert.equal(baseline.retirementEvidence.totalBindingsRemoved,45);
  assert.equal(baseline.retirementEvidence.remainingNonOwnerBindings,11);
  assert.equal(baseline.certified,false);
  assert.equal(baseline.retirementEvidence.historicalCaptureBindingsRemoved,43);
  for(const name of retired.scripts)assert.ok(
    !baseline.knownDirectBindings.some(x=>x.script===name),
    "retired capture cannot survive in remaining unsafe D1 allowlist: "+name);
  const name=retired.scripts[0];
  const settings={bindings:[
    {name:"COVE_PUBLICATION_CAPTURE_ENABLED",type:"plain_text",text:"0"},
    {name:"PUBLIC_SOURCE_DB",type:"d1",id:"1825b4a1-0329-408d-9cc2-a40e6a17c822"}
  ]};
  const input={...params,
    scripts:[...params.scripts,{id:name}],
    settingsByName:{...params.settingsByName,[name]:settings}};
  const safe=assessDeployedCanonicalD1Principals(input);
  assert.equal(safe.retiredHistoricalCaptureScriptsInspected,1);
  assert.deepEqual(safe.retiredCaptureReactivations,[]);
  const restored=assessDeployedCanonicalD1Principals({...input,
    settingsByName:{...input.settingsByName,[name]:{bindings:[
      ...settings.bindings,{name:"SOURCE_DB",type:"d1",id:CANONICAL_D1}]}} ,
    schedulesByName:{...params.schedulesByName,[name]:[]},
    subdomainsByName:{...params.subdomainsByName,[name]:{enabled:false}}
  });
  assert.deepEqual(restored.retiredCaptureReactivations,[name]);
  assert.ok(restored.blockerCodes.includes("retired_historical_capture_canonical_d1_or_execution_restored"));
  assert.equal(compareKnownUnsafeFleet(restored,baseline).strictDriftPass,false);
  const restarted=assessDeployedCanonicalD1Principals({...input,
    settingsByName:{...input.settingsByName,[name]:{bindings:[
      {name:"COVE_PUBLICATION_CAPTURE_ENABLED",type:"plain_text",text:"1"},
      settings.bindings[1]
    ]}}
  });
  assert.deepEqual(restarted.retiredCaptureReactivations,[name]);
  assert.equal(compareKnownUnsafeFleet(restarted,baseline).strictDriftPass,false);
});
test("two retired literary Workers cannot regain D1 or be re-enabled by redeploy",()=>{
  const name="cove-literary-handoff-isolated-disabled";
  const initial={bindings:[
    {name:"CONTENT_DB",type:"d1",id:"400c3af3-5d40-41fd-83cc-98228e40ddac"},
    {name:"FORE_CONTENT_PROCESSOR_ENABLED",type:"plain_text",text:"0"},
    {name:"FORE_CONTENT_HANDOFF_ENABLED",type:"plain_text",text:"0"}
  ]};
  const fixture={...params,scripts:[...params.scripts,{id:name}],
    settingsByName:{...params.settingsByName,[name]:initial}};
  assert.deepEqual(assessDeployedCanonicalD1Principals(fixture).retiredDisabledLiteraryReactivations,[]);
  const reopened=assessDeployedCanonicalD1Principals({...fixture,
    settingsByName:{...fixture.settingsByName,[name]:{
      bindings:[...initial.bindings,{name:"DB",type:"d1",id:CANONICAL_D1}]
    }},
    schedulesByName:{...params.schedulesByName,[name]:[]},
    subdomainsByName:{...params.subdomainsByName,[name]:{enabled:false}}
  });
  assert.deepEqual(reopened.retiredDisabledLiteraryReactivations,[name]);
  assert.ok(reopened.blockerCodes.includes("disabled_literary_worker_canonical_d1_or_execution_restored"));
  const reenabled=assessDeployedCanonicalD1Principals({...fixture,
    settingsByName:{...fixture.settingsByName,[name]:{bindings:[
      initial.bindings[0],
      {name:"FORE_CONTENT_PROCESSOR_ENABLED",type:"plain_text",text:"1"}
    ]}}
  });
  assert.deepEqual(reenabled.retiredDisabledLiteraryReactivations,[name]);
});
test("a forged expanded baseline cannot increase 12 deployed canonical D1 principals",()=>{
  const baseline={schema:"cove.canonical-d1-unsafe-principal-baseline.v1",certified:false,
    canonicalD1:CANONICAL_D1,
    knownDirectBindings:[{script:OWNER_SCRIPT,binding:"PRIMARY_DB"},
      {script:"cove-disabled-qa",binding:"SOURCE_DB"}],
    knownSchedules:{"cove-disabled-qa":["* * * * *"]}};
  const original=assessDeployedCanonicalD1Principals(params);
  assert.equal(compareKnownUnsafeFleet(original,baseline).strictDriftPass,true);
  const extraBindings=Array.from({length:13},(_,i)=>({
    script:"new-direct-"+i,binding:"DB",crons:[],owner:false
  }));
  const artificiallyForged={...original,directCanonicalBindings:14,
    nonOwnerBindings:13,
    principals:[...original.principals,...extraBindings]};
  const forgedBaseline={...baseline,knownDirectBindings:[
    ...baseline.knownDirectBindings,
    ...extraBindings.map(x=>({script:x.script,binding:x.binding}))
  ]};
  const verdict=compareKnownUnsafeFleet(artificiallyForged,forgedBaseline);
  assert.equal(verdict.newBindings.length,0);
  assert.equal(verdict.strictDriftPass,false);
});
test("production-D1-capable fast architecture QA cannot restore publicly reachable Workers.dev ingress",()=>{
  const name="cove-fast-architecture-qa";
  const input={...params,
    scripts:[...params.scripts,{id:name}],
    settingsByName:{...params.settingsByName,[name]:{bindings:[
      {name:"DB",type:"d1",id:CANONICAL_D1},
      {name:"COVE_STRANGLER_RELEASE_CERTIFIED",type:"plain_text",text:"1"}
    ]}},
    schedulesByName:{...params.schedulesByName,[name]:[]},
    subdomainsByName:{...params.subdomainsByName,[name]:{enabled:false,previews_enabled:false}}};
  const safe=assessDeployedCanonicalD1Principals(input);
  assert.equal(safe.unsafeFastArchitectureQAIngress,0);
  const opened=assessDeployedCanonicalD1Principals({...input,
    subdomainsByName:{...input.subdomainsByName,[name]:{enabled:true,previews_enabled:false}}});
  assert.equal(opened.unsafeFastArchitectureQAIngress,1);
  assert.ok(opened.blockerCodes.includes("production_d1_qa_architecture_public_ingress"));
  const snapshot={schema:"cove.canonical-d1-unsafe-principal-baseline.v1",
    certified:false,canonicalD1:CANONICAL_D1,
    knownDirectBindings:[{script:OWNER_SCRIPT,binding:"PRIMARY_DB"},
      {script:"cove-disabled-qa",binding:"SOURCE_DB"},{script:name,binding:"DB"}],
    knownSchedules:{"cove-disabled-qa":["* * * * *"]}};
  assert.equal(compareKnownUnsafeFleet(safe,snapshot).strictDriftPass,true);
  assert.equal(compareKnownUnsafeFleet(opened,snapshot).strictDriftPass,false);
});
test("retired fast QA and customer gateway never regain canonical D1, activation or public QA ingress",()=>{
  const qa="cove-fast-architecture-qa",gateway="cove-fast-customer-gateway";
  const settings=(mode="customer-gateway")=>({bindings:[
    {name:"COVE_STRANGLER_MODE",type:"plain_text",text:mode},
    {name:"COVE_STRANGLER_RELEASE_CERTIFIED",type:"plain_text",text:"0"}]});
  const input={...params,
    scripts:[...params.scripts,{id:qa},{id:gateway}],
    settingsByName:{...params.settingsByName,[qa]:settings(),[gateway]:settings()},
    schedulesByName:{...params.schedulesByName,[qa]:[],[gateway]:[]},
    subdomainsByName:{...params.subdomainsByName,
      [qa]:{enabled:false,previews_enabled:false},
      [gateway]:{enabled:true,previews_enabled:false}}};
  const good=assessDeployedCanonicalD1Principals(input);
  assert.deepEqual(good.retiredFastWorkerViolations,[]);
  const dbRebound=assessDeployedCanonicalD1Principals({...input,
    settingsByName:{...input.settingsByName,[qa]:{bindings:[
      ...settings().bindings,{name:"DB",type:"d1",id:CANONICAL_D1}
    ]}}});
  assert.deepEqual(dbRebound.retiredFastWorkerViolations,[qa]);
  assert.ok(dbRebound.blockerCodes.includes("retired_fast_worker_d1_or_activation_restored"));
  const reactivation=assessDeployedCanonicalD1Principals({...input,
    settingsByName:{...input.settingsByName,[gateway]:{bindings:[
      {name:"COVE_STRANGLER_MODE",type:"plain_text",text:"customer-gateway"},
      {name:"COVE_STRANGLER_RELEASE_CERTIFIED",type:"plain_text",text:"1"}]}}});
  assert.deepEqual(reactivation.retiredFastWorkerViolations,[gateway]);
  const republished=assessDeployedCanonicalD1Principals({...input,
    subdomainsByName:{...input.subdomainsByName,[qa]:{enabled:true,previews_enabled:false}}});
  assert.deepEqual(republished.retiredFastWorkerViolations,[qa]);
  const selector=assessDeployedCanonicalD1Principals({...input,
    settingsByName:{...input.settingsByName,[gateway]:{bindings:[
      ...settings().bindings,{name:"COVE_STRANGLER_DATABASE_ID",type:"plain_text",text:CANONICAL_D1}
    ]}}});
  assert.deepEqual(selector.retiredFastWorkerViolations,[gateway]);
});
test("baseline is unsafe history, never authorization; added bindings and cron are refused",()=>{
  const report=assessDeployedCanonicalD1Principals(params);
  const baseline={schema:"cove.canonical-d1-unsafe-principal-baseline.v1",certified:false,
    canonicalD1:CANONICAL_D1,
    knownDirectBindings:[{script:OWNER_SCRIPT,binding:"PRIMARY_DB"},
      {script:"cove-disabled-qa",binding:"SOURCE_DB"}],
    knownSchedules:{"cove-disabled-qa":["* * * * *"]}};
  const accepted=compareKnownUnsafeFleet(report,baseline);
  assert.equal(accepted.strictDriftPass,true);
  assert.equal(accepted.productionAuthorized,false);
  const extra=compareKnownUnsafeFleet(report,{
    ...baseline,knownDirectBindings:baseline.knownDirectBindings.slice(0,1)});
  assert.deepEqual(extra.newBindings,[{script:"cove-disabled-qa",binding:"SOURCE_DB"}]);
  assert.equal(extra.strictDriftPass,false);
  const changedCron=compareKnownUnsafeFleet(report,{...baseline,knownSchedules:{}});
  assert.deepEqual(changedCron.newSchedules,[{script:"cove-disabled-qa",cron:"* * * * *"}]);
  assert.equal(changedCron.strictDriftPass,false);
  assert.throws(()=>compareKnownUnsafeFleet(report,{...baseline,certified:true}));
  const forgedOwner=compareKnownUnsafeFleet({
    ...report,ownerEnabled:true
  },baseline);
  assert.equal(forgedOwner.strictDriftPass,false);
});
test("historic QA publication drivers must retain disabled public ingress even without D1 binding",()=>{
  const driver="cove-pub-39936418754-driver";
  const input={
    ...params,
    scripts:[...params.scripts,{id:driver}],
    settingsByName:{...params.settingsByName,[driver]:{
      bindings:[{type:"secret_text",name:"GATE"},
        {type:"service",name:"CAPTURE",service:"cove-pub-39936418754-capture"}]}},
    schedulesByName:{...params.schedulesByName,[driver]:[]},
    subdomainsByName:{...params.subdomainsByName,[driver]:{
      enabled:false,previews_enabled:false}}
  };
  const safe=assessDeployedCanonicalD1Principals(input);
  assert.equal(safe.legacyPublicationDriversInspected,1);
  assert.equal(safe.unsafeLegacyDriverIngress,0);
  const baseline={schema:"cove.canonical-d1-unsafe-principal-baseline.v1",certified:false,
    canonicalD1:CANONICAL_D1,knownDirectBindings:[
      {script:OWNER_SCRIPT,binding:"PRIMARY_DB"},
      {script:"cove-disabled-qa",binding:"SOURCE_DB"}],
    knownSchedules:{"cove-disabled-qa":["* * * * *"]}};
  assert.equal(compareKnownUnsafeFleet(safe,baseline).strictDriftPass,true);
  const reopened=assessDeployedCanonicalD1Principals({...input,
    subdomainsByName:{...input.subdomainsByName,[driver]:{
      enabled:true,previews_enabled:false}}});
  assert.equal(reopened.unsafeLegacyDriverIngress,1);
  assert.ok(reopened.blockerCodes.includes("historical_qa_driver_public_ingress_reopened"));
  assert.equal(compareKnownUnsafeFleet(reopened,baseline).strictDriftPass,false);
  assert.throws(()=>assessDeployedCanonicalD1Principals({...input,
    schedulesByName:params.schedulesByName}),/Missing legacy driver schedules/);
});
test("missing binding/schedule/public ingress or duplicate Worker inventory fails closed",()=>{
  assert.throws(()=>assessDeployedCanonicalD1Principals({...params,
    settingsByName:{[OWNER_SCRIPT]:owner}}),/Missing deployed Worker settings/);
  assert.throws(()=>assessDeployedCanonicalD1Principals({...params,
    schedulesByName:{[OWNER_SCRIPT]:[]}}),/Missing live cron inventory/);
  assert.throws(()=>assessDeployedCanonicalD1Principals({...params,
    subdomainsByName:{[OWNER_SCRIPT]:{enabled:false}}}),/Missing Workers.dev exposure/);
  assert.throws(()=>assessDeployedCanonicalD1Principals({...params,
    scripts:[...params.scripts,...params.scripts]}),/Duplicate Worker names/);
});
test("Cloudflare network audit calls every Worker, never ignores non-Cove principals",async()=>{
  const calls=[];
  const settings={
    [OWNER_SCRIPT]:owner, "legacy-fleet-writer":other,
    "unrelated-worker":innocuous
  };
  const account="a".repeat(32),zone="b".repeat(32);
  const base="/accounts/"+account+"/workers/scripts";
  const replies={
    [base]:[{id:OWNER_SCRIPT},{id:"legacy-fleet-writer"},{id:"unrelated-worker"}],
    [base+"/"+OWNER_SCRIPT+"/settings"]:owner,
    [base+"/legacy-fleet-writer/settings"]:other,
    [base+"/unrelated-worker/settings"]:innocuous,
    [base+"/"+OWNER_SCRIPT+"/schedules"]:{schedules:[]},
    [base+"/legacy-fleet-writer/schedules"]:{schedules:[{cron:"* * * * *"}]},
    [base+"/"+OWNER_SCRIPT+"/subdomain"]:{enabled:false},
    [base+"/legacy-fleet-writer/subdomain"]:{enabled:true},
    ["/zones/"+zone+"/workers/routes"]:[],
    ["/accounts/"+account+"/workers/domains"]:[]
  };
  const fetcher=async(url,opts)=>{
    assert.equal(opts.headers.authorization,"Bearer "+"z".repeat(30));
    assert.equal(opts.method,"GET");
    const path=new URL(url).pathname.replace(/^\/client\/v4/,"");
    calls.push(path);
    if(!(path in replies))return Response.json({success:false},{status:404});
    return Response.json({success:true,result:replies[path]});
  };
  const r=await collectCanonicalD1Fleet({
    fetcher,token:"z".repeat(30),account,zone});
  assert.equal(r.workerScriptsInspected,3);
  assert.equal(r.directCanonicalBindings,2);
  assert.equal(r.nonOwnerBindings,1);
  assert.equal(r.boundScriptsWithNetworkIngress,1);
  assert.equal(calls.length,10);
  assert.ok(calls.includes(base+"/unrelated-worker/settings"));
  assert.ok(calls.includes(base+"/legacy-fleet-writer/schedules"));
  assert.ok(!calls.includes(base+"/unrelated-worker/schedules"),
    "Do not query non-canonical cron when no canonical privilege exists");
});
test("failed Cloudflare settings response must abort the entire audit",async()=>{
  let requests=0;
  await assert.rejects(()=>collectCanonicalD1Fleet({
    account:"a".repeat(32),zone:"b".repeat(32),token:"x".repeat(30),
    fetcher:async(url)=>{
      requests++;
      return url.endsWith("/workers/scripts")
        ?Response.json({success:true,result:[{id:OWNER_SCRIPT}]})
        :Response.json({success:false},{status:403});
    }
  }),/HTTP 403/);
  assert.equal(requests,2);
});
console.log("PASS: deployed principal account-wide audit is read-only, fail-closed, and cannot self-certify production authorization");
