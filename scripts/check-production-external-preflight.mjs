/* eslint-disable prettier/prettier -- Security-critical, read-only external production preflight. */
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";

export const PRODUCTION_D1="4bd657ac-8789-403e-a28c-93aba8d0a989";
export const PRODUCTION_OWNER="cove-legal-authority-production";
export const REQUIRED_EVENTS=[
  "payment_intent.succeeded","payment_intent.payment_failed",
  "payment_intent.processing","payment_intent.canceled",
  "payment_intent.amount_capturable_updated","charge.succeeded",
  "invoice.paid","invoice.payment_failed",
  "refund.created","refund.updated",
  "charge.dispute.created","charge.dispute.updated","charge.dispute.closed",
  "charge.dispute.funds_withdrawn","charge.dispute.funds_reinstated"
];
export function assessExternalPrerequisites({ownerSettings,workerSettings,accountTokens,accountTokenInventoryComplete,webhooks,webhookUrl,ownerSource}){
  const problems=[];
  const bindings=ownerSettings?.bindings||[];
  const named=n=>bindings.find(x=>x.name===n);
  if(named("PRIMARY_DB")?.type!=="d1"||(named("PRIMARY_DB")?.database_id||named("PRIMARY_DB")?.id)!==PRODUCTION_D1)
    problems.push("Production legal owner lacks the exact primary D1 binding.");
  if(named("LEGAL_AUTHORITY")?.type!=="durable_object_namespace")
    problems.push("Production legal owner lacks its Durable Object authority.");
  if(named("COVE_RIGHTS_OWNER_ENABLED")?.text!=="1")
    problems.push("Production legal owner is disabled.");
  if(!named("COVE_RIGHTS_OWNER_SECRET")||named("COVE_RIGHTS_OWNER_SECRET")?.type!=="secret_text")
    problems.push("Production legal owner has no secret binding.");
  if(/QA_PRIMARIES\.has\(env\.COVE_RIGHTS_OWNER_PRIMARY_ID/.test(ownerSource))
    problems.push("Current legal-authority source is QA-leased only; production cannot activate by toggling the flag.");
  if(!Array.isArray(workerSettings))
    problems.push("Complete non-owner Worker binding inventory is missing.");
  else{
    for(const worker of workerSettings){
      if(worker.name===PRODUCTION_OWNER)continue;
      for(const binding of worker.bindings||[]){
        if(binding.type==="d1"&&(binding.database_id||binding.id)===PRODUCTION_D1)
          problems.push("Non-owner Worker retains a direct production D1 binding: "+worker.name+" / "+binding.name);
      }
    }
  }
  if(!Array.isArray(accountTokens)||accountTokenInventoryComplete!==true)
    problems.push("Complete account API token privilege inventory is missing.");
  else for(const token of accountTokens){
    if(!["active","disabled","expired"].includes(token.status)){
      problems.push("Account API token status is incomplete: "+token.id);
      continue;
    }
    if(token.status!=="active")continue;
    if(!Array.isArray(token.policies)){
      problems.push("Active account API token policies are incomplete: "+token.id);
      continue;
    }
    for(const policy of token.policies){
      if(policy.effect!=="allow")continue;
      if(!Array.isArray(policy.permission_groups)){
        problems.push("Active account API token permission inventory is incomplete: "+token.id);
        continue;
      }
      if(policy.permission_groups.some(p=>p.id==="09b2857d1c31407795e75e3fed8617a1"||/^D1 (Write|Edit)$/i.test(p.name||"")))
        problems.push("Active account API token retains D1 Write; database scope must be independently retired or certified: "+token.id);
    }
  }
  let expected=null;
  try{
    expected=new URL(webhookUrl);
    if(expected.protocol!=="https:"||
       !["covereads.com","www.covereads.com"].includes(expected.hostname)||
       expected.pathname!=="/api/fore/stripe/webhook"||
       expected.search||expected.hash)throw Error("destination");
  }catch{
    problems.push("Expected live Stripe webhook URL is missing or invalid.");
  }
  const matching=expected&&(webhooks||[]).filter(x=>x.status==="enabled"&&
    x.livemode===true&&x.url===expected.href);
  if(!matching?.length)problems.push("No enabled Stripe LIVE webhook destination at the verified Cove ingress.");
  else if(!matching.some(x=>REQUIRED_EVENTS.every(y=>x.enabled_events?.includes("*")||x.enabled_events?.includes(y))))
    problems.push("Stripe LIVE webhook destination is missing critical payment/refund event types.");
  return {schema:"cove.external-production-preflight.v1",scope:"external-prerequisites-only",
    checkedScripts:workerSettings?.length??null,accountTokensChecked:accountTokens?.length??null,
    userOwnedTokenPrivilegesCertified:false,webhookEndpoints:webhooks?.length??null,
    readyForExternalPrerequisites:problems.length===0,productionCertified:false,problems};
}
async function getJson(url,headers){
  const res=await fetch(url,{headers,redirect:"error",signal:AbortSignal.timeout(20000)});
  if(!res.ok)throw Error("Read-only preflight API returned HTTP "+res.status+" at "+new URL(url).pathname);
  const body=await res.json();return body;
}
async function cf(url,token){
  const data=await getJson(url,{Authorization:"Bearer "+token,Accept:"application/json"});
  if(data.success!==true||!Array.isArray(data.errors))throw Error("Cloudflare API verification failed");
  return data;
}
export async function readLiveEvidence({cloudflareToken,accountId,stripeRestrictedKey}){
  if(!cloudflareToken||!accountId||!stripeRestrictedKey)
    throw Error("Cloudflare token/account and Stripe LIVE restricted read-only key are all mandatory.");
  const base="https://api.cloudflare.com/client/v4/accounts/"+encodeURIComponent(accountId)+"/workers/scripts";
  const pages=[];for(let page=1;page<=20;page++){
    const result=await cf(base+"?per_page=100&page="+page,cloudflareToken);
    const rows=result.result||[];
    if(!Array.isArray(rows))throw Error("Invalid complete Cloudflare Worker inventory");
    pages.push(...rows);
    if(result.result_info?.total_pages&&page>=result.result_info.total_pages)break;
    if(!result.result_info?.total_pages&&rows.length<100)break;
    if(page===20)throw Error("Worker inventory too large to certify");
  }
  const names=[...new Set(pages.map(x=>x.id).filter(x=>typeof x==="string"))];
  if(!names.includes(PRODUCTION_OWNER))throw Error("Production legal owner not listed by Cloudflare");
  const workers=[];
  for(let start=0;start<names.length;start+=8){
    const subset=await Promise.all(names.slice(start,start+8).map(async name=>{
      const x=await cf(base+"/"+encodeURIComponent(name)+"/settings",cloudflareToken);
      if(!Array.isArray(x.result?.bindings))throw Error("Worker settings incomplete: "+name);
      return {name,bindings:x.result.bindings};
    }));
    workers.push(...subset);
  }
  const ownerSettings=workers.find(x=>x.name===PRODUCTION_OWNER);
  // Account-owned tokens are a separate SQL capability from Worker bindings.
  // Never fetch secret values; policies and resource scopes are metadata only.
  const accountTokens=[];
  const tokensBase="https://api.cloudflare.com/client/v4/accounts/"+encodeURIComponent(accountId)+"/tokens";
  for(let page=1;page<=20;page++){
    const data=await cf(tokensBase+"?per_page=50&page="+page,cloudflareToken);
    if(!Array.isArray(data.result))throw Error("Account API token privilege inventory incomplete");
    accountTokens.push(...data.result);
    if(data.result_info?.total_pages&&page>=data.result_info.total_pages)break;
    if(!data.result_info?.total_pages&&data.result.length<50)break;
    if(page===20)throw Error("Account API token inventory too large to certify");
  }
  const webhooks=[];let starting_after;
  for(let page=1;page<=20;page++){
    const url=new URL("https://api.stripe.com/v1/webhook_endpoints");
    url.searchParams.set("limit","100");
    if(starting_after)url.searchParams.set("starting_after",starting_after);
    const data=await getJson(url.href,{Authorization:"Bearer "+stripeRestrictedKey,Accept:"application/json"});
    if(!Array.isArray(data.data))throw Error("Stripe webhook read did not return a list");
    webhooks.push(...data.data);
    if(!data.has_more)break;
    starting_after=data.data.at(-1)?.id;
    if(!starting_after||page===20)throw Error("Stripe webhook inventory incomplete");
  }
  return {ownerSettings,workerSettings:workers,accountTokens,accountTokenInventoryComplete:true,webhooks};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(!process.argv.includes("--live")){
    console.log("Read-only live check: node scripts/check-production-external-preflight.mjs --live");
    process.exitCode=1;
  }else{
    const ownerSource=readFileSync("src/storefront-strangler/legal-authority.worker.ts","utf8");
    const evidence=await readLiveEvidence({
      cloudflareToken:process.env.CLOUDFLARE_API_TOKEN,
      accountId:process.env.CLOUDFLARE_ACCOUNT_ID,
      stripeRestrictedKey:process.env.STRIPE_LIVE_RESTRICTED_READ_KEY
    });
    const assessment=assessExternalPrerequisites({
      ...evidence,ownerSource,webhookUrl:process.env.COVE_STRIPE_WEBHOOK_URL
    });
    console.log(JSON.stringify(assessment,null,2));
    if(!assessment.readyForExternalPrerequisites)process.exitCode=1;
  }
}
