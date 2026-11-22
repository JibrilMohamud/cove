/* eslint-disable prettier/prettier -- Ephemeral, signed synthetic D1 gateway. Never bind production D1 or route customer traffic. */
const noStore={"cache-control":"no-store","content-type":"application/json"};
const deny=status=>new Response(JSON.stringify({success:false}),{status,headers:noStore});
function validEnvironment(env){
  return ["paid","legal"].includes(env.COVE_QA_D1_GATE_ALLOWED)&&
    /^[a-f0-9]{64}$/.test(env.COVE_QA_D1_GATE||"")&&
    /^\d{13}$/.test(env.COVE_QA_D1_GATE_EXPIRES_AT||"")&&
    Date.now()<Number(env.COVE_QA_D1_GATE_EXPIRES_AT)&&
    Number(env.COVE_QA_D1_GATE_EXPIRES_AT)-Date.now()<=45*60_000 &&
    env.QA_PRIMARY_DB?.prepare;
}
export default {
  async fetch(request,env){
    if(!validEnvironment(env))return deny(503);
    const url=new URL(request.url);
    if(request.headers.get("authorization")!=="Bearer "+env.COVE_QA_D1_GATE)
      return deny(401);
    if(request.method==="GET"&&url.pathname==="/__health")
      return new Response(JSON.stringify({ready:true}),{status:200,headers:noStore});
    if(["/__media-put","/__media-delete","/__media-head"].includes(url.pathname)){
      if(env.COVE_QA_D1_GATE_ALLOWED!=="paid"||
         !/^\d{8,15}-\d{1,5}$/.test(env.COVE_QA_MEDIA_RUN_ID||"")||
         !env.QA_MEDIA?.put||!env.QA_MEDIA?.delete||!env.QA_MEDIA?.head||
         request.method!=="POST"||url.search)
        return deny(503);
      let payload;
      try{
        const raw=await request.text();
        if(raw.length>120000)return deny(413);
        payload=JSON.parse(raw);
      }catch{return deny(400);}
      if(!payload||!["book.epub","chapter.wav","rights.txt"].includes(payload.name))
        return deny(400);
      const key="qa/"+env.COVE_QA_MEDIA_RUN_ID+"/"+payload.name;
      try{
        if(url.pathname==="/__media-put"){
          if(typeof payload.base64!=="string"||payload.base64.length>100000||
             !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.base64))return deny(400);
          const raw=atob(payload.base64);
          const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
          if(bytes.length===0||bytes.length>75000)return deny(400);
          const types={"book.epub":"application/epub+zip",
            "chapter.wav":"audio/wav","rights.txt":"text/plain"};
          await env.QA_MEDIA.put(key,bytes,{httpMetadata:{contentType:types[payload.name]}});
          return new Response(JSON.stringify({saved:true,key,size:bytes.length}),{headers:noStore});
        }
        if(url.pathname==="/__media-delete"){
          await env.QA_MEDIA.delete(key);
          return new Response(JSON.stringify({deleted:true,key}),{headers:noStore});
        }
        const object=await env.QA_MEDIA.head(key);
        return new Response(JSON.stringify({exists:!!object,key}),{headers:noStore});
      }catch{return deny(503);}
    }
    if(request.method!=="POST"||url.pathname!=="/__query"||url.search)
      return deny(404);
    if(Number(request.headers.get("content-length")||0)>24576)return deny(413);
    let input;
    try{
      const raw=await request.text();
      if(raw.length>24576)return deny(413);
      input=JSON.parse(raw);
    }catch{return deny(400);}
    if(!input||Array.isArray(input)||!["qa","schema"].includes(input.database)||
       (input.database==="schema"&&env.COVE_QA_D1_GATE_ALLOWED!=="paid")||
       typeof input.sql!=="string"||input.sql.length<4||input.sql.length>20000||
       !Array.isArray(input.params)||input.params.length>64||
       input.params.some(x=>x!==null&&typeof x!=="number"&&typeof x!=="string"&&typeof x!=="boolean")||
       /\b(?:ATTACH|DETACH|writable_schema)\b/i.test(input.sql))
      return deny(400);
    const db=input.database==="schema"?env.QA_SCHEMA_DB:env.QA_PRIMARY_DB;
    if(!db?.prepare)return deny(503);
    try{
      const statement=db.prepare(input.sql).bind(...input.params);
      const read=/^\s*(?:SELECT|PRAGMA|WITH)\b/i.test(input.sql);
      const outcome=read?await statement.all():await statement.run();
      return new Response(JSON.stringify({success:true,result:[{
        success:true,results:outcome.results||[],meta:outcome.meta||{}
      }]}),{status:200,headers:noStore});
    }catch{
      // Suppress SQL and identity from a publicly reachable ephemeral service.
      return deny(503);
    }
  }
};
