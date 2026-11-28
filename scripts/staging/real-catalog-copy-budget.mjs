/* eslint-disable prettier/prettier -- Shared bounded provider request budget for protected catalog copy. */
import {setTimeout as sleep} from "node:timers/promises";

// One budget across all credentials; Cloudflare's global user limit is 1200/5m.
// 500ms between requests reserves half the documented allowance for other clients.
export const requestSpacingMs=500;
const retryable=new Set([408,425,500,502,503,504]);
function positiveSeconds(value){
  if(typeof value!=="string"||!/^\d+$/.test(value.trim()))return null;
  const seconds=Number(value);return Number.isSafeInteger(seconds)?seconds:null;
}
export function ratePause(headers,now=Date.now()){
  const raw=headers.get("retry-after");
  const seconds=positiveSeconds(raw);
  const date=raw&&seconds===null?Date.parse(raw):NaN;
  const explicit=seconds!==null?seconds*1000:Number.isFinite(date)?Math.max(0,date-now):0;
  let reset=0,remaining=Infinity;
  for(const item of (headers.get("ratelimit")||"").split(",")){
    const r=positiveSeconds(/(?:^|;)\s*r=(\d+)/.exec(item)?.[1]);
    const t=positiveSeconds(/(?:^|;)\s*t=(\d+)/.exec(item)?.[1]);
    if(r!==null)remaining=Math.min(remaining,r);
    if(r!==null&&r<=10&&t!==null)reset=Math.max(reset,t*1000);
  }
  return {explicit,reset,remaining};
}
export function createProviderBudget({fetcher=fetch,clock=Date.now,wait=sleep,onBackoff=()=>{}}={}){
  let chain=Promise.resolve(),next=0;
  const pauseFor=(ms)=>{if(ms>600000)throw Error("Provider retry delay exceeds bounded import window");next=Math.max(next,clock()+ms);};
  const run=async(url,init,{safeRead=false,idempotentCleanup=false,label="provider"}={})=>{
    const replayable=safeRead||idempotentCleanup;
    for(let attempt=1;attempt<=9;attempt++){
      const pending=Math.max(0,next-clock());if(pending)await wait(pending);
      next=clock()+requestSpacingMs;
      let response;
      try{response=await fetcher(url,init);}
      catch(error){
        if(!replayable||!["TypeError","TimeoutError","AbortError"].includes(error.name)||attempt===9)throw error;
        const ms=Math.min(30000,1000*2**(attempt-1));onBackoff({label,attempt,kind:"transport",waitMs:ms});pauseFor(ms);continue;
      }
      const quota=ratePause(response.headers,clock());
      if(quota.remaining<=10&&quota.reset)pauseFor(quota.reset+1000);
      // Explicit throttling is safe to retry; ambiguous mutation failures are not.
      if(response.status===429&&attempt<9){
        const delay=Math.max(quota.explicit,quota.reset,quota.explicit||quota.reset?1000:300000)+1000;
        await response.body?.cancel();onBackoff({label,attempt,kind:"429",waitMs:delay});pauseFor(delay);continue;
      }
      if(replayable&&retryable.has(response.status)&&attempt<9){
        const delay=Math.max(quota.explicit,Math.min(30000,1000*2**(attempt-1)));
        await response.body?.cancel();onBackoff({label,attempt,kind:String(response.status),waitMs:delay});pauseFor(delay);continue;
      }
      return response;
    }
    throw Error("Provider request budget exhausted");
  };
  return (url,init,options)=>{
    const operation=chain.then(()=>run(url,init,options));
    chain=operation.then(()=>undefined,()=>undefined);
    return operation;
  };
}
