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
