/* eslint-disable prettier/prettier -- exact provider fixtures and failure injection */
import {test} from "node:test";
import assert from "node:assert/strict";
import {buildBridgeMetadata} from "./archive-production-biosync-bridge.mjs";
import {cutover,metadata,checkVersion,retryBudgetReads} from "./activate-production-literary-budget-owner.mjs";
const original="3463ff93-f077-40bf-a4d5-fb7bfc143cd5",old="ed1ffa2a-5a20-40af-8f3c-4906f41f7c50",candidate="33333333-3333-4333-8333-333333333333";
const backend="401f2af2-6e69-4611-8110-1d127af6eecf",ingress="ca0f6663-afa3-43a0-b36d-60545d4c47f5";
const primary="4bd657ac-8789-403e-a28c-93aba8d0a989",literary="400c3af3-5d40-41fd-83cc-98228e40ddac";
const sha="a".repeat(40),now=Date.parse("2026-11-25T12:00:00Z"),day="2026-11-25",client="c".repeat(64);
const read="r".repeat(32),write="w".repeat(32),d1="d".repeat(32);
const env={GITHUB_REPOSITORY:"JibrilMohamud/cove",GITHUB_REF:"refs/heads/main",GITHUB_EVENT_NAME:"workflow_dispatch",GITHUB_SHA:sha,COVE_REVIEWED_MAIN_SHA:sha,COVE_CONFIRM_BUDGET_ACTIVATION:"true",COVE_CF_WORKERS_METADATA_READ_TOKEN:read,COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN:write,COVE_BIOSYNC_PROD_D1_READ_TOKEN:d1};
const secrets=["COVE_LITERARY_HANDOFF_SECRET","COVE_LITERARY_PUBLICATION_SECRET","COVE_LITERARY_READ_SECRET","COVE_PUBLICATION_SOURCE_READER_SECRET","COVE_RIGHTS_OWNER_SECRET","COVE_SOUNDS_SOURCE_READER_SECRET","STRIPE_SECRET_KEY"];
const rt={migration_tag:"legal-authority-production-locked-v1",compatibility_date:"2026-10-25"};
const first={id:original,resources:{script_runtime:rt,bindings:[
  ...secrets.map(name=>({name,type:"secret_text"})),
  {name:"LEGAL_AUTHORITY",type:"durable_object_namespace",class_name:"CoveLegalAuthority",namespace_id:"83d7eadf3957436389a7b072120a9829"},
  {name:"PRIMARY_DB",type:"d1",id:primary},{name:"LITERARY_CONTENT_DB",type:"d1",id:literary},
  {name:"LITERARY_BUCKET",type:"r2_bucket",bucket_name:"cove-literary-originals-isolated-20261024"},
  {name:"COVE_RIGHTS_OWNER_ENABLED",type:"plain_text",text:"0"},
  {name:"COVE_RIGHTS_OWNER_PRIMARY_ID",type:"plain_text",text:primary},
  {name:"STRIPE_LIVEMODE",type:"plain_text",text:"true"}
]}};
function version(id,prior,m){
  return {id,annotations:m.annotations,resources:{script_runtime:{...rt,compatibility_flags:["nodejs_compat"]},
    script:{named_handlers:[{name:"CoveBioSyncEntrypoint",handlers:["fetch"]}]},
    bindings:m.bindings.map(b=>b.type==="inherit"?prior.resources.bindings.find(x=>x.name===b.name):b.type==="secret_text"?{name:b.name,type:b.type}:b)}};
}
const previous=version(old,first,buildBridgeMetadata(first,client,"b".repeat(40)));
test("only exact budget flags are added; all eight secrets inherited and legal disabled",()=>{
  const m=metadata(previous,sha);
  assert.equal(m.bindings.filter(b=>b.type==="inherit").length,8);
  assert.ok(m.bindings.filter(b=>b.type==="inherit").every(b=>!Object.hasOwn(b,"text")));
  assert.equal(m.bindings.find(b=>b.name==="COVE_RIGHTS_OWNER_ENABLED").text,"0");
  const v=version(candidate,previous,m);checkVersion(previous,v,sha);
  const broken=structuredClone(v);
  broken.resources.bindings.find(b=>b.name==="COVE_RIGHTS_OWNER_ENABLED").text="1";
  assert.throws(()=>checkVersion(previous,broken,sha));
});
function mock({receipt=true,activeDay=true}={}){
  let live=old,schedules=[],uploaded,posts=0,mutations=[];
  const transport=async(url,opts)=>{
    const path=new URL(url).pathname,method=opts.method,body=opts.body;
    const isD1=path.includes("/d1/database/"),isOwner=path.includes("/cove-legal-authority-production/"),isIngress=path.includes("/cove-biosync-production-ingress/");
    assert.equal(opts.headers.authorization,"Bearer "+(isD1?d1:method==="GET"?read:write));
    let result;
    if(isD1){
      const {sql}=JSON.parse(body);assert.match(sql,/^SELECT\b/);
      let rows;
      if(sql.includes("day IN"))rows=[{day:"2026-11-24",status:"active"},{day,status:activeDay?"active":"prepared"}];
      else if(sql.includes("cove_runtime_config"))rows=[{key:"literary_budget_domain",value:"isolated"},{key:"literary_processing_owner",value:"isolated"}];
      else if(sql.includes("audio_timing"))rows=[{map_sha256:"e".repeat(64)}];
      else if(sql.includes("sqlite_master"))rows=receipt?[{name:"literary_owner_budget_tick_receipt"}]:[];
      else if(sql.includes("FROM literary_owner_budget_tick_receipt"))rows=[{release_sha:sha,scheduled_ms:now+60000,cron:"*/2 * * * *",day,state:"already_active"}];
      else throw Error("unexpected sql");
      result=[{success:true,results:rows}];
    }else if(path.endsWith("/deployments")){
      if(method==="POST"){assert.ok(isOwner);live=JSON.parse(body).versions[0].version_id;mutations.push("deploy:"+live);}
      result={deployments:[{versions:[{version_id:isOwner?live:isIngress?ingress:backend,percentage:100}]}]};
    }else if(path.endsWith("/schedules")){
      if(method==="PUT"){assert.ok(isOwner);schedules=JSON.parse(body).map(x=>x.cron);mutations.push("cron:"+schedules.join(","));}
      result={schedules:(isOwner?schedules:isIngress?[]:["* * * * *","*/5 * * * *","*/10 * * * *","7-57/10 * * * *","23 * * * *","17 3 * * *","41 4 * * *"]).map(cron=>({cron}))};
    }else if(path.endsWith("/subdomain"))result={enabled:isIngress,previews_enabled:false};
    else if(path.endsWith("/versions/"+old))result=previous;
    else if(path.endsWith("/versions/"+original))result=first;
    else if(path.endsWith("/versions/"+candidate))result=uploaded;
    else if(path.endsWith("/versions")&&method==="GET")result={items:[{id:old}]};
    else if(path.endsWith("/versions")&&method==="POST"){assert.ok(isOwner);posts++;uploaded=version(candidate,previous,JSON.parse(await body.get("metadata").text()));result={id:candidate};}
    else throw Error("unexpected endpoint "+path);
    return Response.json({success:true,result});
  };
  return {options:{transport,preflight:async()=>({realD1Read:true,realR2List:true}),clock:()=>now,wait:async()=>{},replay:()=>"cove_biosync_production_owner_replay_verified"},stats:()=>({live,schedules,posts,mutations})};
}
test("real witness required before permanent hourly cron; never write D1 via provider",async()=>{
  const x=mock();await cutover(env,Buffer.alloc(1200),x.options);
  assert.deepEqual(x.stats(),{live:candidate,schedules:["25 * * * *"],posts:1,mutations:["deploy:"+candidate,"cron:*/2 * * * *","cron:25 * * * *"]});
});
test("missing cron witness restores previous BioSync owner and empty schedule",async()=>{
  const x=mock({receipt:false});await assert.rejects(cutover(env,Buffer.alloc(1200),x.options),/budget_real_cron_receipt_missing/);
  assert.equal(x.stats().live,old);assert.deepEqual(x.stats().schedules,[]);assert.deepEqual(x.stats().mutations.slice(-2),["cron:","deploy:"+old]);
});
test("nonactive day blocks all provider mutations",async()=>{
  const x=mock({activeDay:false});await assert.rejects(cutover(env,Buffer.alloc(1200),x.options));
  assert.equal(x.stats().posts,0);assert.deepEqual(x.stats().mutations,[]);
});

test("bounded retries apply only to provider reads, never deployment or cron mutations",async()=>{
  let calls=0;const delays=[];
  const transport=async()=>{calls++;return new Response(null,{status:calls===1?429:200,headers:{"retry-after":"1"}});};
  const send=retryBudgetReads(transport,async ms=>delays.push(ms));
  const root="https://api.cloudflare.com/client/v4/accounts/d26430caa63ec55f6612e32f36aca5e9";
  assert.equal((await send(root+"/workers/scripts/x/deployments",{method:"GET"})).status,200);
  assert.equal(calls,2);assert.deepEqual(delays,[2000]);
  calls=0;assert.equal((await send(root+"/workers/scripts/x/deployments",{method:"POST",body:"{}"})).status,429);assert.equal(calls,1);
  calls=0;assert.equal((await send(root+"/d1/database/x/query",{method:"POST",body:JSON.stringify({sql:"SELECT 1"})})).status,200);assert.equal(calls,2);
  calls=0;assert.equal((await send(root+"/d1/database/x/query",{method:"POST",body:JSON.stringify({sql:"UPDATE x SET a=1"})})).status,429);assert.equal(calls,1);
  calls=0;assert.equal((await send(root+"/workers/scripts/x/schedules",{method:"PUT",body:"[]"})).status,429);assert.equal(calls,1);
  const denied=retryBudgetReads(async()=>{calls++;return new Response(null,{status:403});},async()=>{throw Error("unexpected retry")});
  calls=0;assert.equal((await denied(root+"/tokens/verify",{method:"GET"})).status,403);assert.equal(calls,1);
});
test("preflight failure preserves exact reason, never touches provider mutation",async()=>{
  const x=mock();
  await assert.rejects(cutover(env,Buffer.alloc(1200),{...x.options,preflight:async()=>{throw Error("biosync_preflight_token_scope");}}),/biosync_preflight_token_scope/);
  assert.deepEqual(x.stats().mutations,[]);
  await assert.rejects(cutover(env,Buffer.alloc(1200),{...x.options,preflight:async()=>({realD1Read:true,realR2List:false})}),/budget_r2_read_not_proven/);
  assert.deepEqual(x.stats().mutations,[]);
});
