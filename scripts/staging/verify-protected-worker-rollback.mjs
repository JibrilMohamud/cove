/* eslint-disable prettier/prettier -- Explicit isolation guards and rollback assertions. */
/**
 * Three phases: capture original A; validate new B then rollback to A;
 * independently verify A again. Never name or POST to production.
 */
import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
const ACCOUNT="f51e8ccbc394e2d6016ff8c2c303d54b";
const PRODUCTION_ACCOUNT="d26430caa63ec55f6612e32f36aca5e9";
const PRODUCTION="cove-persistence-backend";
const PINNED_PROD_VERSION="401f2af2-6e69-4611-8110-1d127af6eecf";
const PREVIOUS_PROD_VERSION="3f5fdeed-4f11-411a-8d4e-e86816f865bc";
const run=process.env.GITHUB_RUN_ID,attempt=process.env.GITHUB_RUN_ATTEMPT;
assert.match(run||"",/^[0-9]{8,15}$/);
assert.match(attempt||"",/^[1-9][0-9]{0,2}$/);
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID,ACCOUNT);
const name="cove-rollback-proof-"+run+"-a"+attempt;
const root=".output/rollback-stage";
const gate=JSON.parse(readFileSync(root+"/gate.json","utf8"));
assert.equal(name,gate.name);
assert.match(gate.gate,/^[a-f0-9]{64}$/);
assert.ok(gate.expires>Date.now() && gate.expires-Date.now()<=12*60*1000);
const token=process.env.CLOUDFLARE_API_TOKEN;
const productionRead=process.env.COVE_CF_WORKERS_METADATA_READ_TOKEN;
const productionContent=process.env.COVE_CF_WORKERS_CONTENT_READ_TOKEN||productionRead;
assert.ok(token&&productionRead&&productionContent,"Separate QA deploy and production read credentials required");
assert.notEqual(token,productionRead);
assert.notEqual(token,productionContent);
async function cloudflare(method,worker,suffix,body){
  assert.ok(worker===name||worker===PRODUCTION);
  let account,credential;
  if(worker===PRODUCTION){
    assert.equal(method,"GET","NEVER mutate production Worker");
    assert.equal(body,undefined);
    assert.ok(suffix==="/deployments"||
      [PINNED_PROD_VERSION,PREVIOUS_PROD_VERSION].some(id=>suffix==="/versions/"+id));
    account=PRODUCTION_ACCOUNT;
    credential=suffix==="/deployments"?productionRead:productionContent;
  }else{
    assert.ok((method==="GET"&&["/deployments","/settings"].includes(suffix))||
      (method==="POST"&&suffix==="/deployments"));
    account=ACCOUNT;
    credential=token;
  }
  const base="https://api.cloudflare.com/client/v4/accounts/"+account+"/workers/scripts/";
  const headers={authorization:"Bearer "+credential};
  if(body!==undefined)headers["content-type"]="application/json";
  const response=await fetch(base+worker+suffix,{
    method,headers,body:body===undefined?undefined:JSON.stringify(body),
    redirect:"error",signal:AbortSignal.timeout(15000),
  });
  if(!response.ok)throw Error("Cloudflare stage API "+method+" HTTP "+response.status);
  const json=await response.json();
  if(json.success!==true)throw Error("Cloudflare stage API returned failure");
  return json.result;
}
const deployment=async worker=>{
  const list=await cloudflare("GET",worker,"/deployments");
  const current=list.deployments?.[0];
  assert.ok(current&&current.strategy==="percentage"&&
    current.versions?.length===1&&current.versions[0].percentage===100);
  assert.match(current.versions[0].version_id,/^[a-f0-9-]{36}$/);
  return current;
};
const currentId=async worker=>(await deployment(worker)).versions[0].version_id;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function verifyHttp(version){
  const origin="https://"+name+".cove-qa-reads.workers.dev";
  const url=origin+"/__cove/rollback";
  let lastClass="unavailable";
  for(let i=0;i<22;i++){
    try{
      const [ok,denied,unknown]=await Promise.all([
        fetch(url,{headers:{"x-cove-stage-gate":gate.gate},signal:AbortSignal.timeout(7000)}),
        fetch(url,{signal:AbortSignal.timeout(7000)}),
        fetch(origin+"/api/fore/catalog",{signal:AbortSignal.timeout(7000)}),
      ]);
      if(ok.status===200&&ok.headers.get("x-cove-rollback-version")===version&&
        denied.status===401&&unknown.status===404){
        const result=await ok.json();
        assert.deepEqual(result,{stage:true,version});
        return;
      }
      lastClass="http:"+ok.status+"/"+denied.status+"/"+unknown.status;
    }catch(e){lastClass=e?.name||"transport";}
    await sleep(650);
  }
  throw Error("Isolated rollback stage response never settled "+lastClass);
}
async function verifyWorkerSettings(){
  const settings=await cloudflare("GET",name,"/settings");
  const bindings=settings.bindings||[];
  assert.ok(bindings.some(x=>x.name==="COVE_ROLLBACK_REHEARSAL"&&x.type==="plain_text"&&x.text==="1"));
  assert.ok(bindings.some(x=>x.name==="COVE_ROLLBACK_GATE"&&x.type==="secret_text"));
  assert.ok(bindings.some(x=>x.name==="COVE_ROLLBACK_EXPIRES_AT"&&x.type==="plain_text"));
  for(const forbidden of ["d1","r2_bucket","kv_namespace","durable_object_namespace",
    "service","queue","analytics_engine","ai","ratelimit","secrets_store_secret"]){
    assert.ok(!bindings.some(x=>x.type===forbidden),"Stage has forbidden binding "+forbidden);
  }
}
const phase=process.argv[2];
assert.ok(["capture-a","rollback-to-a","confirm-restored"].includes(phase));
if(phase==="capture-a"){
  await verifyWorkerSettings();
  await verifyHttp("A");
  const prod=await currentId(PRODUCTION);
  assert.equal(prod,PINNED_PROD_VERSION,
    "Production version drift; refuse to treat this as controlled rollback");
  // Read-only rollback-candidate preflight: version 450 must still exist
  // and retain the same binding types/names and runtime compatibility as
  // the pinned production version. This does NOT establish D1 schema or
  // payment-state rollback compatibility.
  const versions=await Promise.all(
    [PINNED_PROD_VERSION,PREVIOUS_PROD_VERSION].map(id=>
      cloudflare("GET",PRODUCTION,"/versions/"+id)),
  );
  assert.deepEqual(versions.map(x=>x.number),[451,450]);
  const bindShape=v=>(v.resources?.bindings||[]).map(b=>b.type+":"+b.name).sort();
  assert.deepEqual(bindShape(versions[0]),bindShape(versions[1]),
    "Archived production rollback candidate has incompatible binding names/types");
  assert.deepEqual(
    versions[0].resources?.script_runtime,
    versions[1].resources?.script_runtime,
    "Archived production version has different Worker runtime settings",
  );
  for(const x of versions){
    const bindings=x.resources?.bindings||[];
    assert.ok(bindings.some(b=>b.type==="d1"&&b.name==="DB"&&
      b.database_id==="4bd657ac-8789-403e-a28c-93aba8d0a989"));
    assert.ok(bindings.some(b=>b.type==="durable_object_namespace"&&
      b.name==="LEGAL_AUTHORITY"&&b.script_name==="cove-legal-authority-production"));
  }
  const original=await currentId(name);
  writeFileSync(root+"/original.json",JSON.stringify({original,prod}),{mode:0o600});
  console.log(JSON.stringify({event:"cove_isolated_original_verified",ready:true,
    script:name,productionUnchanged:true,archivedBindingsMatch:true,
    productionRollbackCertified:false,releaseCertified:false}));
}else{
  const {original,prod}=JSON.parse(readFileSync(root+"/original.json","utf8"));
  assert.match(original,/^[a-f0-9-]{36}$/);
  assert.equal(prod,PINNED_PROD_VERSION);
  if(phase==="rollback-to-a"){
    await verifyWorkerSettings();
    const newVersion=await currentId(name);
    assert.notEqual(newVersion,original,"No distinct B deployment");
    await verifyHttp("B");
    assert.equal(await currentId(PRODUCTION),prod,"Production Worker was changed");
    await cloudflare("POST",name,"/deployments",{
      strategy:"percentage",
      versions:[{version_id:original,percentage:100}],
      annotations:{"workers/message":"Cove isolated rollback rehearsal; no production traffic"},
    });
    for(let i=0;i<12;i++){
      if(await currentId(name)===original)break;
      if(i===11)throw Error("Cloudflare did not restore version A to 100%");
      await sleep(500);
    }
  }
  await verifyHttp("A");
  assert.equal(await currentId(name),original);
  assert.equal(await currentId(PRODUCTION),prod);
  console.log(JSON.stringify({event:"cove_isolated_rollback_restored",
    versionA100Percent:true,gateDenied:true,unknownRouteDenied:true,
    productionUnchanged:true,releaseCertified:false}));
}
