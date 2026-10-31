/* eslint-disable prettier/prettier -- This release preflight must fail closed under incomplete evidence. */
import assert from "node:assert/strict";
import {assessExternalPrerequisites,PRODUCTION_D1,PRODUCTION_OWNER,REQUIRED_EVENTS} from "./check-production-external-preflight.mjs";

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
  webhookUrl,ownerSource:"function productionLegalOwner() { return true; }"};
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
refuse({webhooks:[]},/No enabled Stripe LIVE/);
refuse({webhooks:[{...webhook,status:"disabled"}]},/No enabled Stripe LIVE/);
refuse({webhooks:[{...webhook,livemode:false}]},/No enabled Stripe LIVE/);
refuse({webhooks:[{...webhook,enabled_events:REQUIRED_EVENTS.filter(x=>x!=="refund.updated")}]},/event types/);
refuse({webhookUrl:"http://www.covereads.com/api/fore/stripe/webhook"},/URL is missing or invalid/);
refuse({webhookUrl:"https://attacker.example/api/fore/stripe/webhook"},/URL is missing or invalid/);
console.log("PASS: production Cloudflare/Stripe preflight stays read-only and fails closed on every missing legal, webhook or writer-exclusivity prerequisite.");
