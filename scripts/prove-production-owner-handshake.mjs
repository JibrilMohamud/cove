/* eslint-disable prettier/prettier -- Live production credential proof exposes only a disabled-state receipt. */
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {mkdirSync,writeFileSync} from "node:fs";
import {verifyProductionOwnerBinding,PRODUCTION_OWNER_SCRIPT} from "./check-production-owner-binding.mjs";

const account=process.env.CLOUDFLARE_ACCOUNT_ID;
const token=process.env.CLOUDFLARE_API_TOKEN;
assert.equal(account,"d26430caa63ec55f6612e32f36aca5e9");
assert.ok(token,"Authenticated Cloudflare control-plane access is required");
const name="cove-owner-handshake-"+randomBytes(8).toString("hex");
const gate=randomBytes(32).toString("hex");
const expires=Date.now()+180_000;
const base=`/accounts/${account}/workers/scripts/`;
const evidence={schema:"cove.production-owner-handshake.v1",startedAt:new Date().toISOString(),
  worker:name,productionOwnerEnabled:false,authorizing:false,passed:false,cleanedUp:false};
async function api(method,path,body) {
  const response=await fetch("https://api.cloudflare.com/client/v4"+path,{
    method,headers:{authorization:"Bearer "+token,...(body instanceof FormData||body===undefined?{}:{"content-type":"application/json"})},
    body:body instanceof FormData?body:body===undefined?undefined:JSON.stringify(body),
    signal:AbortSignal.timeout(20_000)});
  const data=await response.json();
  assert.equal(data.success,true,`Cloudflare ${method} ${response.status} for ${path}`);
  return data.result;
}
let attempted=false;
try {
  const owner=await api("GET",base+PRODUCTION_OWNER_SCRIPT+"/settings");
  const backend=await api("GET",base+"cove-persistence-backend/settings");
  verifyProductionOwnerBinding(owner,backend);
  const {subdomain}=await api("GET",`/accounts/${account}/workers/subdomain`);
  assert.match(subdomain,/^[a-z0-9][a-z0-9-]{0,62}$/);
  const origin=`https://${name}.${subdomain}.workers.dev`;
  // The private named backend entrypoint uses its existing secret. The
  // verifier receives no owner credential and cannot issue a legal command.
  const source=`export default {async fetch(request,env){
    const headers={"cache-control":"no-store"};
    if(Date.now()>=${expires})return new Response(null,{status:410,headers});
    if(request.headers.get("authorization")!=="Bearer "+env.PROBE_GATE)
      return new Response(null,{status:401,headers});
    if(request.method!=="POST"||new URL(request.url).pathname!=="/attest-disabled")
      return new Response(null,{status:404,headers});
    try{return Response.json(await env.BACKEND.attestDisabledOwner(),{headers});}
    catch{return new Response(null,{status:503,headers});}
  }};`;
  const metadata={main_module:"probe.mjs",compatibility_date:"2026-10-25",
    bindings:[{name:"PROBE_GATE",type:"secret_text",text:gate},
      {name:"BACKEND",type:"service",service:"cove-persistence-backend",entrypoint:"BackendOwnerAttestation"}]};
  const form=new FormData();
  form.set("metadata",new Blob([JSON.stringify(metadata)],{type:"application/json"}));
  form.set("probe.mjs",new Blob([source],{type:"application/javascript+module"}),"probe.mjs");
  attempted=true;
  const deployed=await api("PUT",base+name,form);
  evidence.deploymentId=deployed.deployment_id||null;
  await api("POST",base+name+"/subdomain",{enabled:true,previews_enabled:false});
  async function probe(key=gate,method="POST",path="/attest-disabled") {
    return fetch(origin+path,{method,headers:{authorization:"Bearer "+key},signal:AbortSignal.timeout(15_000)});
  }
  let response;
  for(let attempt=0;attempt<12;attempt++) {
    response=await probe();
    if(response.status===200)break;
    if(![404,503].includes(response.status))break;
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert.equal(response.status,200,"Actual backend-to-production-DO handshake must succeed");
  evidence.receipt=await response.json();
  assert.deepEqual(evidence.receipt,{attested:true,ownerEnabled:false,authorizing:false});
  assert.equal((await probe("forged")).status,401);
  assert.equal((await probe(gate,"GET")).status,404);
  assert.equal((await probe(gate,"POST","/commercial/publish-verified")).status,404);
  // The existing production HTTP ingress must not expose the RPC method.
  const publicAttempt=await fetch("https://api.covereads.com/__cove/legal-owner/attest-disabled",{
    method:"POST",headers:{"content-type":"application/json"},body:"{}",signal:AbortSignal.timeout(15_000)});
  assert.equal(publicAttempt.status,401,"Public HTTP owner diagnostic remains backend-token authenticated");
  verifyProductionOwnerBinding(await api("GET",base+PRODUCTION_OWNER_SCRIPT+"/settings"),
    await api("GET",base+"cove-persistence-backend/settings"));
  evidence.passed=true;
} finally {
  try {
    if(attempted) {
      await api("DELETE",base+name);
      const absent=await fetch("https://api.cloudflare.com/client/v4"+base+name+"/settings",{
        headers:{authorization:"Bearer "+token},signal:AbortSignal.timeout(15_000)});
      assert.equal(absent.status,404,"Ephemeral production verifier must be independently absent");
    }
    evidence.cleanedUp=true;
  } finally {
    evidence.finishedAt=new Date().toISOString();
    mkdirSync("artifacts/production-owner-handshake",{recursive:true});
    writeFileSync("artifacts/production-owner-handshake/result.json",JSON.stringify(evidence,null,2)+"\n");
  }
}
console.log("PASS: actual production backend secret and private DO binding complete fresh disabled-state handshake; public access denied; verifier deleted. Rights authority and cutover remain uncertified.");
