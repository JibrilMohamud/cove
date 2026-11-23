/* eslint-disable prettier/prettier -- Ephemeral, protected, isolated QA owner-commit proof. */
/**
 * This is a REAL remote synthetic QA writer test. It never contacts Cove's
 * production account or primary, cannot grant rights, and publishes no
 * customer content. It requires the exact reviewed main SHA and three
 * separately scoped QA credentials. One typed owner command is committed
 * through a private Durable Object, then replay/denial/cleanup are proved.
 */
import assert from "node:assert/strict";
import {createHash,randomBytes} from "node:crypto";
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {QA_ACCOUNT,QA_DATABASE,QA_BUCKET} from "./prove-biosync-qa-data-plane.mjs";
import {proveBiosyncQaDataPlane} from "./prove-biosync-qa-data-plane.mjs";

const runId=process.env.GITHUB_RUN_ID+"-"+(process.env.GITHUB_RUN_ATTEMPT||"1");
const ownerName="cove-biosync-owner-qa-"+runId;
const gatewayName="cove-biosync-gateway-qa-"+runId;
const ownerOrigin="https://"+gatewayName+".cove-qa-reads.workers.dev";
const accountApi="https://api.cloudflare.com/client/v4/accounts/"+QA_ACCOUNT;
const dir=mkdtempSync(join(tmpdir(),"cove-hosted-biosync-owner-"));
// Wrangler resolves relative Worker main paths from the config directory.
// Keep the ephemeral configs in the reviewed repository checkout, and remove
// them even if a protected QA deployment fails.
const ownerConfig=join(process.cwd(),".cove-biosync-owner-"+runId+".jsonc");
const gatewayConfig=join(process.cwd(),".cove-biosync-gateway-"+runId+".jsonc");
const ownerSecrets=join(dir,"owner-secrets.json"),gatewaySecrets=join(dir,"gateway-secrets.json");
const audioSha="a".repeat(64),epubSha="b".repeat(64);
const now=new Date().toISOString();
const command={editionId:"qa-biosync-edition-"+runId,trackId:"01",
  jobId:"qa-biosync-align-"+runId,mapSha256:""};
const map={
  version:2,status:"checked",trackId:command.trackId,
  epubSha256:epubSha,audioSha256:audioSha,
  engine:"cloudflare-workers-ai-whisper",duration:30,
  verification:{method:"independent-asr-exact-text",
    automatic:true,confidenceMode:"unreported",minWordProbability:null,
    coverage:1,matchedWords:30,spokenWords:30,checkedAt:now,
    // This object is synthetic and is never used for customer playback.
    syntheticQa:true},
  words:Array.from({length:30},(_,i)=>({
    wordIndex:i,href:"OPS/synthetic.xhtml",
    cfi:"epubcfi(/6/2!/4/2:"+i+")",
    endCfi:"epubcfi(/6/2!/4/2:"+(i+1)+")",
    text:"synthetic",start:i*0.9,end:i*0.9+0.5,probability:null
  }))
};
const mapBytes=Buffer.from(JSON.stringify(map));
command.mapSha256=createHash("sha256").update(mapBytes).digest("hex");
const objectKey="biosync/maps/"+command.mapSha256+".json";
let ownerDeployed=false,gatewayDeployed=false,seedStarted=false,objectUploaded=false;
const failures=[];
const tokenNames=[
  "COVE_CF_QA_WORKERS_DEPLOY_TOKEN",
  "COVE_CF_QA_D1_MUTATION_TOKEN",
  "COVE_CF_QA_R2_STORAGE_TOKEN"
];
function refuse(message){throw Error("biosync_hosted_owner_qa_denied_"+message);}
function validInput(){
  if(process.env.GITHUB_REPOSITORY!=="JibrilMohamud/cove"||
     process.env.GITHUB_EVENT_NAME!=="workflow_dispatch"||
     process.env.GITHUB_REF!=="refs/heads/main"||
     !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA||"")||
     process.env.COVE_BIOSYNC_REVIEWED_MAIN_SHA!==process.env.GITHUB_SHA||
     process.env.COVE_BIOSYNC_PROTECTED_ENV!=="cove-production-release-audit")
    refuse("unreviewed_github_context");
  if(!/^[0-9]{8,15}-[0-9]{1,5}$/.test(runId)||
     process.env.CLOUDFLARE_ACCOUNT_ID!==QA_ACCOUNT)
    refuse("unsafe_cloudflare_account_or_run");
  const tokens=tokenNames.map(k=>process.env[k]);
  if(tokens.some(x=>typeof x!=="string"||x.length<24)||
    new Set(tokens).size!==tokens.length)refuse("scoped_credentials_missing_or_reused");
}
function wrangler(args,token=process.env.COVE_CF_QA_WORKERS_DEPLOY_TOKEN){
  const out=spawnSync("npm",["exec","--yes","--package=wrangler@4.151.0","--",
      "wrangler",...args],{encoding:"utf8",timeout:160000,
    env:{...process.env,CLOUDFLARE_API_TOKEN:token,
      CLOUDFLARE_ACCOUNT_ID:QA_ACCOUNT,CLOUDFLARE_SEND_METRICS:"false"}});
  if(out.status!==0){
    // Never log raw provider responses, which could contain secrets.
    throw Error("biosync_hosted_owner_wrangler_"+args[0]+"_failed");
  }
}
async function provider(method,endpoint,token,body=null,asJson=true){
  const response=await fetch(accountApi+endpoint,{
    method,headers:{authorization:"Bearer "+token,
      ...(body?{"content-type":asJson?"application/json":"application/octet-stream"}:{})},
    ...(body?{body:asJson?JSON.stringify(body):body}:{}),
    redirect:"error",signal:AbortSignal.timeout(25000)
  });
  if(!response.ok)refuse("qa_provider_http_"+response.status);
  if(method==="DELETE")return null;
  const data=await response.json().catch(()=>null);
  if(!data||data.success!==true)refuse("qa_provider_rejected");
  return data.result;
}
async function sql(query,params=[]){
  // Fixed dedicated QA primary only; SQL is entirely script-authored.
  const result=await provider("POST","/d1/database/"+QA_DATABASE+"/query",
    process.env.COVE_CF_QA_D1_MUTATION_TOKEN,{sql:query,params});
  if(!Array.isArray(result)||result.length!==1||result[0].success!==true)
    refuse("qa_d1_transaction_failed");
  return result[0];
}
function checkedOwnerReceipt(data,replay){
  assert.deepEqual(Object.keys(data).sort(),[
    "committed","editionId","jobId","mapSha256","replay","schema","trackId"].sort());
  assert.equal(data.schema,"cove.owner-biosync-checked-publication.v1");
  for(const k of ["editionId","trackId","jobId","mapSha256"])
    assert.equal(data[k],command[k]);
  assert.equal(data.committed,true);
  assert.equal(data.replay,replay);
}
async function callOwner(body,authorization,route="/biosync/publish-checked",method="POST"){
  const r=await fetch(ownerOrigin+route,{
    method,headers:{"authorization":"Bearer "+authorization,
      "content-type":"application/json"},
    ...(method==="POST"?{body:JSON.stringify(body)}:{}),
    redirect:"error",signal:AbortSignal.timeout(25000)
  });
  const data=r.status===200?await r.json():null;
  return {status:r.status,data};
}
function configuration(){
  const owner=JSON.parse(
    requireTemplate("wrangler.biosync-owner.qa.example.jsonc"));
  const gateway=JSON.parse(
    requireTemplate("wrangler.biosync-gateway.qa.example.jsonc"));
  const expires=String(Date.now()+14*60_000);
  const secret=randomBytes(32).toString("hex"),
    client=randomBytes(32).toString("hex");
  assert.notEqual(secret,client);
  owner.name=ownerName;
  owner.vars.COVE_RIGHTS_OWNER_ENABLED="1";
  owner.vars.COVE_RIGHTS_OWNER_TEST_EXPIRES_AT=expires;
  gateway.name=gatewayName;
  gateway.services[0].service=ownerName;
  gateway.workers_dev=true; // ONLY temporary authenticated QA gateway
  gateway.vars.COVE_BIOSYNC_QA_GATEWAY_ENABLED="1";
  gateway.vars.COVE_BIOSYNC_QA_GATEWAY_EXPIRES_AT=expires;
  if(owner.d1_databases?.[0]?.database_id!==QA_DATABASE||
     owner.r2_buckets?.[0]?.bucket_name!==QA_BUCKET||
     gateway.d1_databases!==undefined||gateway.r2_buckets!==undefined||
     owner.routes?.length||gateway.routes?.length||owner.workers_dev!==false)
    refuse("qa_worker_template_changed");
  for(const [file,data] of [[ownerConfig,owner],[gatewayConfig,gateway],
      [ownerSecrets,{COVE_RIGHTS_OWNER_SECRET:secret}],
      [gatewaySecrets,{COVE_RIGHTS_OWNER_SECRET:secret,
        COVE_BIOSYNC_QA_CLIENT_SECRET:client}]])
    writeFileSync(file,JSON.stringify(data),{mode:0o600});
  return {secret,client};
}
function requireTemplate(name){
  // This script runs only in a pinned GitHub repository checkout, never from
  // a caller-provided path or untrusted downloaded configuration.
  const p=new URL("../../"+name,import.meta.url);
  return (awaitRead(p));
}
function awaitRead(url){
  // Static Node file read avoids importing arbitrary module code.
  return readFileSync(url,"utf8");
}
async function seed(){
  seedStarted=true;
  await sql("INSERT INTO audio_editions"+
    "(id,gutenberg_id,book_id,title,authors_json,language,narration,narrator,"+
    "source_url,rights,tracks_json,alignment_json,epub_sha256,updated_at)"+
    " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",[
    command.editionId,"qa-synthetic-only",null,"Synthetic BioSync QA",
    JSON.stringify(["Synthetic QA"]),"en","synthetic","","https://example.invalid/qa",
    "Synthetic QA; never customer content",
    JSON.stringify([{id:command.trackId,sha256:audioSha,duration:30}]),
    null,epubSha,now
  ]);
  await sql("INSERT INTO audio_jobs"+
    "(id,kind,payload_json,status,attempts,next_attempt_at,lease_token,lease_until,last_error,updated_at)"+
    " VALUES(?,'align',?,'queued',0,?,NULL,NULL,'',?)",[
    command.jobId,JSON.stringify({editionId:command.editionId,
      trackId:command.trackId,audioSha256:audioSha}),now,now
  ]);
  // A timed-out R2 response can still have persisted bytes; always attempt
  // cleanup after the upload starts, even if no success receipt arrives.
  objectUploaded=true;
  const result=await provider("PUT","/r2/buckets/"+QA_BUCKET+"/objects/"+objectKey,
    process.env.COVE_CF_QA_R2_STORAGE_TOKEN,mapBytes,false);
  if(result?.key!==objectKey)refuse("qa_map_upload_mismatched");
}
async function cleanup(){
  // Ephemeral scripts' QA lease expires after 14 minutes even if deletion
  // fails. Every cleanup is scoped to our run-derived QA names only.
  // Delete on *attempted* upload, including when Wrangler fails after
  // creating a Worker but before returning a successful deploy receipt.
  if(gatewayDeployed)try{wrangler(["delete","--config",gatewayConfig,"--force"])}
  catch{ /* Independent provider inventory below resolves partial creation. */ }
  if(ownerDeployed)try{wrangler(["delete","--config",ownerConfig,"--force"])}
  catch{ /* Independent provider inventory below resolves partial creation. */ }
  if(ownerDeployed||gatewayDeployed)try{
    const workers=await provider("GET","/workers/scripts",
      process.env.COVE_CF_QA_WORKERS_DEPLOY_TOKEN);
    if(!Array.isArray(workers)||
       workers.some(x=>x?.id===ownerName||x?.id===gatewayName))
      failures.push("qa_ephemeral_worker_residual");
  }catch{failures.push("qa_worker_cleanup_inventory_unavailable")}
  if(objectUploaded){
    try{
      await provider("DELETE","/r2/buckets/"+QA_BUCKET+"/objects/"+objectKey,
        process.env.COVE_CF_QA_R2_STORAGE_TOKEN);
    }catch{ /* Verify actual absence independently below. */ }
    try{
      const objects=await provider("GET","/r2/buckets/"+QA_BUCKET+"/objects"+
          "?prefix="+encodeURIComponent(objectKey)+"&per_page=10",
        process.env.COVE_CF_QA_R2_STORAGE_TOKEN);
      const rows=Array.isArray(objects)?objects:objects?.objects;
      if(!Array.isArray(rows)||rows.some(x=>x?.key===objectKey))
        failures.push("qa_r2_residual_map");
    }catch{failures.push("qa_r2_cleanup_inventory_unavailable")}
  }
  if(seedStarted){
    for(const [q,params] of [
      ["DELETE FROM audio_timing WHERE edition_id=? AND track_id=?",
        [command.editionId,command.trackId]],
      ["DELETE FROM audio_jobs WHERE id=?",[command.jobId]],
      ["DELETE FROM audio_editions WHERE id=?",[command.editionId]]
    ])try{await sql(q,params)}
    catch{failures.push("qa_d1_cleanup_failed")}
    try{
      const count=await sql("SELECT (SELECT COUNT(*) FROM audio_timing WHERE edition_id=?) timing,"+
        "(SELECT COUNT(*) FROM audio_jobs WHERE id=?) jobs,"+
        "(SELECT COUNT(*) FROM audio_editions WHERE id=?) editions",[
          command.editionId,command.jobId,command.editionId
        ]);
      if(count.results?.length!==1||count.results[0].timing!==0||
         count.results[0].jobs!==0||count.results[0].editions!==0)
        failures.push("qa_d1_residual_synthetic_rows");
    }catch{failures.push("qa_d1_cleanup_inventory_unavailable")}
  }
}
async function main(){
  validInput();
  await proveBiosyncQaDataPlane({
    COVE_CF_QA_D1_MUTATION_TOKEN:process.env.COVE_CF_QA_D1_MUTATION_TOKEN,
    COVE_CF_QA_R2_STORAGE_TOKEN:process.env.COVE_CF_QA_R2_STORAGE_TOKEN
  });
  const {client}=configuration();
  try{
    await seed();
    // Use the normal compiled legal Worker and exact gateway, never a mock.
    ownerDeployed=true;
    wrangler(["deploy","--config",ownerConfig,"--secrets-file",ownerSecrets]);
    gatewayDeployed=true;
    wrangler(["deploy","--config",gatewayConfig,"--secrets-file",gatewaySecrets]);
    const first=await callOwner(command,client);
    assert.equal(first.status,200,"Actual private owner must acknowledge checked map");
    checkedOwnerReceipt(first.data,false);
    const replay=await callOwner(command,client);
    assert.equal(replay.status,200,"Replay must be acknowledged");
    checkedOwnerReceipt(replay.data,true);
    for(const outcome of [
      await callOwner(command,"invalid"),
      await callOwner(command,client,"/commercial/order/settle"),
      await callOwner(command,client,"/biosync/publish-checked","GET"),
      await callOwner({...command,mapSha256:"f".repeat(64)},client)
    ])assert.notEqual(outcome.status,200,"Hostile or unverifiable command must fail closed");
    const timing=await sql(
      "SELECT map_sha256,audio_sha256,epub_sha256 FROM audio_timing WHERE edition_id=? AND track_id=?",
      [command.editionId,command.trackId]);
    assert.deepEqual(timing.results,[{
      map_sha256:command.mapSha256,audio_sha256:audioSha,epub_sha256:epubSha
    }]);
    const job=await sql("SELECT status FROM audio_jobs WHERE id=?",[command.jobId]);
    assert.deepEqual(job.results,[{status:"done"}]);
    console.log(JSON.stringify({
      schema:"cove.biosync-hosted-owner-proof.v1",synthetic:true,
      account:"isolated-qa",ownerCommit:true,replay:true,
      deniedAdversarialCommands:true,primaryPointerAtomic:true,
      productionAccess:false,rightsGranted:false,
      productionCutoverCertified:false,releaseCertified:false
    }));
  }finally{
    await cleanup();
    for(const file of [ownerConfig,gatewayConfig])rmSync(file,{force:true});
    rmSync(dir,{recursive:true,force:true});
    if(failures.length)throw Error("biosync_hosted_owner_cleanup_incomplete:"+[...new Set(failures)].join(","));
  }
}
try{await main()}catch(error){
  console.error("BioSync isolated hosted owner proof FAILED: "+
    (String(error).includes("cleanup_incomplete")?"cleanup_incomplete":"protected_synthetic_qa"));
  process.exitCode=1;
}
