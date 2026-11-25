/* eslint-disable prettier/prettier -- immutable provider boundary and protected rollout */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {pathToFileURL} from "node:url";
import {verifyCandidate} from "./archive-production-biosync-bridge.mjs";
import {verifyProductionBioSyncCredentials} from "./production-biosync-credential-preflight.mjs";

const account="d26430caa63ec55f6612e32f36aca5e9";
const owner="cove-legal-authority-production",backend="cove-persistence-backend",ingress="cove-biosync-production-ingress";
const old="ed1ffa2a-5a20-40af-8f3c-4906f41f7c50",original="3463ff93-f077-40bf-a4d5-fb7bfc143cd5";
const backendVersion="401f2af2-6e69-4611-8110-1d127af6eecf",ingressVersion="ca0f6663-afa3-43a0-b36d-60545d4c47f5";
const primary="4bd657ac-8789-403e-a28c-93aba8d0a989",literary="400c3af3-5d40-41fd-83cc-98228e40ddac";
const hourly="25 * * * *",probe="*/2 * * * *";
const crons=["* * * * *","*/5 * * * *","*/10 * * * *","7-57/10 * * * *","23 * * * *","17 3 * * *","41 4 * * *"].sort();
const root="https://api.cloudflare.com/client/v4/accounts/"+account;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const active=(d,id)=>{const rows=d?.deployments?.[0]?.versions;if(!Array.isArray(rows)||rows.length!==1||rows[0].version_id!==id||rows[0].percentage!==100)throw Error("budget_active_version_drift");};
const schedule=(s,expected)=>{if(!Array.isArray(s?.schedules)||JSON.stringify(s.schedules.map(x=>x.cron).sort())!==JSON.stringify([...expected].sort()))throw Error("budget_schedule_drift");};
const resource=b=>{
  if(b.type==="secret_text")return {name:b.name,type:b.type};
  if(b.type==="d1")return {name:b.name,type:b.type,database_id:b.database_id??b.id};
  if(b.type==="r2_bucket")return {name:b.name,type:b.type,bucket_name:b.bucket_name};
  if(b.type==="durable_object_namespace")return {name:b.name,type:b.type,class_name:b.class_name,namespace_id:b.namespace_id};
  if(b.type==="plain_text")return {name:b.name,type:b.type,text:b.text};
  throw Error("budget_unexpected_binding");
};
const flag=(name,text)=>({name,type:"plain_text",text});
const added=sha=>[flag("COVE_PRODUCTION_LITERARY_BUDGET_CRON_ENABLED","1"),flag("COVE_PRODUCTION_LITERARY_BUDGET_RELEASE_SHA",sha)];
export function metadata(previous,sha){
  assert.equal(previous.id,old);
  assert.match(sha,/^[a-f0-9]{40}$/);
  const rows=previous.resources.bindings;
  assert.equal(rows.length,18);
  assert.equal(rows.find(x=>x.name==="COVE_RIGHTS_OWNER_ENABLED")?.text,"0");
  assert.equal(rows.find(x=>x.name==="COVE_PRODUCTION_BIOSYNC_BRIDGE_ENABLED")?.text,"1");
  assert.equal(previous.resources.script_runtime.migration_tag,"legal-authority-production-locked-v1");
  assert.equal(previous.resources.script_runtime.compatibility_date,"2026-10-25");
  return {main_module:"owner.mjs",compatibility_date:"2026-10-25",compatibility_flags:["nodejs_compat"],
    bindings:[...rows.map(b=>b.type==="secret_text"?{name:b.name,type:"inherit",version_id:"latest"}:resource(b)),...added(sha)],
    annotations:{"workers/commit_sha":sha,"workers/message":"Native isolated literary budget cron; BioSync bridge preserved"}};
}
export function checkVersion(previous,next,sha){
  assert.notEqual(next.id,previous.id);
  const normalize=rows=>rows.map(resource).sort((a,b)=>a.name.localeCompare(b.name));
  assert.deepEqual(normalize(next.resources.bindings),normalize([...previous.resources.bindings,...added(sha)]));
  assert.deepEqual(next.resources.script_runtime,previous.resources.script_runtime);
  assert.deepEqual(next.resources.script.named_handlers,previous.resources.script.named_handlers);
  assert.equal(next.annotations?.["workers/commit_sha"],sha);
}
// Only exact, immutable read requests are eligible for transient recovery.
// No archive, deployment, cron PUT, or owner publication call is replayed.
export function retryBudgetReads(transport=fetch,wait=pause){
  return async(url,options={})=>{
    const endpoint=new URL(url);
    const method=options.method||"GET";
    const expectedRoot="/client/v4/accounts/"+account+"/";
    const query=method==="POST"&&endpoint.pathname.startsWith(expectedRoot+"d1/database/")&&endpoint.pathname.endsWith("/query");
    const read=endpoint.origin==="https://api.cloudflare.com"&&endpoint.pathname.startsWith(expectedRoot)&&
      (method==="GET"||(query&&/^SELECT\b/.test(JSON.parse(options.body||"{}").sql||"")));
    if(!read)return transport(url,options);
    for(let attempt=0;attempt<4;attempt++){
      let response;
      try{response=await transport(url,{...options,signal:AbortSignal.timeout(15000)}); }
      catch(error){
        if(attempt===3||!["TypeError","TimeoutError"].includes(error?.name))throw error;
        console.warn("budget_read_transport_retry_"+(attempt+1));
        await wait(2000*(2**attempt));continue;
      }
      if(attempt===3||![429,500,502,503,504].includes(response.status))return response;
      const seconds=Number(response.headers.get("retry-after"));
      await response.body?.cancel().catch(()=>{});
      console.warn("budget_read_http_"+response.status+"_retry_"+(attempt+1));
      await wait(Math.max(2000*(2**attempt),Number.isFinite(seconds)?Math.min(30000,Math.max(0,seconds)*1000):0));
    }
    throw Error("budget_read_retry_exhausted");
  };
}
export async function cutover(env,code,{transport=fetch,preflight=verifyProductionBioSyncCredentials,wait=pause,clock=Date.now,replay}={}){
  const readTransport=retryBudgetReads(transport,wait);
  let admissionPhase="admission";
  const checkpoint=name=>{admissionPhase=name;console.log("budget_phase_"+name);};
  let candidate,changed=false,phase="archive";
  try{
  assert.equal(env.GITHUB_REPOSITORY,"JibrilMohamud/cove");
  assert.equal(env.GITHUB_REF,"refs/heads/main");
  assert.equal(env.GITHUB_EVENT_NAME,"workflow_dispatch");
  assert.equal(env.COVE_REVIEWED_MAIN_SHA,env.GITHUB_SHA);
  assert.equal(env.COVE_CONFIRM_BUDGET_ACTIVATION,"true");
  assert.match(env.GITHUB_SHA||"",/^[a-f0-9]{40}$/);
  assert.ok(!env.CLOUDFLARE_API_TOKEN);
  const read=env.COVE_CF_WORKERS_METADATA_READ_TOKEN,write=env.COVE_CF_STAGE_WORKERS_DEPLOY_TOKEN,d1=env.COVE_BIOSYNC_PROD_D1_READ_TOKEN;
  assert.ok([read,write,d1].every(x=>typeof x==="string"&&x.length>=24));
  assert.equal(new Set([read,write,d1]).size,3);
  assert.ok(code.byteLength>1000&&code.byteLength<10*1024*1024);
  checkpoint("credential_preflight");
  // Reuse the exact scoped-credential verifier from the successful BioSync
  // activation. A missing permission/identity is never considered transient.
  const proof=await preflight(env,readTransport);
  assert.equal(proof.realD1Read,true,"budget_d1_read_not_proven");
  assert.equal(proof.realR2List,true,"budget_r2_read_not_proven");
  console.log("budget_scoped_d1_and_r2_verified");
  async function req(path,token,method="GET",body){
    const send=method==="GET"||(method==="POST"&&path.startsWith("/d1/database/"))?readTransport:transport;
    const r=await send(root+path,{method,headers:{authorization:"Bearer "+token,...(body&&!(body instanceof FormData)?{"content-type":"application/json"}:{})},
      ...(body?{body:body instanceof FormData?body:JSON.stringify(body)}:{}),redirect:"error",signal:AbortSignal.timeout(90000)});
    if(!r.ok){const kind=path.includes("/d1/database/")?"d1":path.includes("/versions")?"versions":path.includes("/schedules")?"schedules":path.includes("/subdomain")?"subdomain":"deployments";throw Error("budget_"+kind+"_"+method.toLowerCase()+"_http_"+r.status);}
    const j=await r.json();if(j.success!==true)throw Error("budget_provider_rejected");return j.result;
  }
  const worker=(name,suffix)=>"/workers/scripts/"+name+suffix;
  const get=(name,suffix)=>req(worker(name,suffix),read);
  const upload=form=>req(worker(owner,"/versions?bindings_inherit=strict"),write,"POST",form);
  const deploy=id=>req(worker(owner,"/deployments"),write,"POST",{strategy:"percentage",code_update_strategy:{mode:"immediate"},versions:[{version_id:id,percentage:100}]});
  const setCrons=values=>req(worker(owner,"/schedules"),write,"PUT",values.map(cron=>({cron})));
  const query=async(id,sql,params=[])=>{
    assert.ok([primary,literary].includes(id)&&/^SELECT\b/.test(sql));
    const result=await req("/d1/database/"+id+"/query",d1,"POST",{sql,params});
    assert.equal(result.length,1);assert.equal(result[0].success,true);return result[0].results;
  };
  async function topology(id,expected){
    const [o,b,i,oc,bc,ic,os,is]=await Promise.all([get(owner,"/deployments"),get(backend,"/deployments"),get(ingress,"/deployments"),
      get(owner,"/schedules"),get(backend,"/schedules"),get(ingress,"/schedules"),get(owner,"/subdomain"),get(ingress,"/subdomain")]);
    active(o,id);active(b,backendVersion);active(i,ingressVersion);schedule(oc,expected);schedule(bc,crons);schedule(ic,[]);
    assert.equal(os.enabled,false);assert.equal(os.previews_enabled,false);assert.equal(is.enabled,true);assert.equal(is.previews_enabled,false);
  }
  checkpoint("pinned_topology");
  await topology(old,[]);
  // Only overlap with the legacy scheduler while today's budget is already
  // active. Never conduct the probe during a UTC day transition.
  const start=clock(),day=new Date(start).toISOString().slice(0,10),previousDay=new Date(Date.parse(day+"T00:00:00Z")-86400000).toISOString().slice(0,10);
  assert.ok(Date.parse(day+"T00:00:00Z")+86400000-start>40*60000,"budget_midnight_window");
  checkpoint("read_only_day_authority_and_archive");
  const [days,auth,priorMap,previous,baseVersion,list]=await Promise.all([
    query(literary,"SELECT day,status FROM literary_budget_cutover WHERE day IN (?,?) ORDER BY day",[previousDay,day]),
    query(primary,"SELECT key,value FROM cove_runtime_config WHERE key IN ('literary_processing_owner','literary_budget_domain') ORDER BY key"),
    query(primary,"SELECT m.map_sha256 FROM audio_timing m JOIN audio_jobs j ON j.id='align-pg-19504-02-7fb5b7e4c4a400b1' AND j.status='done' JOIN audio_editions e ON e.id=m.edition_id AND e.epub_sha256=m.epub_sha256 WHERE m.edition_id='pg-19504' AND m.track_id='02' AND json_extract(j.payload_json,'$.audioSha256')=m.audio_sha256"),
    get(owner,"/versions/"+old),get(owner,"/versions/"+original),get(owner,"/versions?per_page=3")
  ]);
  if(days.length!==2||days[0].day!==previousDay||days[1].day!==day||days.some(x=>x.status!=="active"))throw Error("budget_current_or_previous_day_not_active");
  if(auth.length!==2||auth[0].key!=="literary_budget_domain"||auth[1].key!=="literary_processing_owner"||auth.some(x=>x.value!=="isolated"))throw Error("budget_literary_authority_not_isolated");
  assert.equal(priorMap.length,1,"budget_pinned_biosync_map_missing");assert.match(priorMap[0].map_sha256,/^[a-f0-9]{64}$/,"budget_pinned_biosync_digest_invalid");
  checkpoint("existing_owner_binding_fence");
  verifyCandidate(baseVersion,previous);
  const clean={PATH:env.PATH,HOME:env.HOME,COVE_BIOSYNC_PROD_OWNER_MODE:"1",COVE_BIOSYNC_PROD_D1_READ_TOKEN:d1,
    COVE_BIOSYNC_PROD_R2_TOKEN:env.COVE_BIOSYNC_PROD_R2_TOKEN,COVE_BIOSYNC_PROD_CLIENT_SECRET:env.COVE_BIOSYNC_PROD_CLIENT_SECRET,
    BIOSYNC_AUTO_SHORT:"0",BIOSYNC_PROVE_OWNER_REPLAY:"1"};
  const verifyReplay=replay??(()=>{
    try{return execFileSync("python3",["-m","scripts.audio_pipeline.biosync_canary"],{env:clean,encoding:"utf8",timeout:120000,stdio:["ignore","pipe","pipe"]});}
    catch(error){
      const stderr=String(error?.stderr||"");
      const known=stderr.match(/(?:RuntimeError: )(biosync_owner_[a-z0-9_]+|Scoped BioSync (?:provider request|S3 GET) failed: HTTP [0-9]{3})\s*$/);
      const code=known?.[1]?.toLowerCase().replace(/[^a-z0-9]+/g,"_");
      throw Error(code?"budget_replay_"+code:"budget_replay_subprocess_failed");
    }
  });
  checkpoint("existing_biosync_replay");
  assert.ok(verifyReplay().includes("cove_biosync_production_owner_replay_verified"),"budget_existing_replay_missing");
  checkpoint("archive");
  try{
    const latest=list.items?.[0];
    if(latest?.id===old){
      const form=new FormData();
      form.append("metadata",new Blob([JSON.stringify(metadata(previous,env.GITHUB_SHA))],{type:"application/json"}));
      form.append("owner.mjs",new Blob([code],{type:"application/javascript+module"}),"owner.mjs");
      const receipt=await upload(form);candidate=receipt.id;
    }else{
      assert.equal(latest?.annotations?.["workers/commit_sha"],env.GITHUB_SHA,"budget_latest_version_drift");
      candidate=latest.id;
    }
    assert.match(candidate,/^[0-9a-f-]{36}$/);
    checkVersion(previous,await get(owner,"/versions/"+candidate),env.GITHUB_SHA);
    await topology(old,[]);
    phase="activate";checkpoint(phase);changed=true;
    await deploy(candidate);await topology(candidate,[]);
    assert.ok(verifyReplay().includes("cove_biosync_production_owner_replay_verified"));
    phase="probe_schedule";checkpoint(phase);
    const after=clock();
    await setCrons([probe]);await topology(candidate,[probe]);
    let witness=null;
    for(let i=0;i<82;i++){
      const table=await query(literary,"SELECT name FROM sqlite_master WHERE type='table' AND name='literary_owner_budget_tick_receipt'");
      if(table.length){
        const rows=await query(literary,"SELECT release_sha,scheduled_ms,cron,day,state FROM literary_owner_budget_tick_receipt WHERE id=1");
        const r=rows[0];
        if(r?.release_sha===env.GITHUB_SHA&&r.scheduled_ms>=after&&r.cron===probe&&r.day===day&&["active","already_active"].includes(r.state)){witness=r;break;}
      }
      await wait(15000);
    }
    assert.ok(witness,"budget_real_cron_receipt_missing");
    phase="hourly_schedule";checkpoint(phase);
    await setCrons([hourly]);await topology(candidate,[hourly]);
    assert.ok(verifyReplay().includes("cove_biosync_production_owner_replay_verified"));
    console.log(JSON.stringify({schema:"cove.production-literary-budget-owner.v1",ownerVersion:candidate,releaseSha:env.GITHUB_SHA,realScheduledReceipt:witness,permanentCron:hourly,biosyncReplay:true,legacyJobUnchanged:true,primaryMutation:false,releaseCertified:false}));
  }catch(error){
    console.error("budget_cutover_phase_"+phase);
    if(changed){
      try{await setCrons([]);await deploy(old);await topology(old,[]);
        assert.ok(verifyReplay().includes("cove_biosync_production_owner_replay_verified"));console.error("budget_rollback_verified");
      }catch{console.error("budget_rollback_requires_operator");}
    }
    throw error;
  }
  }catch(error){
    console.error("budget_failed_phase_"+admissionPhase);
    throw error;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{await cutover(process.env,readFileSync(".output/production-consolidation/owner.mjs"));}
  catch(error){const m=String(error?.message||"");console.error(/^(budget_|biosync_preflight_)[a-z0-9_]+$/.test(m)?m:"budget_cutover_failed_closed");process.exitCode=1;}
}
