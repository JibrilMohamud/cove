/* eslint-disable prettier/prettier -- exact immutable production upload boundary */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";

const account="d26430caa63ec55f6612e32f36aca5e9";
const owner="cove-legal-authority-production";
const backend="cove-persistence-backend";
const ownerVersion="3463ff93-f077-40bf-a4d5-fb7bfc143cd5";
const backendVersion="401f2af2-6e69-4611-8110-1d127af6eecf";
const namespace="83d7eadf3957436389a7b072120a9829";
const primary="4bd657ac-8789-403e-a28c-93aba8d0a989";
const literary="400c3af3-5d40-41fd-83cc-98228e40ddac";
const secrets=[
  "COVE_LITERARY_HANDOFF_SECRET","COVE_LITERARY_PUBLICATION_SECRET",
  "COVE_LITERARY_READ_SECRET","COVE_PUBLICATION_SOURCE_READER_SECRET",
  "COVE_RIGHTS_OWNER_SECRET","COVE_SOUNDS_SOURCE_READER_SECRET","STRIPE_SECRET_KEY"
];
const crons=["* * * * *","*/5 * * * *","*/10 * * * *","7-57/10 * * * *","23 * * * *","17 3 * * *","41 4 * * *"];
const pin=(d,version)=>{
  const active=d?.deployments?.[0]?.versions;
  assert.deepEqual(active,[{version_id:version,percentage:100}],"active_version_drift");
};
const scheduleList=x=>Array.isArray(x?.schedules)?x.schedules.map(y=>y.cron).sort():null;
const exact=(actual,expected)=>assert.deepEqual([...actual].sort(),[...expected].sort());
const bindingMap=rows=>{
  assert.ok(Array.isArray(rows));
  assert.equal(new Set(rows.map(x=>x.name)).size,rows.length);
  return new Map(rows.map(x=>[x.name,x]));
};
const resource=(b)=>{
  if(b.type==="secret_text")return {name:b.name,type:b.type};
  if(b.type==="d1")return {name:b.name,type:b.type,database_id:b.database_id??b.id};
  if(b.type==="r2_bucket")return {name:b.name,type:b.type,bucket_name:b.bucket_name};
  if(b.type==="durable_object_namespace")return {name:b.name,type:b.type,class_name:b.class_name,namespace_id:b.namespace_id};
  if(b.type==="plain_text")return {name:b.name,type:b.type,text:b.text};
  throw Error("unexpected_owner_binding_type");
};
export function buildBridgeMetadata(version,client,sha){
  assert.equal(version.id,ownerVersion);
  assert.equal(version.resources?.script_runtime?.migration_tag,"legal-authority-production-locked-v1");
  assert.equal(version.resources?.script_runtime?.compatibility_date,"2026-10-25");
  assert.match(client,/^[a-f0-9]{64}$/);
  assert.match(sha,/^[a-f0-9]{40}$/);
  const rows=version.resources.bindings;
  const b=bindingMap(rows);
  exact(b.keys(),[...secrets,"LEGAL_AUTHORITY","PRIMARY_DB","LITERARY_CONTENT_DB","LITERARY_BUCKET",
    "COVE_RIGHTS_OWNER_ENABLED","COVE_RIGHTS_OWNER_PRIMARY_ID","STRIPE_LIVEMODE"]);
  for(const name of secrets)assert.equal(b.get(name)?.type,"secret_text");
  assert.deepEqual(resource(b.get("PRIMARY_DB")),{name:"PRIMARY_DB",type:"d1",database_id:primary});
  assert.deepEqual(resource(b.get("LITERARY_CONTENT_DB")),{name:"LITERARY_CONTENT_DB",type:"d1",database_id:literary});
  assert.deepEqual(resource(b.get("LITERARY_BUCKET")),{name:"LITERARY_BUCKET",type:"r2_bucket",bucket_name:"cove-literary-originals-isolated-20261024"});
  assert.deepEqual(resource(b.get("LEGAL_AUTHORITY")),{name:"LEGAL_AUTHORITY",type:"durable_object_namespace",class_name:"CoveLegalAuthority",namespace_id:namespace});
  for(const [name,value] of [["COVE_RIGHTS_OWNER_ENABLED","0"],["COVE_RIGHTS_OWNER_PRIMARY_ID",primary],["STRIPE_LIVEMODE","true"]])
    assert.deepEqual(resource(b.get(name)),{name,type:"plain_text",text:value});
  const bindings=rows.map(x=>x.type==="secret_text"?{name:x.name,type:"inherit",version_id:"latest"}:resource(x));
  bindings.push(
    {name:"BUCKET",type:"r2_bucket",bucket_name:"cove-production-media"},
    {name:"FORE_ENVIRONMENT",type:"plain_text",text:"production"},
    {name:"COVE_PRODUCTION_BIOSYNC_BRIDGE_ENABLED",type:"plain_text",text:"1"},
    {name:"COVE_BIOSYNC_CLIENT_TOKEN_SHA256",type:"secret_text",text:createHash("sha256").update(client).digest("hex")}
  );
  return {
    main_module:"owner.mjs",compatibility_date:"2026-10-25",compatibility_flags:["nodejs_compat"],
    bindings,annotations:{"workers/commit_sha":sha,"workers/message":"Archived BioSync bridge only; no deployment"}
    // Deliberately no migrations, deployment, routes, schedules or positive legal enablement.
  };
}
export function verifyCandidate(oldVersion,candidate){
  const old=bindingMap(oldVersion.resources.bindings),next=bindingMap(candidate.resources?.bindings);
  exact(next.keys(),[...old.keys(),"BUCKET","FORE_ENVIRONMENT","COVE_PRODUCTION_BIOSYNC_BRIDGE_ENABLED","COVE_BIOSYNC_CLIENT_TOKEN_SHA256"]);
  for(const [name,value] of old)assert.deepEqual(resource(next.get(name)),resource(value));
  assert.deepEqual(resource(next.get("BUCKET")),{name:"BUCKET",type:"r2_bucket",bucket_name:"cove-production-media"});
  assert.deepEqual(resource(next.get("FORE_ENVIRONMENT")),{name:"FORE_ENVIRONMENT",type:"plain_text",text:"production"});
  assert.deepEqual(resource(next.get("COVE_PRODUCTION_BIOSYNC_BRIDGE_ENABLED")),{name:"COVE_PRODUCTION_BIOSYNC_BRIDGE_ENABLED",type:"plain_text",text:"1"});
  assert.equal(next.get("COVE_BIOSYNC_CLIENT_TOKEN_SHA256")?.type,"secret_text");
  assert.equal(candidate.resources?.script_runtime?.migration_tag,"legal-authority-production-locked-v1");
  assert.equal(candidate.resources?.script_runtime?.compatibility_date,"2026-10-25");
  assert.ok(candidate.resources?.script?.named_handlers?.some(x=>x.name==="CoveBioSyncEntrypoint"&&x.handlers?.includes("fetch")));
}
export async function archiveBridge(env,code,transport=fetch){
  assert.equal(env.GITHUB_REPOSITORY,"JibrilMohamud/cove");
  assert.equal(env.GITHUB_REF,"refs/heads/main");
  assert.equal(env.GITHUB_EVENT_NAME,"workflow_dispatch");
  assert.equal(env.COVE_REVIEWED_MAIN_SHA,env.GITHUB_SHA);
  assert.match(env.GITHUB_SHA||"",/^[a-f0-9]{40}$/);
  const read=env.COVE_CF_WORKERS_METADATA_READ_TOKEN,write=env.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN;
  const client=env.COVE_BIOSYNC_PROD_CLIENT_SECRET;
  assert.ok([read,write,client].every(x=>typeof x==="string"&&x.length>=24));
  assert.equal(new Set([read,write,client]).size,3);
  assert.ok(code.byteLength>1000&&code.byteLength<10*1024*1024);
  const root="https://api.cloudflare.com/client/v4/accounts/"+account+"/workers/scripts/";
  async function request(script,path,form){
    const upload=form!==undefined;
    assert.ok(!upload||(script===owner&&path==="/versions?bindings_inherit=strict"));
    const result=await transport(root+script+path,{method:upload?"POST":"GET",
      headers:{authorization:"Bearer "+(upload?write:read)},...(upload?{body:form}:{}),
      redirect:"error",signal:AbortSignal.timeout(90000)});
    if(!result.ok)throw Error("bridge_provider_http_"+result.status);
    const payload=await result.json();
    if(payload.success!==true)throw Error("bridge_provider_rejected");
    return payload.result;
  }
  async function unchanged(){
    const [a,b,oc,bc,sub]=await Promise.all([
      request(owner,"/deployments"),request(backend,"/deployments"),
      request(owner,"/schedules"),request(backend,"/schedules"),request(owner,"/subdomain")
    ]);
    pin(a,ownerVersion);pin(b,backendVersion);
    assert.deepEqual(scheduleList(oc),[]);
    assert.deepEqual(scheduleList(bc),[...crons].sort());
    assert.equal(sub.enabled,false);assert.equal(sub.previews_enabled,false);
  }
  await unchanged();
  const [old,list]=await Promise.all([request(owner,"/versions/"+ownerVersion),request(owner,"/versions?per_page=3")]);
  // Strict inherit resolves against latest uploaded, not necessarily active.
  // Refuse any intervening archived version: never inherit a different secret.
  assert.equal(list?.items?.[0]?.id,ownerVersion,"latest_owner_version_drift");
  const metadata=buildBridgeMetadata(old,client,env.GITHUB_SHA);
  const form=new FormData();
  form.append("metadata",new Blob([JSON.stringify(metadata)],{type:"application/json"}));
  form.append("owner.mjs",new Blob([code],{type:"application/javascript+module"}),"owner.mjs");
  let candidate;
  try{
    const receipt=await request(owner,"/versions?bindings_inherit=strict",form);
    assert.match(receipt?.id||"",/^[0-9a-f-]{36}$/);
    assert.notEqual(receipt.id,ownerVersion);
    candidate=await request(owner,"/versions/"+receipt.id);
    verifyCandidate(old,candidate);
  }finally{
    await unchanged();
  }
  return {schema:"cove.biosync-bridge-archived-owner.v1",versionId:candidate.id,
    originalOwnerVersion:ownerVersion,originalBackendVersion:backendVersion,
    candidateTraffic:0,previousOwnerBindingsPreserved:true,existingSecretsInherited:true,
    productionTrafficUnchanged:true,cronSchedulesUnchanged:true,positiveLegalAuthorityEnabled:false,
    writerExclusivityCertified:false,releaseCertified:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const result=await archiveBridge(process.env,readFileSync(".output/production-consolidation/owner.mjs"));
    console.log(JSON.stringify(result));
  }catch(error){
    const message=String(error?.message||"");
    console.error(/^bridge_provider_http_[0-9]{3}$/.test(message)?message:"bridge_archive_failed_closed");
    process.exitCode=1;
  }
}
