/* eslint-disable prettier/prettier -- This release preflight must fail closed under incomplete evidence. */
import assert from "node:assert/strict";
import {assessExternalPrerequisites,PRODUCTION_D1,PRODUCTION_OWNER,REQUIRED_EVENTS,readLiveEvidence} from "./check-production-external-preflight.mjs";

const ownerSettings={bindings:[
  {name:"PRIMARY_DB",type:"d1",id:PRODUCTION_D1},
  {name:"LEGAL_AUTHORITY",type:"durable_object_namespace"},
  {name:"COVE_RIGHTS_OWNER_ENABLED",type:"plain_text",text:"1"},
  {name:"COVE_RIGHTS_OWNER_SECRET",type:"secret_text"}
]};
const webhookUrl="https://www.covereads.com/api/fore/stripe/webhook";
const webhook={livemode:true,status:"enabled",url:webhookUrl,enabled_events:[...REQUIRED_EVENTS]};
const safe={ownerSettings,workerSettings:[{name:PRODUCTION_OWNER,bindings:ownerSettings.bindings},
  {name:"read-only-canary",bindings:[]}],webhooks:[webhook],
  accountTokens:[],accountTokenInventoryComplete:true,webhookUrl,ownerSource:"function productionLegalOwner() { return true; }"};
const run=(overrides={})=>assessExternalPrerequisites({...safe,...overrides});
const accepted=run();
assert.equal(accepted.readyForExternalPrerequisites,true);
assert.equal(accepted.productionCertified,false);
assert.deepEqual(accepted.problems,[]);
const refuse=(input,pattern)=>{
  const result=run(input);
  assert.equal(result.readyForExternalPrerequisites,false);
  assert.ok(result.problems.some(x=>pattern.test(x)),JSON.stringify(result.problems));
  assert.equal(result.productionCertified,false);
};
refuse({ownerSettings:{bindings:ownerSettings.bindings.map(b=>
  b.name==="COVE_RIGHTS_OWNER_ENABLED"?{...b,text:"0"}:b)}},/disabled/);
refuse({ownerSource:"return QA_PRIMARIES.has(env.COVE_RIGHTS_OWNER_PRIMARY_ID||'');"},/QA-leased/);
refuse({ownerSettings:{bindings:ownerSettings.bindings.filter(b=>b.name!=="LEGAL_AUTHORITY")}},/Durable Object/);
refuse({ownerSettings:{bindings:ownerSettings.bindings.filter(b=>b.name!=="COVE_RIGHTS_OWNER_SECRET")}},/no secret/);
refuse({workerSettings:null},/inventory is missing/);
refuse({workerSettings:[...safe.workerSettings,
  {name:"unreviewed-cron",bindings:[{name:"SOURCE_DB",type:"d1",id:PRODUCTION_D1}]}]},/unreviewed-cron/);
refuse({accountTokens:[{id:"missing-status"}]},/status is incomplete/);
refuse({accountTokens:null},/token privilege inventory is missing/);
refuse({accountTokenInventoryComplete:false},/token privilege inventory is missing/);
refuse({accountTokens:[{id:"broad-deployment",status:"active",policies:[{effect:"allow",permission_groups:[{id:"09b2857d1c31407795e75e3fed8617a1"}]}]}]},/D1 Write/);
refuse({accountTokens:[{id:"broad-deployment",status:"active",policies:[{effect:"allow",permission_groups:[{name:"D1 Write"}]}]}]},/D1 Write/);
refuse({accountTokens:[{id:"unknown",status:"active"}]},/policies are incomplete/);
refuse({accountTokens:[{id:"unknown",status:"active",policies:[{effect:"allow"}]}]},/permission inventory is incomplete/);
assert.equal(run({accountTokens:[{id:"read-only",status:"active",policies:[{effect:"allow",permission_groups:[{name:"D1 Read"}]}]}]}).readyForExternalPrerequisites,true);
assert.equal(run({accountTokens:[{id:"retired",status:"disabled",policies:[{effect:"allow",permission_groups:[{name:"D1 Write"}]}]}]}).readyForExternalPrerequisites,true);
assert.equal(run({accountTokens:[{id:"denied",status:"active",policies:[{effect:"deny",permission_groups:[{name:"D1 Write"}]}]}]}).readyForExternalPrerequisites,true);
refuse({workerSettings:[{name:"aliased-principal",bindings:[{type:"d1",database_id:PRODUCTION_D1}]}]},/aliased-principal/);
refuse({webhooks:[]},/No enabled Stripe LIVE/);
refuse({webhooks:[{...webhook,status:"disabled"}]},/No enabled Stripe LIVE/);
refuse({webhooks:[{...webhook,livemode:false}]},/No enabled Stripe LIVE/);
refuse({webhooks:[{...webhook,enabled_events:REQUIRED_EVENTS.filter(x=>x!=="refund.updated")}]},/event types/);
refuse({webhookUrl:"http://www.covereads.com/api/fore/stripe/webhook"},/URL is missing or invalid/);
refuse({webhookUrl:"https://attacker.example/api/fore/stripe/webhook"},/URL is missing or invalid/);
// Exercise the real paginated read path. The second token page must not be
// silently omitted, and no provider request may mutate or retrieve a secret.
const actualFetch=globalThis.fetch;
const tokenPages=[];
let failTokenPage=false;
globalThis.fetch=async (input,options={})=>{
  assert.equal(options.method||"GET","GET");
  const url=new URL(input);
  let result;
  if(url.hostname==="api.stripe.com")result={data:[webhook],has_more:false};
  else if(url.pathname.endsWith("/tokens")){
    assert.equal(url.searchParams.get("per_page"),"50");
    const page=Number(url.searchParams.get("page"));tokenPages.push(page);
    if(failTokenPage&&page===2)return new Response("denied",{status:403});
    result={success:true,errors:[],result:page===1?Array.from({length:50},(_,i)=>({id:"reader-"+i,status:"active",policies:[]})):
      [{id:"page-two-writer",status:"active",policies:[{effect:"allow",permission_groups:[{name:"D1 Write"}]}]}],result_info:{total_pages:2}};
  }else if(url.pathname.endsWith("/workers/scripts"))result={success:true,errors:[],result:[{id:PRODUCTION_OWNER},{id:"read-only-canary"}],result_info:{total_pages:1}};
  else if(url.pathname.endsWith("/"+PRODUCTION_OWNER+"/settings"))result={success:true,errors:[],result:ownerSettings};
  else if(url.pathname.endsWith("/read-only-canary/settings"))result={success:true,errors:[],result:{bindings:[]}};
  else throw Error("Unexpected preflight provider path");
  return Response.json(result);
};
try{
  const evidence=await readLiveEvidence({cloudflareToken:"synthetic-reader",accountId:"test-account",stripeRestrictedKey:"synthetic-stripe-reader"});
  assert.deepEqual(tokenPages,[1,2]);
  assert.equal(evidence.accountTokens.length,51);
  assert.equal(evidence.accountTokenInventoryComplete,true);
  refuse(evidence,/page-two-writer/);
  failTokenPage=true;
  await assert.rejects(()=>readLiveEvidence({cloudflareToken:"synthetic-reader",accountId:"test-account",stripeRestrictedKey:"synthetic-stripe-reader"}),/HTTP 403/);
}finally{globalThis.fetch=actualFetch;}
console.log("PASS: read-only production preflight rejects missing owner/webhook/Worker/token evidence, active D1 API writers, incomplete pagination and provider denial.");
