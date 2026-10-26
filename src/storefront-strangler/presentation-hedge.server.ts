/* eslint-disable prettier/prettier -- Private presentation reads need bounded, source-attributed hedging. */
import type {PrivatePresentationStore} from "./prepared-catalog.server";

type KvPort={get(key:string,options:{type:"text";cacheTtl:number}):Promise<string|null>};
type Clock=()=>number;
export type PresentationReadEvidence={
  selected:"kv"|"r2";kvMs:number|null;r2Ms:number|null;hedged:boolean;
};

/**
 * Presentation bytes are untrusted, never grants. Primary or strong-owner
 * rights must be checked again AFTER this returns, even when KV wins.
 *
 * A new isolate can occasionally spend >600ms awaiting KV. Launch a
 * separate R2 read only when the first source hasn't produced a usable
 * object by the hedge threshold. No cache of authorizations, shared pending
 * I/O, arbitrary client headers or stale fallback is introduced here.
 */
export function hedgedPrivatePresentation(
  r2:PrivatePresentationStore,kv:KvPort,
  options:{hedgeAfterMs?:number;onEvidence?:(data:PresentationReadEvidence)=>void;clock?:Clock}={}
):PrivatePresentationStore {
  const hedgeAfterMs=options.hedgeAfterMs??45;
  if(!Number.isSafeInteger(hedgeAfterMs)||hedgeAfterMs<1||hedgeAfterMs>500)
    throw Error("Invalid presentation hedge threshold");
  const clock=options.clock??(()=>Date.now());
  return {async get(key:string){
    const started=clock();
    let kvMs:number|null=null,r2Ms:number|null=null,hedged=false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    let startR2:(()=>void)|undefined;
    let finishHedge:(value:{size:number;text():Promise<string>})=>void=()=>{};
    const backup=new Promise<{size:number;text():Promise<string>}>((resolve,reject)=>{
      finishHedge=resolve;
      startR2=()=>{
        if(hedged)return;
        hedged=true;
        if(timer!==undefined)clearTimeout(timer);
        const startedR2=clock();
        void r2.get(key).then(value=>{
          r2Ms=clock()-startedR2;
          if(!value)throw Error("Private R2 presentation missing");
          resolve(value);
        },reject).catch(reject);
      };
    });
    // The rejected KV cannot permit a stale response. R2 is independently
    // retrieved, and the caller still validates expiry, country and content.
    const fast=kv.get(key,{type:"text",cacheTtl:30}).then(body=>{
      kvMs=clock()-started;
      if(body===null)throw Error("Private KV presentation missing");
      if(timer!==undefined)clearTimeout(timer);
      const value={size:new TextEncoder().encode(body).byteLength,
        text:async()=>body};
      // Retire the waiting hedge when KV wins: no orphaned timer or R2 read.
      if(!hedged)finishHedge(value);
      return value;
    }).catch(error=>{
      kvMs=clock()-started;
      startR2?.();
      throw error;
    });
    timer=setTimeout(()=>startR2?.(),hedgeAfterMs);
    try {
      const winner=await Promise.any([fast,backup]);
      options.onEvidence?.({selected:hedged&&r2Ms!==null?"r2":"kv",
        kvMs,r2Ms,hedged});
      return winner;
    }finally{if(timer!==undefined)clearTimeout(timer);}
  }};
}
