/* eslint-disable prettier/prettier -- Dedicated, bounded, read-only release audit transport. */
/**
 * Exact Cloudflare metadata endpoints only: NO D1 query, Worker deployment,
 * token creation/update/revoke or HTTP mutation. All calls globally paced.
 * Token values, URLs, Worker settings and upstream errors are never logged.
 */
const ACCOUNT='d26430caa63ec55f6612e32f36aca5e9';
const RETRY_MS=[20000,40000,80000];
// Two deployment reads plus immutable bindings for each serving version.
// 460 current Workers take ~1,400 calls, still globally paced at <=2/sec.
const MAX_REQUESTS=3000;
const MAX_429=5;
const MAX_429_WAIT_MS=180000;
const EXACT_USER_READ_GROUP_LOOKUPS=new Set([
  '/user/tokens/permission_groups?name=API%20Tokens%20Read',
  '/user/tokens/permission_groups?name=User%20Details%20Read',
  '/user/tokens/permission_groups?name=Account%20Analytics%20Read',
]);
function safePath(path){
  // One exact provider name-filtered READ permission is safe to enumerate.
  // No unfiltered catalog, Write/Admin, arbitrary query keys, hidden encoded
  // parameters, scope mutation or token update can pass this allowlist.
  if(EXACT_USER_READ_GROUP_LOOKUPS.has(path))return true;
  const readGroup=path.match(/^\/user\/tokens\/permission_groups\?name=([A-Za-z0-9%._()+-]{1,300})$/);
  if(readGroup){
    let decoded;
    try{decoded=decodeURIComponent(readGroup[1]);}catch{return false;}
    return decoded.length<=132&&
      /^[A-Za-z0-9][A-Za-z0-9 &/._()+-]* (?:Read|Read-Only)$/.test(decoded)&&
      encodeURIComponent(decoded)===readGroup[1];
  }
  if(path==='/user/tokens'||path==='/user')return true;
  if(path==='/accounts/'+ACCOUNT+'/members')return true;
  if(path==='/accounts/'+ACCOUNT+'/tokens')return true;
  if(path==='/accounts/'+ACCOUNT+'/workers/scripts')return true;
  return new RegExp('^/accounts/'+ACCOUNT+'/workers/scripts/[a-z0-9_-]{3,128}/(?:deployments|versions/[a-f0-9-]{36})$').test(path);
}
export function retryAfterMs(header,now){
  if(typeof header!=='string'||!header.trim())return 0;
  const s=header.trim();
  if(/^\d+(?:\.\d+)?$/.test(s)){
    const ms=Math.ceil(Number(s)*1000);
    return Number.isSafeInteger(ms)?ms:Infinity;
  }
  const t=Date.parse(s);
  return Number.isFinite(t)?Math.max(0,t-now):0;
}
export function createPhysicalWriterReadTransport({
  fetchImpl=fetch,
  now=()=>Date.now(),
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
}={}){
  let tail=Promise.resolve(),calls=0,limited=0,waited=0,nextAllowed=-Infinity;
  const stats=()=>({calls,rateLimited:limited,rateLimitWaitMs:waited});
  async function rawGet(path,token){
    if(!safePath(path))throw Error('writer_audit_endpoint_denied');
    if(typeof token!=='string'||token.length<20)throw Error('writer_audit_read_token_missing');
    for(let retry=0;retry<=RETRY_MS.length;retry++){
      if(calls>=MAX_REQUESTS)throw Error('writer_audit_request_budget_exhausted');
      const wait=Math.max(0,nextAllowed-now());
      if(wait)await sleep(wait);
      nextAllowed=now()+500;
      calls++;
      let response;
      try{
        response=await fetchImpl('https://api.cloudflare.com/client/v4'+path,{
          method:'GET',headers:{authorization:'Bearer '+token,accept:'application/json'},
          signal:AbortSignal.timeout(15000)
        });
      }catch{throw Error('writer_audit_transport_unavailable');}
      if(response.status===429){
        limited++;
        try{await response.body?.cancel?.();}catch{}
        if(retry===RETRY_MS.length||limited>MAX_429)throw Error('writer_audit_rate_limited');
        const retryHeader=retryAfterMs(response.headers?.get?.('retry-after'),now());
        const waitFor=Math.max(RETRY_MS[retry],retryHeader);
        if(!Number.isSafeInteger(waitFor)||waitFor>MAX_429_WAIT_MS-waited)
          throw Error('writer_audit_rate_limited');
        waited+=waitFor;
        await sleep(waitFor);
        continue;
      }
      if(response.status!==200){
        try{await response.body?.cancel?.();}catch{}
        throw Error('writer_audit_http_'+response.status);
      }
      let payload;
      try{payload=await response.json();}catch{throw Error('writer_audit_invalid_response');}
      if(payload?.success!==true||!Array.isArray(payload.errors)||payload.errors.length||
         !Object.prototype.hasOwnProperty.call(payload,'result'))
        throw Error('writer_audit_invalid_response');
      return payload;
    }
    throw Error('writer_audit_rate_limited');
  }
  // Force all caller requests (including concurrent list parsing) into one
  // queue, and carry on after a fail-closed rejected request.
  const get=(path,token)=>{
    const promise=tail.then(()=>rawGet(path,token));
    tail=promise.then(()=>undefined,()=>undefined);
    return promise;
  };
  return {get,stats};
}
