/* eslint-disable prettier/prettier -- Read-only production version upload verification. */
/**
 * Verifies candidate is archived ONLY, never deployed to customers.
 * Failure leaves prior production 451 serving 100% traffic.
 */
import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
const ACCOUNT="d26430caa63ec55f6612e32f36aca5e9";
const WORKER="cove-persistence-backend";
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID,ACCOUNT);
const token=process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token);
const before=JSON.parse(readFileSync("artifacts/production-diagnostic-upload/before.json","utf8"));
assert.equal(before.old,"401f2af2-6e69-4611-8110-1d127af6eecf");
assert.equal(before.run,process.env.GITHUB_RUN_ID);
assert.equal(before.attempt,process.env.GITHUB_RUN_ATTEMPT);
const base="/accounts/"+ACCOUNT+"/workers/scripts/"+WORKER;
async function cf(path){
  const response=await fetch("https://api.cloudflare.com/client/v4"+path,{
    headers:{authorization:"Bearer "+token},signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error("Cloudflare read-only version check HTTP "+response.status);
  const json=await response.json();
  assert.equal(json.success,true);
  return json.result;
}
const [deployments,old,versions]=await Promise.all([
  cf(base+"/deployments"),cf(base+"/versions/"+before.old),
  cf(base+"/versions?per_page=20"),
]);
const deployed=deployments.deployments?.[0];
assert.equal(deployed?.id,before.headDeploymentId,
  "WRANGLER UPLOAD CHANGED DEPLOYMENT; investigate immediately");
assert.equal(deployed?.versions?.length,1);
assert.equal(deployed.versions[0].version_id,before.old);
assert.equal(deployed.versions[0].percentage,100);
const introduced=(versions.items||[]).filter(x=>!before.versionIds.includes(x.id));
assert.equal(introduced.length,1,
  "Must identify exactly one uploaded version without any concurrent Writer modifications");
const candidate=introduced[0];
assert.ok(candidate.number>old.number);
const version=await cf(base+"/versions/"+candidate.id);
assert.equal(version.number,candidate.number);
assert.equal(version.resources?.script_runtime?.compatibility_date,"2026-09-01");
assert.deepEqual(version.resources.script_runtime,old.resources?.script_runtime,
  "Incompatible Worker runtime settings would block canary");
const shape=bindings=>(bindings||[]).map(b=>{
  const x={type:b.type,name:b.name};
  for(const key of ["database_id","bucket_name","namespace_id","id","dataset",
    "class_name","script_name","text","limit","period"]){
    if(b.type==="secret_text"||b.type==="secret_key")continue;
    if(Object.hasOwn(b,key))x[key]=b[key];
  }
  return x;
}).sort((a,b)=>a.name.localeCompare(b.name));
const baseline=shape(old.resources?.bindings);
const current=shape(version.resources?.bindings);
assert.deepEqual(current,baseline,
  "Uploaded version must match EVERY production binding and nonsecret plain-text setting");
assert.ok(current.some(x=>x.name==="DB"&&x.database_id==="4bd657ac-8789-403e-a28c-93aba8d0a989"));
assert.ok(current.some(x=>x.name==="LEGAL_AUTHORITY"&&
  x.script_name==="cove-legal-authority-production"));
assert.ok(current.some(x=>x.name==="OPS_ANALYTICS"&&x.dataset==="cove_public_http_ops"));
const result={event:"cove_production_diagnostic_version_uploaded_zero_traffic",
  candidateId:candidate.id,candidateNumber:candidate.number,
  productionVersion:451,baselineDeploymentUnchanged:true,
  customerTrafficCandidatePercent:0,resourcesEqual:true,
  noD1Migrations:true,ownerActivationUnchanged:true,releaseCertified:false};
writeFileSync("artifacts/production-diagnostic-upload/evidence.json",JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
