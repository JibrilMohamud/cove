/* eslint-disable prettier/prettier -- Exact QA-only infrastructure probe, no user data or writes. */
import assert from "node:assert/strict";
import {pathToFileURL} from "node:url";

export const QA_ACCOUNT="f51e8ccbc394e2d6016ff8c2c303d54b";
export const QA_DATABASE="4e17ba6f-444f-4245-801a-a7d4969045b0";
export const QA_BUCKET="cove-owner-biosync-qa";
const PRODUCTION_ACCOUNT="d26430caa63ec55f6612e32f36aca5e9";
const PRODUCTION_DATABASE="4bd657ac-8789-403e-a28c-93aba8d0a989";
const EXPECTED=[
  "index:idx_audio_book","index:idx_audio_jobs_queue","index:idx_audio_narration",
  "table:audio_editions","table:audio_jobs","table:audio_timing",
];
const SQL="SELECT type,name FROM sqlite_master WHERE tbl_name IN ('audio_editions','audio_jobs','audio_timing') AND sql IS NOT NULL ORDER BY type,name";
const api="https://api.cloudflare.com/client/v4/accounts/"+QA_ACCOUNT;
const refuse=reason=>{throw Error("biosync_qa_data_plane_denied_"+reason);};

/**
 * Preflight of actual isolated QA resources with two distinct principals.
 * The D1 endpoint receives only one immutable SELECT, and R2 only GET.
 * No SQL mutation, object upload, account/rights data or customer ingress.
 * This is deliberately NOT positive owner or production cutover evidence.
 */
export async function proveBiosyncQaDataPlane(env=process.env,request=fetch) {
  assert.notEqual(QA_ACCOUNT,PRODUCTION_ACCOUNT);
  assert.notEqual(QA_DATABASE,PRODUCTION_DATABASE);
  const d1=env.COVE_CF_QA_D1_MUTATION_TOKEN;
  const r2=env.COVE_CF_QA_R2_STORAGE_TOKEN;
  if(typeof d1!=="string"||d1.length<24||typeof r2!=="string"||r2.length<24||d1===r2)
    refuse("distinct_scoped_credentials_missing");
  const call=async(url,token,method,body)=>{
    const response=await request(url,{
      method,headers:{"authorization":"Bearer "+token,...(body?{"content-type":"application/json"}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),redirect:"error",signal:AbortSignal.timeout(20000)
    });
    if(response.status!==200)refuse("provider_status");
    const json=await response.json();
    if(!json||json.success!==true||json.errors?.length)refuse("provider_response");
    return json;
  };
  const d=await call(api+"/d1/database/"+QA_DATABASE+"/query",d1,"POST",{sql:SQL});
  if(!Array.isArray(d.result)||d.result.length!==1||d.result[0].success!==true||
    d.result[0].meta?.changed_db!==false||d.result[0].meta?.changes!==0||
    d.result[0].meta?.rows_written!==0||d.result[0].meta?.served_by_primary!==true)
    refuse("d1_readonly_response");
  const rows=d.result[0].results;
  if(!Array.isArray(rows)||rows.some(x=>!x||Object.keys(x).sort().join("|")!=="name|type")||
    JSON.stringify(rows.map(x=>x.type+":"+x.name).sort())!==JSON.stringify([...EXPECTED].sort()))
    refuse("d1_audio_schema_mismatch");
  const b=await call(api+"/r2/buckets/"+QA_BUCKET,r2,"GET");
  if(b.result?.name!==QA_BUCKET)refuse("r2_bucket_identity");
  const result={schema:"cove.biosync-qa-data-plane.v1",account:QA_ACCOUNT,
    database:QA_DATABASE,bucket:QA_BUCKET,audioSchemaObjects:EXPECTED.length,
    d1ReadOnly:true,r2ReadOnly:true,ownerCommitProven:false,
    productionCutoverProven:false,releaseCertified:false};
  return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{console.log(JSON.stringify(await proveBiosyncQaDataPlane()));}
  catch(error){console.error("DENIED: synthetic BioSync QA resource proof unavailable");
    process.exitCode=1;}
}
