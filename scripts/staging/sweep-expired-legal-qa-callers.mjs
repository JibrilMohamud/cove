/* eslint-disable prettier/prettier -- Cleanup must never delete a live or unrelated Worker. */
import assert from "node:assert/strict";

const prefix=/^cove-private-legal-proof-\d{8,15}$/;
export function isExpiredIsolatedLegalQaCaller(name,bindings,now=Date.now()) {
  if(!prefix.test(name)||!Array.isArray(bindings)||!Number.isSafeInteger(now))
    return false;
  const get=key=>bindings.find(b=>b?.name===key);
  const enabled=get("COVE_LEGAL_QA_CALLER_ENABLED")?.text;
  const deadline=Number(get("COVE_LEGAL_QA_EXPIRES_AT")?.text);
  const owner=get("LEGAL_PRIVATE");
  return enabled==="1" && Number.isSafeInteger(deadline) && deadline>0 &&
    deadline<now && owner?.type==="service" &&
    owner.service==="cove-legal-authority-private-qa-example";
}
if(process.argv.includes("--self-test")){
  const bindings=[
    {name:"COVE_LEGAL_QA_CALLER_ENABLED",type:"plain_text",text:"1"},
    {name:"COVE_LEGAL_QA_EXPIRES_AT",type:"plain_text",text:"100"},
    {name:"LEGAL_PRIVATE",type:"service",service:"cove-legal-authority-private-qa-example"}
  ];
  assert.equal(isExpiredIsolatedLegalQaCaller("cove-private-legal-proof-40277762625",bindings,101),true);
  assert.equal(isExpiredIsolatedLegalQaCaller("cove-private-legal-proof-40277762625",bindings,100),false);
  assert.equal(isExpiredIsolatedLegalQaCaller("cove-private-legal-proof-40277762625",
    bindings.map(b=>b.name==="LEGAL_PRIVATE"?{...b,service:"other"}:b),101),false);
  assert.equal(isExpiredIsolatedLegalQaCaller("cove-fast-customer-gateway",bindings,101),false);
  assert.equal(isExpiredIsolatedLegalQaCaller("cove-private-legal-proof-40277762625",
    bindings.map(b=>b.name==="COVE_LEGAL_QA_CALLER_ENABLED"?{...b,text:"0"}:b),101),false);
  console.log("PASS: sweeper cannot touch valid leases, unrelated Workers or other service bindings");
}else{
  const account=process.env.CLOUDFLARE_ACCOUNT_ID;
  const token=process.env.CLOUDFLARE_API_TOKEN;
  assert.match(account||"",/^[a-f0-9]{32}$/);
  assert.ok(token);
  const base="https://api.cloudflare.com/client/v4/accounts/"+account+"/workers/scripts";
  async function request(method,resource){
    const response=await fetch(resource,{
      method,headers:{authorization:"Bearer "+token},signal:AbortSignal.timeout(16000)
    });
    if(!response.ok)throw Error("legal_qa_sweep_http_"+method+"_"+response.status);
    const value=await response.json();
    if(value.success!==true)throw Error("legal_qa_sweep_provider_rejected");
    return value.result;
  }
  const scripts=await request("GET",base);
  if(!Array.isArray(scripts))throw Error("legal_qa_worker_list_invalid");
  const candidates=scripts.map(w=>w?.id).filter(id=>typeof id==="string"&&prefix.test(id));
  let removed=0,retained=0;
  for(const name of candidates){
    const settings=await request("GET",base+"/"+encodeURIComponent(name)+"/settings");
    if(!isExpiredIsolatedLegalQaCaller(name,settings?.bindings)){
      retained++;continue;
    }
    await request("DELETE",base+"/"+encodeURIComponent(name));
    removed++;
    console.log("COVE_LEGAL_QA_EXPIRED_CALLER_REMOVED",name);
  }
  console.log("PASS: legal QA orphan sweep complete; expired="+removed+", unexpired-or-unrelated="+retained);
}
