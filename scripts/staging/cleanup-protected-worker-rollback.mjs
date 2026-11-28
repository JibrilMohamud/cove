/* eslint-disable prettier/prettier -- Verified isolated script cleanup; never production. */
import assert from "node:assert/strict";
import {rmSync} from "node:fs";
const ACCOUNT="f51e8ccbc394e2d6016ff8c2c303d54b";
const run=process.env.GITHUB_RUN_ID,attempt=process.env.GITHUB_RUN_ATTEMPT;
assert.match(run||"",/^[0-9]{8,15}$/);
assert.match(attempt||"",/^[1-9][0-9]{0,2}$/);
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID,ACCOUNT);
const worker="cove-rollback-proof-"+run+"-a"+attempt;
const token=process.env.CLOUDFLARE_API_TOKEN;
assert.ok(token);
const endpoint="https://api.cloudflare.com/client/v4/accounts/"+ACCOUNT+"/workers/scripts/"+worker;
async function request(method,suffix=""){
  const resp=await fetch(endpoint+suffix,{method,
    headers:{authorization:"Bearer "+token},redirect:"error",signal:AbortSignal.timeout(12000)});
  if(resp.status===404)return null;
  if(!resp.ok)throw Error("Isolated rollback cleanup HTTP "+resp.status);
  const j=await resp.json();
  assert.equal(j.success,true);
  return j.result;
}
let removed=false;
try{
  const settings=await request("GET","/settings");
  if(settings===null)removed=true;
  else{
    const bindings=settings.bindings||[];
    assert.ok(bindings.some(x=>x.name==="COVE_ROLLBACK_REHEARSAL"&&
      x.type==="plain_text"&&x.text==="1"),"Refuse deletion without stage identity");
    assert.ok(!bindings.some(x=>["d1","durable_object_namespace",
      "r2_bucket","service","kv_namespace"].includes(x.type)),
      "Refuse deletion of script with production resources");
    await request("DELETE");
    for(let i=0;i<20;i++){
      if(await request("GET","/settings")===null){removed=true;break;}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
  }
  assert.equal(removed,true,"Temporary rollback stage Worker still exists");
  console.log(JSON.stringify({event:"cove_isolated_rollback_worker_deleted",
    removed:true,releaseCertified:false}));
}finally{
  rmSync(".output/rollback-stage",{recursive:true,force:true});
}
