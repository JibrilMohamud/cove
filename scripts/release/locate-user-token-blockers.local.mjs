/* eslint-disable prettier/prettier -- Local-only read-only release diagnosis. */
import assert from "node:assert/strict";
import {pathToFileURL} from "node:url";
import {inspectUserTokenEvidence} from "./certify-exclusive-primary-d1.mjs";
import {createPhysicalWriterReadTransport} from "./physical-d1-writer-read-transport.mjs";

const pageFor=rows=>({result:rows,result_info:{page:1,count:rows.length,total_count:rows.length,total_pages:1}});

// Use the actual protected verifier, not a second permission allowlist. Fetch
// the complete inventory once; cache only provider catalog responses during
// this single local invocation. Never return credentials or raw policies.
export async function locateUserTokenBlockers(get,token){
  const inventory=await get("/user/tokens",token);
  const rows=inventory?.result,info=inventory?.result_info;
  assert.ok(Array.isArray(rows)&&rows.length<=1000&&info?.page===1&&
    info.count===rows.length&&info.total_count===rows.length&&
    (info.total_pages===undefined||info.total_pages===1),"Incomplete inventory");
  const catalog=new Map();
  const inspect=async subset=>inspectUserTokenEvidence(async(path,key)=>{
    if(path==="/user/tokens")return subset===rows?inventory:pageFor(subset);
    assert.ok(path.startsWith("/user/tokens/permission_groups?"),"Unexpected endpoint");
    if(!catalog.has(path))catalog.set(path,await get(path,key));
    return catalog.get(path);
  },token);
  const aggregate=await inspect(rows);
  const blockers=[];
  if(!aggregate.verified){
    for(const row of rows){
      const result=await inspect([row]);
      if(!result.verified)blockers.push({
        name:typeof row?.name==="string"?row.name:"(invalid metadata)",
        reason:result.reason,detail:result.detail||null,
      });
    }
  }
  return {aggregate,blockers,releaseCertified:false};
}
async function selfTest(){
  const active=(name,group)=>({name,status:"active",policies:[{permission_groups:[{name:group}]}]});
  const fixture=[active("read-only","D1 Read"),active("mutator","D1 Write"),{name:"expired",status:"expired"}];
  const result=await locateUserTokenBlockers(async path=>{
    assert.equal(path,"/user/tokens");return pageFor(fixture);
  },"synthetic");
  assert.equal(result.aggregate.verified,false);
  assert.deepEqual(result.blockers,[{name:"mutator",reason:"active_user_token_mutation_capability",detail:null}]);
  await assert.rejects(()=>locateUserTokenBlockers(async()=>({result:fixture,result_info:{page:1,count:3,total_count:4}}),"synthetic"),/Incomplete inventory/);
  assert.equal((await locateUserTokenBlockers(async()=>pageFor([fixture[0]]),"synthetic")).aggregate.verified,true);
  console.log("PASS: exact verifier locates only failing tokens, rejects incomplete inventory, no release certificate");
}
async function local(){
  // Public CI logs and redirected output must never contain token names.
  if(process.env.CI||process.env.GITHUB_ACTIONS||!process.stdout.isTTY||!process.stdin.isTTY)
    throw Error("Local interactive terminal required; do not run in CI or redirect output.");
  const token=process.env.CF_USER_AUDIT_TOKEN;
  if(typeof token!=="string"||token.length<20)throw Error("Missing scoped user audit credential");
  const transport=createPhysicalWriterReadTransport();
  const report=await locateUserTokenBlockers(transport.get,token);
  console.log(JSON.stringify(report,null,2));
  if(!report.aggregate.verified)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const run=process.argv.slice(2).join(" ")==="--self-test"?selfTest:local;
  run().catch(()=>{console.error("BLOCKED: local user-token diagnosis unavailable or incomplete");process.exitCode=1;});
}
