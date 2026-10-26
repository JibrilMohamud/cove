/* eslint-disable prettier/prettier -- Hard release topology assertions intentionally explicit. */
import assert from "node:assert/strict";
import {mkdirSync,writeFileSync} from "node:fs";

export function evaluateDomainReleaseTopology(hostname,zones,domains) {
  const reasons=[];
  if(typeof hostname!=="string"||!/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(hostname) ||
      hostname.length>253 ||
      hostname.endsWith(".workers.dev") ||
      hostname.endsWith(".vercel.app"))
    reasons.push("release_hostname_missing_or_provider_owned");
  const allowed=Array.isArray(zones)?zones.filter(z=>
    z&&z.status==="active" && typeof z.name==="string" &&
    (hostname===z.name||hostname?.endsWith("."+z.name))):[];
  if(!allowed.length) reasons.push("no_active_owned_cloudflare_zone");
  const zone=allowed.sort((a,b)=>b.name.length-a.name.length)[0];
  const binding=Array.isArray(domains)?domains.find(d=>d.hostname===hostname &&
    d.zone_id===zone?.id &&
    d.service==="cove-fast-customer-gateway" &&
    d.enabled===true && d.previews_enabled===false && typeof d.cert_id==="string" &&
    d.cert_id.length>0):null;
  if(!binding) reasons.push("no_tls_certified_customer_worker_domain");
  return {ready:reasons.length===0,hostname:hostname||null,
    zone:zone?{name:zone.name,id:zone.id}:null,
    binding:binding?{service:binding.service,hostname:binding.hostname}:null,
    reasons};
}
if(process.argv.includes("--self-test")){
  const zone={id:"zone-test",name:"cove.example",status:"active"};
  const domain={hostname:"store.cove.example",zone_id:"zone-test",
    service:"cove-fast-customer-gateway",enabled:true,previews_enabled:false,
    cert_id:"cert-test"};
  assert.equal(evaluateDomainReleaseTopology("store.cove.example",[zone],[domain]).ready,true);
  assert.equal(evaluateDomainReleaseTopology("cove-jibrilmohamud.workers.dev",
    [zone],[domain]).ready,false);
  assert.equal(evaluateDomainReleaseTopology("store.cove.example",[],[domain]).ready,false);
  assert.equal(evaluateDomainReleaseTopology("store.cove.example",[zone],
    [{...domain,previews_enabled:true}]).ready,false);
  assert.equal(evaluateDomainReleaseTopology("store.cove.example",[zone],
    [{...domain,service:"other-worker"}]).ready,false);
  console.log("PASS: production custom-domain must match owned active CF zone, worker and certificate");
}else{
  const hostname=process.env.COVE_RELEASE_HOSTNAME||"";
  const account=process.env.CLOUDFLARE_ACCOUNT_ID||"";
  const token=process.env.CLOUDFLARE_API_TOKEN||"";
  async function get(url){
    const response=await fetch(url,{
      headers:{authorization:"Bearer "+token},signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error("cloudflare_topology_http_"+response.status);
    const result=await response.json();
    if(!result.success)throw Error("cloudflare_topology_rejected");
    return result.result;
  }
  let zoneList=[],domainList=[],serviceError=null;
  try{
    if(!/^[a-f0-9]{32}$/.test(account)||!token)throw Error("cf_credentials_missing");
    zoneList=await get("https://api.cloudflare.com/client/v4/zones?"+
      new URLSearchParams({"account.id":account,"per_page":"50"}));
    domainList=await get("https://api.cloudflare.com/client/v4/accounts/"+account+
      "/workers/domains?per_page=50");
  }catch(e){serviceError=e?.message||"topology_unavailable";}
  const topology=evaluateDomainReleaseTopology(hostname,zoneList,domainList);
  const output={schema:"cove.production-domain-preflight.v1",...topology,
    serviceError, checkedAt:new Date().toISOString(),
    releaseCertified:false,
    note:"Domain routing alone never proves legal-writer closure, protected delivery or the 800ms end-to-end hosted gate."};
  mkdirSync("artifacts/release-topology",{recursive:true});
  writeFileSync("artifacts/release-topology/domain.json",JSON.stringify(output,null,2));
  console.log("COVE_DOMAIN_PREFLIGHT",JSON.stringify(output));
  if(process.argv.includes("--enforce") && (!topology.ready||serviceError))
    process.exitCode=1;
}
