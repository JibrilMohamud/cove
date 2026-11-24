/* eslint-disable prettier/prettier -- pin production topology and reject every unreviewed provider mutation */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {verifyCandidate} from "./archive-production-biosync-bridge.mjs";
import {verifyProductionBioSyncCredentials} from "./production-biosync-credential-preflight.mjs";
import {sendOwner,ownerBoundary,refusalCode} from "../audio_pipeline/biosync_owner_https.mjs";

const account="d26430caa63ec55f6612e32f36aca5e9";
const owner="cove-legal-authority-production",backend="cove-persistence-backend",ingress="cove-biosync-production-ingress";
const oldOwner="3463ff93-f077-40bf-a4d5-fb7bfc143cd5";
const candidate="ed1ffa2a-5a20-40af-8f3c-4906f41f7c50";
const oldBackend="401f2af2-6e69-4611-8110-1d127af6eecf";
const archivedSha="11af1069da22bae6908513a696881985932652f1";
const pinnedIngress="ca0f6663-afa3-43a0-b36d-60545d4c47f5";
const pinnedIngressEtag="01097f9e28d800731c1225883d8ab2fa488fc59e843e24aa88c6aa684fb080d4";
const crons=["* * * * *","*/5 * * * *","*/10 * * * *","7-57/10 * * * *","23 * * * *","17 3 * * *","41 4 * * *"].sort();
const active=(d,v)=>assert.deepEqual(d?.deployments?.[0]?.versions,[{version_id:v,percentage:100}]);
const schedule=(s,expected)=>assert.deepEqual(s?.schedules?.map(x=>x.cron).sort(),expected);
const root="https://api.cloudflare.com/client/v4/accounts/"+account+"/workers/scripts/";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function activate(){
  const env=process.env;
  assert.equal(env.GITHUB_REPOSITORY,"JibrilMohamud/cove");
  assert.equal(env.GITHUB_REF,"refs/heads/main");
  assert.equal(env.GITHUB_EVENT_NAME,"workflow_dispatch");
  assert.equal(env.COVE_REVIEWED_MAIN_SHA,env.GITHUB_SHA);
  assert.equal(env.COVE_CONFIRM_BRIDGE_ACTIVATION,"true");
  const read=env.COVE_CF_WORKERS_METADATA_READ_TOKEN,write=env.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN,client=env.COVE_BIOSYNC_PROD_CLIENT_SECRET;
  assert.ok([read,write,client].every(x=>typeof x==="string"&&x.length>=24));
  assert.equal(new Set([read,write,client]).size,3);
  // No activation until the exact D1 read and S3 token actually authenticate.
  const preflight=await verifyProductionBioSyncCredentials(env);
  assert.equal(preflight.realR2List,true);
  console.log(JSON.stringify(preflight));
  async function request(script,path,method="GET",body,allowMissing=false){
    const mutation=method!=="GET";
    assert.ok(!mutation||
      (script===owner&&path==="/deployments"&&method==="POST")||
      (script===ingress&&((path===""&&method==="PUT")||(path==="/subdomain"&&method==="POST"))));
    const response=await fetch(root+script+path,{
      method,headers:{authorization:"Bearer "+(mutation?write:read),...(body&&!(body instanceof FormData)?{"content-type":"application/json"}:{})},
      ...(body?{body:body instanceof FormData?body:JSON.stringify(body)}:{}),
      redirect:"error",signal:AbortSignal.timeout(90000)});
    if(allowMissing&&response.status===404)return null;
    if(!response.ok)throw Error("bridge_"+script+"_"+method+"_http_"+response.status);
    const data=await response.json();
    if(data.success!==true)throw Error("bridge_provider_rejected");
    return data.result;
  }
  async function topology(version){
    const [a,b,oc,bc,s]=await Promise.all([
      request(owner,"/deployments"),request(backend,"/deployments"),request(owner,"/schedules"),
      request(backend,"/schedules"),request(owner,"/subdomain")]);
    active(a,version);active(b,oldBackend);schedule(oc,[]);schedule(bc,crons);
    assert.equal(s.enabled,false);assert.equal(s.previews_enabled,false);
  }
  await topology(oldOwner);
  const [old,next,existing]=await Promise.all([
    request(owner,"/versions/"+oldOwner),request(owner,"/versions/"+candidate),
    request(ingress,"/settings","GET",undefined,true)]);
  // Resume only the exact disabled ingress left by the failed activation.
  if(existing){
    const [d,v,s,c]=await Promise.all([request(ingress,"/deployments"),
      request(ingress,"/versions/"+pinnedIngress),request(ingress,"/subdomain"),request(ingress,"/schedules")]);
    active(d,pinnedIngress);assert.equal(v.resources.script.etag,pinnedIngressEtag);
    assert.equal(v.resources.script_runtime.compatibility_date,"2026-10-25");
    assert.equal(s.enabled,false);assert.equal(s.previews_enabled,false);schedule(c,[]);
    verifyIngress(v.resources.bindings);verifyIngress(existing.bindings);
  }
  assert.equal(next.annotations?.["workers/commit_sha"],archivedSha);
  verifyCandidate(old,next);
  const source=readFileSync(".output/production-consolidation/biosync-ingress.mjs");
  assert.ok(source.byteLength>1000&&source.byteLength<200000);
  const metadata={
    main_module:"biosync-ingress.mjs",compatibility_date:"2026-10-25",
    bindings:[
      {name:"COVE_PRODUCTION_BIOSYNC_INGRESS_ENABLED",type:"plain_text",text:"1"},
      {name:"COVE_BIOSYNC_CLIENT_TOKEN_SHA256",type:"secret_text",text:createHash("sha256").update(client).digest("hex")},
      {name:"BIOSYNC_OWNER",type:"service",service:owner,entrypoint:"CoveBioSyncEntrypoint",environment:"production"}
    ]};
  const form=new FormData();
  form.append("metadata",new Blob([JSON.stringify(metadata)],{type:"application/json"}));
  form.append("biosync-ingress.mjs",new Blob([source],{type:"application/javascript+module"}),"biosync-ingress.mjs");
  function verifyIngress(bindings){
    assert.deepEqual(bindings.map(b=>b.name).sort(),["BIOSYNC_OWNER","COVE_BIOSYNC_CLIENT_TOKEN_SHA256","COVE_PRODUCTION_BIOSYNC_INGRESS_ENABLED"]);
    const service=bindings.find(b=>b.name==="BIOSYNC_OWNER");
    assert.equal(service?.type,"service");assert.equal(service?.service,owner);
    assert.equal(service?.entrypoint,"CoveBioSyncEntrypoint");assert.equal(service?.environment,"production");
    assert.equal(bindings.find(b=>b.name==="COVE_BIOSYNC_CLIENT_TOKEN_SHA256")?.type,"secret_text");
    const flag=bindings.find(b=>b.name==="COVE_PRODUCTION_BIOSYNC_INGRESS_ENABLED");
    assert.equal(flag?.type,"plain_text");assert.equal(flag?.text,"1");
  }
  const deploy=version=>request(owner,"/deployments","POST",{strategy:"percentage",
    code_update_strategy:{mode:"immediate"},versions:[{version_id:version,percentage:100}]});
  let ownerAttempt=false,ingressAttempt=false;
  try{
    ownerAttempt=true;
    await deploy(candidate);
    await topology(candidate);
    ingressAttempt=true;
    if(!existing)await request(ingress,"","PUT",form);
    const settings=await request(ingress,"/settings");
    verifyIngress(settings.bindings);
    schedule(await request(ingress,"/schedules"),[]);
    await request(ingress,"/subdomain","POST",{enabled:true,previews_enabled:false});
    const sub=await request(ingress,"/subdomain");
    assert.equal(sub.enabled,true);assert.equal(sub.previews_enabled,false);
    // Worker propagation can lag deployment metadata. Only read-only or
    // invalid authenticated requests are retried, never a commit.
    let ready=false,last="biosync_owner_probe_not_ready";
    for(let i=0;i<12;i++){
      const r=await sendOwner({},"",fetch,{probe:true});
      if(r.status===401&&ownerBoundary(r)){ready=true;await r.body?.cancel();break;}
      last=refusalCode(r);await r.body?.cancel();await sleep(5000);
    }
    if(!ready)throw Error(last);
    console.log("biosync_ingress_application_unauthenticated_denial_verified");
    // Invalid commands cannot mutate D1. Verify authenticated forwarding
    // before attempting the already-completed real publication replay.
    ready=false;
    for(let i=0;i<12;i++){
      const r=await sendOwner({},client,fetch,{probe:true});
      if(r.status===503&&ownerBoundary(r)){ready=true;await r.body?.cancel();break;}
      last=refusalCode(r);await r.body?.cancel();await sleep(5000);
    }
    if(!ready)throw Error(last);
    console.log("biosync_ingress_authenticated_invalid_command_denial_verified");
    const runEnv={...env,COVE_BIOSYNC_PROD_OWNER_MODE:"1",BIOSYNC_AUTO_SHORT:"0",BIOSYNC_PROVE_OWNER_REPLAY:"1"};
    // Only the three scoped publisher secrets are passed into the canary.
    const clean={PATH:env.PATH,HOME:env.HOME,COVE_BIOSYNC_PROD_OWNER_MODE:"1",
      COVE_BIOSYNC_PROD_D1_READ_TOKEN:runEnv.COVE_BIOSYNC_PROD_D1_READ_TOKEN,
      COVE_BIOSYNC_PROD_R2_TOKEN:runEnv.COVE_BIOSYNC_PROD_R2_TOKEN,COVE_BIOSYNC_PROD_CLIENT_SECRET:client,
      BIOSYNC_AUTO_SHORT:"0",BIOSYNC_PROVE_OWNER_REPLAY:"1"};
    const replay=execFileSync("python3",["-m","scripts.audio_pipeline.biosync_canary"],{env:clean,encoding:"utf8",timeout:120000});
    assert.ok(replay.includes("cove_biosync_production_owner_replay_verified"),"real_replay_missing");
    await topology(candidate);
    console.log(JSON.stringify({schema:"cove.production-biosync-bridge-activation.v1",ownerVersion:candidate,
      originalBackendVersion:oldBackend,realReplayVerified:true,ingressD1Bindings:0,
      originalBackendCronCount:7,positiveLegalAuthorityEnabled:false,legacyHourlyPublisherUnchanged:true,
      newCommitProven:false,writerExclusivityCertified:false,releaseCertified:false}));
  }catch(error){
    const message=String(error?.message||"");
    console.error(/^(biosync_owner_|bridge_)[a-z0-9_-]+$/.test(message)?message:"bridge_activation_or_replay_failed");
    let rollbackOk=true;
    if(ingressAttempt){
      try{await request(ingress,"/subdomain","POST",{enabled:false,previews_enabled:false});}
      catch{rollbackOk=false;}
    }
    if(ownerAttempt){
      try{
        const d=await request(owner,"/deployments");
        const v=d?.deployments?.[0]?.versions;
        if(v?.length===1&&v[0].version_id===candidate)await deploy(oldOwner);
        await topology(oldOwner);
      }catch{rollbackOk=false;}
    }
    console.error(rollbackOk?"bridge_activation_failed_original_owner_restored":"bridge_activation_failed_rollback_requires_operator");
    process.exitCode=1;
  }
}
try{await activate();}catch(error){
  const message=String(error?.message||"");
  console.error(/^(biosync_preflight_|bridge_)[a-zA-Z0-9_-]+$/.test(message)?message:"bridge_activation_preflight_closed");
  process.exitCode=1;
}
