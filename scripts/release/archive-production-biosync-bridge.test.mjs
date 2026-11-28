/* eslint-disable prettier/prettier -- explicit fixture for exact archive transaction */
import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {archiveBridge,buildBridgeMetadata,verifyCandidate} from "./archive-production-biosync-bridge.mjs";
const ownerVersion="3463ff93-f077-40bf-a4d5-fb7bfc143cd5",backendVersion="401f2af2-6e69-4611-8110-1d127af6eecf";
const candidateId="33333333-3333-4333-8333-333333333333";
const client="a".repeat(64),head="b".repeat(40);
const env={
  GITHUB_REPOSITORY:"JibrilMohamud/cove",GITHUB_REF:"refs/heads/main",
  GITHUB_EVENT_NAME:"workflow_dispatch",COVE_REVIEWED_MAIN_SHA:head,GITHUB_SHA:head,
  COVE_CF_WORKERS_METADATA_READ_TOKEN:"r".repeat(32),COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN:"w".repeat(32),
  COVE_BIOSYNC_PROD_CLIENT_SECRET:client
};
const secretNames=["COVE_LITERARY_HANDOFF_SECRET","COVE_LITERARY_PUBLICATION_SECRET","COVE_LITERARY_READ_SECRET",
  "COVE_PUBLICATION_SOURCE_READER_SECRET","COVE_RIGHTS_OWNER_SECRET","COVE_SOUNDS_SOURCE_READER_SECRET","STRIPE_SECRET_KEY"];
const runtime={migration_tag:"legal-authority-production-locked-v1",compatibility_date:"2026-10-25"};
const fixture=()=>({
  id:ownerVersion,resources:{script_runtime:runtime,bindings:[
    ...secretNames.map(name=>({name,type:"secret_text"})),
    {name:"LEGAL_AUTHORITY",type:"durable_object_namespace",class_name:"CoveLegalAuthority",namespace_id:"83d7eadf3957436389a7b072120a9829"},
    {name:"PRIMARY_DB",type:"d1",id:"4bd657ac-8789-403e-a28c-93aba8d0a989"},
    {name:"LITERARY_CONTENT_DB",type:"d1",id:"400c3af3-5d40-41fd-83cc-98228e40ddac"},
    {name:"LITERARY_BUCKET",type:"r2_bucket",bucket_name:"cove-literary-originals-isolated-20261024"},
    {name:"COVE_RIGHTS_OWNER_ENABLED",type:"plain_text",text:"0"},
    {name:"COVE_RIGHTS_OWNER_PRIMARY_ID",type:"plain_text",text:"4bd657ac-8789-403e-a28c-93aba8d0a989"},
    {name:"STRIPE_LIVEMODE",type:"plain_text",text:"true"}
  ]}
});
function candidate(old,meta){
  return {id:candidateId,resources:{script_runtime:runtime,script:{named_handlers:[{name:"CoveBioSyncEntrypoint",handlers:["fetch"]}]},
    bindings:meta.bindings.map(b=>b.type==="inherit"?old.resources.bindings.find(x=>x.name===b.name):
      b.type==="secret_text"?{name:b.name,type:b.type}:b)}};
}
test("archive metadata retains exact namespace and existing secrets without receiving plaintext",()=>{
  const old=fixture(),m=buildBridgeMetadata(old,client,head);
  assert.equal(m.migrations,undefined);
  assert.equal(m.bindings.filter(b=>b.type==="inherit").length,7);
  assert.ok(m.bindings.filter(b=>b.type==="inherit").every(b=>b.version_id==="latest"&&!Object.hasOwn(b,"text")));
  assert.equal(m.bindings.find(b=>b.name==="COVE_BIOSYNC_CLIENT_TOKEN_SHA256").text,createHash("sha256").update(client).digest("hex"));
  assert.ok(!JSON.stringify(m).includes(client));
  assert.equal(m.bindings.find(b=>b.name==="COVE_RIGHTS_OWNER_ENABLED").text,"0");
  verifyCandidate(old,candidate(old,m));
  const broken=candidate(old,m);broken.resources.bindings.find(b=>b.name==="LEGAL_AUTHORITY").namespace_id="wrong";
  assert.throws(()=>verifyCandidate(old,broken));
});
function mock({latest=ownerVersion,corrupt=false}={}){
  let posts=0;let checks=0;let archived;
  const requests=[];
  const transport=async(url,opts)=>{
    requests.push({url,method:opts.method});
    const isOwner=url.includes("/cove-legal-authority-production/");
    assert.equal(opts.headers.authorization,"Bearer "+(opts.method==="POST"?env.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN:env.COVE_CF_WORKERS_METADATA_READ_TOKEN));
    let result;
    if(url.endsWith("/deployments")){
      checks++;result={deployments:[{versions:[{version_id:isOwner?ownerVersion:backendVersion,percentage:100}]}]};
    }else if(url.endsWith("/schedules"))result={schedules:isOwner?[]:["* * * * *","*/5 * * * *","*/10 * * * *","7-57/10 * * * *","23 * * * *","17 3 * * *","41 4 * * *"].map(cron=>({cron}))};
    else if(url.endsWith("/subdomain"))result={enabled:false,previews_enabled:false};
    else if(url.endsWith("/versions/"+ownerVersion))result=fixture();
    else if(url.endsWith("/versions?per_page=3"))result={items:[{id:latest}]};
    else if(url.endsWith("/versions?bindings_inherit=strict")){
      assert.equal(opts.method,"POST");assert.ok(isOwner);posts++;
      const meta=JSON.parse(await opts.body.get("metadata").text());
      archived=candidate(fixture(),meta);
      if(corrupt)archived.resources.bindings.find(b=>b.name==="PRIMARY_DB").database_id="wrong";
      result={id:candidateId};
    }else if(url.endsWith("/versions/"+candidateId))result=archived;
    else throw Error("unexpected endpoint");
    return Response.json({success:true,result});
  };
  return {transport,stats:()=>({posts,checks,requests})};
}
test("only one version upload, then independent owner and backend deployment fences",async()=>{
  const f=mock(),r=await archiveBridge(env,Buffer.alloc(1200),f.transport);
  assert.equal(r.candidateTraffic,0);
  assert.equal(r.productionTrafficUnchanged,true);
  assert.equal(f.stats().posts,1);assert.equal(f.stats().checks,4);
  assert.equal(f.stats().requests.filter(x=>x.method==="POST").length,1);
});
test("refuses latest-version drift before upload and rechecks traffic after candidate failure",async()=>{
  const drift=mock({latest:candidateId});
  await assert.rejects(archiveBridge(env,Buffer.alloc(1200),drift.transport),/latest_owner_version_drift/);
  assert.equal(drift.stats().posts,0);
  const broken=mock({corrupt:true});
  await assert.rejects(archiveBridge(env,Buffer.alloc(1200),broken.transport));
  assert.equal(broken.stats().posts,1);assert.equal(broken.stats().checks,4);
});
