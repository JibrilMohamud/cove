/* eslint-disable prettier/prettier -- Fixed isolated snapshot ingestion protocol. */
import {plan,target,maxBytes,insertSql,validateRows} from "./detached-real-catalog-copy-plan.mjs";
export default {
  async fetch(request,env){
    const response=(status,body=null)=>new Response(body,{status,headers:{"cache-control":"no-store","x-cove-catalog-snapshot-run":env.RUN||""}});
    const auth=request.headers.get("authorization")||"";
    if(!/^[a-f0-9]{64}$/.test(env.GATE||"")||!/^Bearer [a-f0-9]{64}$/.test(auth))return response(401);
    const digest=async(v)=>new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v)));
    const [a,b]=await Promise.all([digest(auth),digest("Bearer "+env.GATE)]);
    let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];
    if(diff)return response(401);
    if(env.TARGET!==target||!/^\d+-\d+$/.test(env.RUN||"")||!Number.isSafeInteger(Number(env.EXPIRES))||Date.now()>=Number(env.EXPIRES))return response(403);
    const url=new URL(request.url);
    if(url.pathname!=="/copy"||url.search||request.method!=="POST")return response(404);
    const reader=request.body?.getReader();if(!reader)return response(400);
    const bytes=new Uint8Array(maxBytes+2048);let n=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;if(n+value.byteLength>bytes.length){await reader.cancel();return response(413);}bytes.set(value,n);n+=value.byteLength;}}
    finally{reader.releaseLock();}
    let body;try{body=JSON.parse(new TextDecoder().decode(bytes.subarray(0,n)));}catch{return response(400);}
    if(body?.operation==="probe"&&Object.keys(body).length===1)return response(204);
    if(body?.operation==="unseal"&&Object.keys(body).length===1){
      await env.SNAPSHOT.prepare("DELETE FROM cove_snapshot_copy_receipt WHERE singleton=1").run();
      return response(204);
    }
    if(body?.operation==="seal"&&Object.keys(body).sort().join(",")==="editions,manifestDigest,operation,products,sha,transferDigest"){
      if(![body.manifestDigest,body.sha,body.transferDigest].every(x=>typeof x==="string")||
         !/^[a-f0-9]{40}$/.test(body.sha)||!(/^[a-f0-9]{64}$/).test(body.manifestDigest)||!(/^[a-f0-9]{64}$/).test(body.transferDigest)||
         !Number.isSafeInteger(body.products)||body.products<82247||body.editions!==body.products)return response(400);
      const counts=await env.SNAPSHOT.prepare("SELECT (SELECT COUNT(*) FROM products) products,(SELECT COUNT(*) FROM editions) editions").first();
      if(counts?.products!==body.products||counts?.editions!==body.editions)return response(409);
      const [id,attempt]=env.RUN.split("-");
      const saved=await env.SNAPSHOT.prepare("INSERT INTO cove_snapshot_copy_receipt(singleton,run_id,run_attempt,sha,transfer_digest,manifest_digest,products,editions,completed_at) VALUES(1,?,?,?,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET run_id=excluded.run_id,run_attempt=excluded.run_attempt,sha=excluded.sha,transfer_digest=excluded.transfer_digest,manifest_digest=excluded.manifest_digest,products=excluded.products,editions=excluded.editions,completed_at=excluded.completed_at").bind(id,attempt,body.sha,body.transferDigest,body.manifestDigest,body.products,body.editions,new Date().toISOString()).run();
      return response(saved.success?204:502);
    }
    if(body?.operation!=="copy"||Object.keys(body).sort().join(",")!=="operation,rows,table")return response(400);
    const item=plan.find(x=>x.table===body.table);if(!item)return response(400);
    try{validateRows(item,body.rows);}catch{return response(400);}
    try{
      const result=await env.SNAPSHOT.prepare(insertSql(item)).bind(JSON.stringify(body.rows)).run();
      if(!result.success)return response(502);
      return response(204);
    }catch{return response(502);}
  }
};
