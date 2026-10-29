/* eslint-disable prettier/prettier -- Read-only account-wide deployed D1 authority inventory. */
import assert from "node:assert/strict";
import {mkdirSync,writeFileSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {pathToFileURL} from "node:url";

export const CANONICAL_D1="4bd657ac-8789-403e-a28c-93aba8d0a989";
export const OWNER_SCRIPT="cove-legal-authority-production";
const HOST="https://api.cloudflare.com/client/v4";
const idPattern=/^[a-f0-9]{32}$/;
const namePattern=/^[a-zA-Z0-9_-]{1,128}$/;
const safeWorker=name=>{assert.match(name,namePattern);return encodeURIComponent(name);};

async function apiGet(fetcher,token,path,{optional=false}={}){
  const result=await fetcher(HOST+path,{
    method:"GET",
    headers:{authorization:"Bearer "+token,accept:"application/json"},
    signal:AbortSignal.timeout(20000)
  });
  if(optional&&result.status===404)return null;
  if(!result.ok)throw Error("Cloudflare fleet inventory HTTP "+result.status+" on "+path.split("?")[0]);
  const json=await result.json();
  if(!json||json.success!==true)throw Error("Cloudflare fleet inventory API rejected "+path.split("?")[0]);
  return json.result;
}
async function mapBounded(items,limit,fn){
  let index=0;
  const result=new Array(items.length);
  await Promise.all(Array.from({length:Math.min(items.length,limit)},async()=>{
    for(;;){
      const next=index++;
      if(next>=items.length)return;
      result[next]=await fn(items[next],next);
    }
  }));
  return result;
}
/** Derive a capability inventory, not an assertion that each Worker executes SQL.
 * An owner-only production deployment requires additional runtime and payment
 * proof. No Worker names are exempt because they contain "disabled" or "qa". */
export function assessDeployedCanonicalD1Principals({scripts,settingsByName,
    schedulesByName={},subdomainsByName={},routes=[],domains=[]}){
  assert.ok(Array.isArray(scripts)&&scripts.length>0);
  const names=scripts.map(s=>s.id);
  assert.equal(new Set(names).size,names.length,"Duplicate Worker names or incomplete pagination");
  const bindings=[],incoming=new Map();
  for(const name of names){
    const settings=settingsByName[name];
    assert.ok(settings&&Array.isArray(settings.bindings),"Missing deployed Worker settings: "+name);
    for(const binding of settings.bindings){
      if(binding.type==="service"&&binding.service){
        const entries=incoming.get(binding.service)||[];
        entries.push({script:name,binding:binding.name});incoming.set(binding.service,entries);
      }
      if(binding.type==="durable_object_namespace"&&binding.script_name){
        const entries=incoming.get(binding.script_name)||[];
        entries.push({script:name,binding:binding.name});incoming.set(binding.script_name,entries);
      }
      if(binding.type==="d1"&&(binding.id||binding.database_id)===CANONICAL_D1)
        bindings.push({script:name,binding:binding.name});
    }
  }
  const bound=bindings.map(({script,binding})=>{
    const settings=settingsByName[script];
    const scriptsCrons=schedulesByName[script];
    assert.ok(Array.isArray(scriptsCrons),"Missing live cron inventory: "+script);
    const subdomain=subdomainsByName[script];
    assert.equal(typeof subdomain?.enabled,"boolean","Missing Workers.dev exposure: "+script);
    const flags=(settings.bindings||[]).filter(x=>x.type==="plain_text"&&
      /(?:ENABLED|DRAIN|PAUSED|DISABLED|STAGING)/.test(x.name))
      .map(x=>({name:x.name,value:x.text})).sort((a,b)=>a.name.localeCompare(b.name));
    return {script,binding,owner:script===OWNER_SCRIPT,
      crons:scriptsCrons,
      publicWorkersDev:subdomain.enabled,
      inboundServiceBindings:(incoming.get(script)||[]).sort((a,b)=>a.script.localeCompare(b.script)),
      customRoutes:routes.filter(x=>x.script===script).map(x=>x.pattern).sort(),
      customDomains:domains.filter(x=>x.service===script).map(x=>x.hostname).sort(),
      modeFlags:flags};
  }).sort((a,b)=>a.script.localeCompare(b.script)||a.binding.localeCompare(b.binding));
  const unauthorized=bound.filter(x=>!x.owner);
  const owner=bound.filter(x=>x.owner);
  const scheduled=bound.filter(x=>x.crons.length>0);
  const exposed=bound.filter(x=>x.publicWorkersDev||x.customRoutes.length||x.customDomains.length);
  const ownerEnabled=(settingsByName[OWNER_SCRIPT]?.bindings||[]).find(x=>x.name==="COVE_RIGHTS_OWNER_ENABLED")?.text==="1";
  return {
    schema:"cove.deployed-canonical-d1-principal-inventory.v1",
    classification:"capability inventory; not proof of a write, exploitation, or production certification",
    workerScriptsInspected:names.length,canonicalD1:CANONICAL_D1,
    directCanonicalBindings:bound.length,
    nonOwnerBindings:unauthorized.length,
    boundScriptsWithCrons:scheduled.length,
    boundScriptsWithNetworkIngress:exposed.length,
    ownerEnabled,
    principals:bound,
    blockerCodes:[
      ...(unauthorized.length?["non_owner_workers_retain_canonical_d1_binding"]:[]),
      ...(!owner.length?["production_owner_missing_canonical_d1_binding"]:[]),
      ...(owner.length!==1?["production_owner_binding_count_invalid"]:[]),
      ...(!ownerEnabled?["production_owner_disabled"]:[]),
      ...(scheduled.some(x=>!x.owner)?["non_owner_cron_can_use_canonical_d1"]:[]),
    ],
    productionAuthorized:false,
    releaseEligible:false,
    // Synthetic fixtures and source-only schema cannot self-certify real prod.
    independentDeploymentAuthorizationRequired:true
  };
}

/** Read-only. Abort the entire audit if even one Worker settings or owner
 * schedule request is inaccessible: incomplete evidence is not a pass. */
export async function collectCanonicalD1Fleet({fetcher=fetch,token,account,zone}){
  assert.ok(typeof token==="string"&&token.length>=20,"Cloudflare credential required");
  assert.match(account||"",idPattern);
  assert.match(zone||"",idPattern);
  const root="/accounts/"+account;
  const scripts=await apiGet(fetcher,token,root+"/workers/scripts");
  assert.ok(Array.isArray(scripts)&&scripts.length>0&&scripts.length<1000,
    "Ambiguous Cloudflare Worker listing; fail closed rather than truncate");
  // The scripts collection endpoint returns the complete account-level list
  // (no page cursor in the Cloudflare API response). Fail if approaching its
  // safe limit; do not infer a clean topology from a truncated list.
  const sorted=[...scripts].sort((a,b)=>a.id.localeCompare(b.id));
  const settingsList=await mapBounded(sorted,12,async w=>
    apiGet(fetcher,token,root+"/workers/scripts/"+safeWorker(w.id)+"/settings"));
  const settingsByName=Object.fromEntries(sorted.map((w,i)=>[w.id,settingsList[i]]));
  const targets=sorted.filter(w=>settingsByName[w.id].bindings?.some(b=>
    b.type==="d1"&&(b.id||b.database_id)===CANONICAL_D1));
  const details=await mapBounded(targets,12,async w=>{
    const name=safeWorker(w.id);
    const [schedule,subdomain]=await Promise.all([
      apiGet(fetcher,token,root+"/workers/scripts/"+name+"/schedules"),
      apiGet(fetcher,token,root+"/workers/scripts/"+name+"/subdomain")
    ]);
    return {name:w.id,schedules:(schedule?.schedules||[]).map(s=>s.cron),subdomain};
  });
  const [routes,domains]=await Promise.all([
    apiGet(fetcher,token,"/zones/"+zone+"/workers/routes"),
    apiGet(fetcher,token,root+"/workers/domains")
  ]);
  assert.ok(Array.isArray(routes)&&Array.isArray(domains));
  const scheduleMap=Object.fromEntries(details.map(d=>[d.name,d.schedules]));
  const subdomainMap=Object.fromEntries(details.map(d=>[d.name,d.subdomain]));
  return assessDeployedCanonicalD1Principals({
    scripts:sorted,settingsByName,schedulesByName:scheduleMap,
    subdomainsByName:subdomainMap,routes,domains
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const release=process.argv.includes("--release-gate"),
    audit=process.argv.includes("--audit");
  if(release===audit)throw Error("Specify exactly one of --audit or --release-gate");
  try {
    const report=await collectCanonicalD1Fleet({
      token:process.env.CLOUDFLARE_API_TOKEN,
      account:process.env.CLOUDFLARE_ACCOUNT_ID,
      zone:process.env.CLOUDFLARE_ZONE_ID
    });
    const json=JSON.stringify({checkedAt:new Date().toISOString(),...report},null,2)+"\n";
    if(process.env.COVE_D1_FLEET_AUDIT_OUTPUT){
      mkdirSync(dirname(resolve(process.env.COVE_D1_FLEET_AUDIT_OUTPUT)),{recursive:true});
      writeFileSync(resolve(process.env.COVE_D1_FLEET_AUDIT_OUTPUT),json);
    }
    console.log(json);
    if(release){
      console.error("BLOCKED: deployed binding isolation alone never proves live authorization, positive rights issuance, payment refund/revocation or rollback.");
      process.exitCode=1;
    }
  }catch(error){
    console.error("BLOCKED: incomplete deployed canonical D1 fleet audit: "+String(error?.message||error));
    process.exitCode=1;
  }
}
