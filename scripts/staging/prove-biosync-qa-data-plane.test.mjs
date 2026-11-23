/* eslint-disable prettier/prettier -- Negative QA credential and SQL boundary tests. */
import assert from "node:assert/strict";
import {test} from "node:test";
import {
  QA_ACCOUNT,QA_DATABASE,QA_BUCKET,proveBiosyncQaDataPlane
} from "./prove-biosync-qa-data-plane.mjs";

const env={COVE_CF_QA_D1_MUTATION_TOKEN:"a".repeat(40),
  COVE_CF_QA_R2_STORAGE_TOKEN:"b".repeat(40)};
const names=[
  ["index","idx_audio_book"],["index","idx_audio_jobs_queue"],
  ["index","idx_audio_narration"],["table","audio_editions"],
  ["table","audio_jobs"],["table","audio_timing"]
];
function stub({schema=names,meta=true,bucket=QA_BUCKET,status=200}={}){
  const calls=[];
  const fetcher=async(url,opts)=>{
    calls.push({url,opts});
    const json=opts.method==="POST"?{success:true,errors:[],result:[{
      success:true,results:schema.map(([type,name])=>({type,name})),
      meta:{changed_db:!meta,changes:meta?0:1,rows_written:meta?0:1,served_by_primary:true}
    }]}:{success:true,errors:[],result:{name:bucket}};
    return {status,json:async()=>json};
  };
  return {fetcher,calls};
}
test("actual QA resource contract can only inspect isolated D1 schema and R2 metadata",async()=>{
  const s=stub(),result=await proveBiosyncQaDataPlane(env,s.fetcher);
  assert.equal(result.audioSchemaObjects,6);
  assert.equal(result.productionCutoverProven,false);
  assert.equal(result.ownerCommitProven,false);
  assert.equal(result.releaseCertified,false);
  assert.equal(s.calls.length,2);
  assert.equal(s.calls[0].url,
    "https://api.cloudflare.com/client/v4/accounts/"+QA_ACCOUNT+
    "/d1/database/"+QA_DATABASE+"/query");
  assert.equal(s.calls[1].url,
    "https://api.cloudflare.com/client/v4/accounts/"+QA_ACCOUNT+
    "/r2/buckets/"+QA_BUCKET);
  assert.equal(s.calls[0].opts.method,"POST");
  assert.equal(s.calls[1].opts.method,"GET");
  assert.equal(s.calls[0].opts.redirect,"error");
  assert.equal(s.calls[1].opts.redirect,"error");
  const {sql}=JSON.parse(s.calls[0].opts.body);
  assert.match(sql,/^SELECT /);
  assert.doesNotMatch(sql,/;|\\b(?:UPDATE|INSERT|DELETE|DROP|ALTER|PRAGMA)\\b/i);
  assert.ok(s.calls.every(x=>!x.url.includes("d26430caa63ec55f6612e32f36aca5e9")));
  assert.ok(s.calls.every(x=>!x.url.includes("4bd657ac-8789-403e-a28c-93aba8d0a989")));
  assert.equal(s.calls[0].opts.headers.authorization,"Bearer "+env.COVE_CF_QA_D1_MUTATION_TOKEN);
  assert.equal(s.calls[1].opts.headers.authorization,"Bearer "+env.COVE_CF_QA_R2_STORAGE_TOKEN);
});
test("resource proof refuses reused or absent credentials before a network call",async()=>{
  for(const invalid of [
    {},{...env,COVE_CF_QA_R2_STORAGE_TOKEN:env.COVE_CF_QA_D1_MUTATION_TOKEN},
    {...env,COVE_CF_QA_D1_MUTATION_TOKEN:"short"}
  ]){
    const s=stub();
    await assert.rejects(()=>proveBiosyncQaDataPlane(invalid,s.fetcher),
      /distinct_scoped_credentials_missing/);
    assert.equal(s.calls.length,0);
  }
});
test("resource proof rejects missing schema, writes, wrong bucket and API denial",async()=>{
  for(const defect of [
    {schema:names.slice(0,5)},{meta:false},{bucket:"production-media"},{status:403}
  ]){
    const s=stub(defect);
    await assert.rejects(()=>proveBiosyncQaDataPlane(env,s.fetcher),
      /biosync_qa_data_plane_denied_/);
  }
});
