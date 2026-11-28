/* eslint-disable prettier/prettier -- Exact privilege and expiry adversarial cases. */
import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {account,accountKey,editor,profiles,checkMaintenancePolicy,verifyMaintenance} from "./verify-temporary-worker-maintenance.mjs";
const now=Date.parse("2026-11-28T12:00:00Z");
const expiry=new Date(now+60*60*1000).toISOString();
const verified={id:"a".repeat(32),status:"active",expires_on:expiry};
const make=profile=>({...verified,policies:[{effect:"allow",permission_groups:[{id:editor,name:"Individual Workers Editor"}],resources:{[accountKey]:Object.fromEntries(profiles[profile].map(id=>["com.cloudflare.edge.worker.script."+id,"*"]))}}]});
test("temporary exact Worker scopes only",()=>{
  for(const profile of Object.keys(profiles))assert.equal(checkMaintenancePolicy(verified,make(profile),profile,now).temporary,true);
  const mutations=[
    x=>delete x.expires_on,x=>x.expires_on=new Date(now+3*60*60*1000).toISOString(),
    x=>x.status="disabled",x=>x.id="b".repeat(32),x=>x.policies[0].resources[accountKey]="*",
    x=>x.policies[0].effect="deny",x=>x.policies[0].permission_groups.push({id:"d1"}),
    x=>x.policies.push(structuredClone(x.policies[0])),
    x=>x.policies[0].permission_groups[0].id="e086da7e2179491d91ee5f35b3ca210a",
    x=>x.policies[0].resources[accountKey]["com.cloudflare.edge.worker.script."+"f".repeat(32)]="*"
  ];
  for(const mutate of mutations){const x=make("owner");mutate(x);assert.throws(()=>checkMaintenancePolicy(verified,x,"owner",now));}
  assert.throws(()=>checkMaintenancePolicy(verified,make("owner"),"gateway",now));
});
test("only GET metadata with independently authenticated token",async()=>{
  const env={GITHUB_REPOSITORY:"JibrilMohamud/cove",GITHUB_REF:"refs/heads/main",GITHUB_EVENT_NAME:"workflow_dispatch",COVE_CF_PROD_MAINTENANCE_TOKEN:"w".repeat(32),COVE_CF_ACCOUNT_TOKEN_INVENTORY_READ_TOKEN:"r".repeat(32)};
  const calls=[];
  const send=async(url,init)=>{
    calls.push(url);assert.equal(init.method,"GET");assert.equal(init.redirect,"error");
    assert.equal(init.headers.authorization,"Bearer "+(url.endsWith("/verify")?env.COVE_CF_PROD_MAINTENANCE_TOKEN:env.COVE_CF_ACCOUNT_TOKEN_INVENTORY_READ_TOKEN));
    return Response.json({success:true,result:url.endsWith("/verify")?verified:make("owner")});
  };
  assert.equal((await verifyMaintenance("owner",env,send,now)).workerCount,1);
  assert.deepEqual(calls,["https://api.cloudflare.com/client/v4/accounts/"+account+"/tokens/verify","https://api.cloudflare.com/client/v4/accounts/"+account+"/tokens/"+verified.id]);
  await assert.rejects(verifyMaintenance("owner",{...env,GITHUB_REF:"refs/heads/pr"},send,now));
  await assert.rejects(verifyMaintenance("owner",{...env,COVE_CF_ACCOUNT_TOKEN_INVENTORY_READ_TOKEN:env.COVE_CF_PROD_MAINTENANCE_TOKEN},send,now));
  assert.equal(calls.length,2);
});
test("all migrated production workflows require verified maintenance before mutation",()=>{
  const cases=[["production-biosync-bridge-activation","biosync-activate","Activate archived owner and narrow ingress, verify production replay or restore original owner"],["production-biosync-bridge-version-upload","owner","Upload archived owner version only; retain every existing binding"],["production-literary-budget-owner-activation","owner","Archive, activate, prove a real native scheduled receipt and preserve BioSync replay"],["production-legal-owner-locked","owner","Require independent scoped Workers deploy and read-only auditors"],["deploy-locked-fast-storefront-gateway","gateway","Deploy disabled customer gateway with no route bindings"],["literary-drain-worker-deploy","literary-drain","Require separate Worker deploy, D1/R2 read and Worker metadata principals"],["literary-isolated-replay-handoff-deploy","literary-replay","Require separate Worker deploy, D1/R2 read and Worker metadata principals"],["literary-prod-handoff-dormant-deploy","literary-dormant","Reject reused or missing dormant publisher principals"],["literary-prod-publisher-dormant-deploy","literary-publisher","Reject reused or missing dormant publisher principals"]];
  for(const [file,profile,anchor] of cases){
    const source=readFileSync(".github/workflows/"+file+".yml","utf8");
    assert.ok(!source.includes("secrets.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN"),file);
    assert.ok(source.includes("secrets.COVE_CF_PROD_MAINTENANCE_TOKEN"),file);
    assert.ok(source.includes("environment: cove-production-release-audit"),file);
    const guard=source.indexOf("node scripts/release/verify-temporary-worker-maintenance.mjs "+profile);
    assert.ok(guard>=0&&guard<source.indexOf("- name: "+anchor),file);
  }
});
