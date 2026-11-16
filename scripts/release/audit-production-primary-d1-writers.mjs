/* eslint-disable prettier/prettier -- Protected read-only release audit. */
export const ACCOUNT_ID='d26430caa63ec55f6612e32f36aca5e9';
export const PRIMARY_D1_ID='4bd657ac-8789-403e-a28c-93aba8d0a989';
export const OWNER_WORKER='cove-legal-authority-production';
const MAX_WORKERS=1000,MIN_GAP_MS=500,RETRIES=[20000,40000,80000],MAX_RATE_LIMITS=5,MAX_WAIT_MS=180000;

/** Inspection never writes Cloudflare, D1, routes, grants, or Stripe state. */
export function requireProtectedInvocation(env){
  if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!=='JibrilMohamud/cove'||
    env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_EVENT_NAME!=='workflow_dispatch'||
    env.COVE_EXCLUSIVE_WRITER_AUDIT!=='EXCLUSIVE_D1_WRITERS_READONLY')
    throw Error('writer_audit_invocation_denied');
  if(typeof env.COVE_CF_WORKERS_METADATA_READ_TOKEN!=='string'||
    env.COVE_CF_WORKERS_METADATA_READ_TOKEN.length<20)
    throw Error('writer_audit_missing_metadata_read_token');
}
function inventory(raw){
  if(!Array.isArray(raw)||raw.length<2||raw.length>MAX_WORKERS)throw Error('writer_audit_incomplete_inventory');
  const rows=raw.map(x=>{
    if(typeof x?.id!=='string'||!/^[a-z0-9_-]{3,128}$/.test(x.id)||
      typeof x.modified_on!=='string'||!Number.isFinite(Date.parse(x.modified_on)))
      throw Error('writer_audit_invalid_inventory_row');
    return {name:x.id,modified:x.modified_on};
  }).sort((a,b)=>a.name.localeCompare(b.name));
  if(new Set(rows.map(x=>x.name)).size!==rows.length)throw Error('writer_audit_duplicate_worker');
  return rows;
}
export async function inspectPrimaryD1Writers({listWorkers,readSettings}){
  const first=inventory(await listWorkers());
  const bindings=[];
  let ownerEnabled=false,ownerPrimaryId=false;
  for(const row of first){
    const settings=await readSettings(row.name);
    if(!Array.isArray(settings?.bindings))throw Error('writer_audit_missing_worker_settings');
    const b=settings.bindings;
    if(row.name===OWNER_WORKER){
      ownerEnabled=b.some(x=>x.type==='plain_text'&&x.name==='COVE_RIGHTS_OWNER_ENABLED'&&x.text==='1');
      ownerPrimaryId=b.some(x=>x.type==='plain_text'&&x.name==='COVE_RIGHTS_OWNER_PRIMARY_ID'&&x.text===PRIMARY_D1_ID);
    }
    if(b.some(x=>x.type==='d1'&&(x.id===PRIMARY_D1_ID||x.database_id===PRIMARY_D1_ID)))
      bindings.push(row.name);
  }
  if(JSON.stringify(first)!==JSON.stringify(inventory(await listWorkers())))
    throw Error('writer_audit_inventory_changed_during_scan');
  if(!first.some(x=>x.name===OWNER_WORKER))throw Error('writer_audit_owner_worker_missing');
  const competingWorkers=bindings.filter(x=>x!==OWNER_WORKER),blockers=[];
  if(!bindings.includes(OWNER_WORKER)||!ownerPrimaryId)blockers.push('owner_primary_binding_missing');
  if(!ownerEnabled)blockers.push('owner_not_enabled');
  if(competingWorkers.length)blockers.push('nonowner_primary_bindings_present');
  return {
    auditedWorkers:first.length,primaryD1Bindings:bindings,competingWorkers,ownerEnabled,
    bindingGatePassed:blockers.length===0,blockers,
    inventoryAtomicSnapshot:false,tokenWriteScopeCertified:false,releaseCertified:false
  };
}
/** Fixed GET-only Cloudflare API surface, with shared rate and retry limits. */
export function createReadOnlyCloudflareClient({token,fetchImpl=fetch,now=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
  let nextAllowed=-Infinity,rateLimits=0,waitingMs=0,attempts=0;
  async function get(path){
    if(!/^\/accounts\/d26430caa63ec55f6612e32f36aca5e9\/workers\/scripts(?:\/[a-z0-9_-]{3,128}\/settings)?$/.test(path))
      throw Error('writer_audit_endpoint_denied');
    for(let retry=0;retry<=RETRIES.length;retry++){
      if(++attempts>2*MAX_WORKERS+MAX_RATE_LIMITS+2)throw Error('writer_audit_request_budget_exhausted');
      const pause=Math.max(0,nextAllowed-now());if(pause)await sleep(pause);
      nextAllowed=now()+MIN_GAP_MS;
      const response=await fetchImpl('https://api.cloudflare.com/client/v4'+path,{
        method:'GET',headers:{Authorization:'Bearer '+token,Accept:'application/json'},signal:AbortSignal.timeout(15000)
      });
      if(response.status===429){
        await response.body?.cancel?.();rateLimits++;
        if(retry>=RETRIES.length||rateLimits>MAX_RATE_LIMITS||waitingMs+RETRIES[retry]>MAX_WAIT_MS)
          throw Error('writer_audit_cloudflare_rate_limited');
        waitingMs+=RETRIES[retry];await sleep(RETRIES[retry]);continue;
      }
      if(response.status!==200){
        await response.body?.cancel?.();throw Error('writer_audit_cloudflare_http_'+response.status);
      }
      const result=await response.json();
      if(result?.success!==true||!Array.isArray(result.errors)||result.errors.length||result.result===undefined)
        throw Error('writer_audit_cloudflare_invalid_response');
      return result;
    }
    throw Error('writer_audit_cloudflare_rate_limited');
  }
  return {
    async listWorkers(){
      const data=await get('/accounts/'+ACCOUNT_ID+'/workers/scripts');
      if(!Array.isArray(data.result)||
        (data.result_info?.total_count!==undefined&&data.result_info.total_count!==data.result.length))
        throw Error('writer_audit_inventory_pagination_incomplete');
      return data.result;
    },
    async readSettings(name){
      if(!/^[a-z0-9_-]{3,128}$/.test(name))throw Error('writer_audit_invalid_worker_name');
      return (await get('/accounts/'+ACCOUNT_ID+'/workers/scripts/'+name+'/settings')).result;
    }
  };
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--live')throw Error('writer_audit_live_opt_in_required');
    requireProtectedInvocation(process.env);
    const result=await inspectPrimaryD1Writers(createReadOnlyCloudflareClient({token:process.env.COVE_CF_WORKERS_METADATA_READ_TOKEN}));
    console.log(JSON.stringify(result));
    if(!result.bindingGatePassed)process.exitCode=1;
  }catch(e){
    console.error(String(e?.message||'').match(/^writer_audit_[a-z0-9_]+$/)?.[0]||'writer_audit_failed');
    process.exitCode=1;
  }
}
