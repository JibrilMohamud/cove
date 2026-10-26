/* eslint-disable prettier/prettier -- Private deny-first canonical writer trust boundary. */
import {denyWithOwnedSourceEpoch} from "./legal-authority-coordinator";

type WriteDB={
  prepare(query:string):{bind(...args:unknown[]):{run():Promise<unknown>}};
};
type QaWriterEnv={
  PRIMARY_DB:WriteDB;
  LEGAL_PRIVATE:{fetch(request:Request):Promise<Response>};
  COVE_LEGAL_WRITER_ENABLED?:string;
  COVE_LEGAL_WRITER_PRIMARY_ID?:string;
  COVE_LEGAL_WRITER_EXPIRES_AT?:string;
  COVE_LEGAL_WRITER_SECRET?:string;
  COVE_RIGHTS_OWNER_SECRET?:string;
};
const QA_PRIMARY="5e3a6b69-6f3d-4b19-b837-01f7aa56ce87";
const sourceIdRegex=/^(?:[0-9]{1,10}|(?:pgca|pgau|pgeu)_[a-z0-9_]{1,90})$/;
const opIdRegex=/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

function qaWriterConfigured(env:QaWriterEnv){
  const exp=Number(env.COVE_LEGAL_WRITER_EXPIRES_AT),at=Date.now();
  return env.COVE_LEGAL_WRITER_ENABLED==="1" &&
    env.COVE_LEGAL_WRITER_PRIMARY_ID===QA_PRIMARY &&
    Number.isSafeInteger(exp)&&exp>at&&exp<=at+15*60*1000 &&
    !!env.COVE_LEGAL_WRITER_SECRET &&
    /^[a-f0-9]{64}$/.test(env.COVE_LEGAL_WRITER_SECRET) &&
    !!env.COVE_RIGHTS_OWNER_SECRET &&
    /^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET) &&
    typeof env.LEGAL_PRIVATE?.fetch==="function" &&
    typeof env.PRIMARY_DB?.prepare==="function";
}

export default {
  async fetch(request:Request,env:QaWriterEnv):Promise<Response>{
    const headers={"cache-control":"no-store"};
    if(!qaWriterConfigured(env))return new Response(null,{status:503,headers});
    if(request.headers.get("authorization")!=="Bearer "+env.COVE_LEGAL_WRITER_SECRET)
      return new Response(null,{status:401,headers});
    if(request.method!=="POST" || new URL(request.url).pathname!=="/quarantine" ||
       request.headers.get("content-type")?.split(";")[0]?.trim()!=="application/json" ||
       request.headers.has("cookie"))
      return new Response(null,{status:405,headers});
    let cmd:{sourceId?:unknown;operationId?:unknown;message?:unknown};
    try{
      const text=await request.text();
      if(text.length>900)return new Response(null,{status:413,headers});
      cmd=JSON.parse(text);
    }catch{return new Response(null,{status:400,headers});}
    if(!cmd||!sourceIdRegex.test(String(cmd.sourceId||"")) ||
       !opIdRegex.test(String(cmd.operationId||"")) ||
       typeof cmd.message!=="string"||cmd.message.length>500)
      return new Response(null,{status:400,headers});
    try{
      // The only legal mutation allowed by this service. The DO commits the
      // revocation before ANY SQL may execute. No generic SQL or delegated
      // batch endpoint exists; the legacy caller has no raw QA writer binding.
      await denyWithOwnedSourceEpoch(
        env.LEGAL_PRIVATE,env.COVE_RIGHTS_OWNER_SECRET!,{
          sourceId:cmd.sourceId as string,territory:"*",
          operationId:cmd.operationId as string
        },async()=>
          env.PRIMARY_DB.prepare(
            "UPDATE gutenberg_source_cache SET rights_status='quarantined',commercial_use_status='quarantined',ingest_status='quarantined' WHERE id=?"
          ).bind(cmd.sourceId).run()
      );
      return Response.json({quarantined:true},{status:200,headers});
    }catch{
      // Unknown owner / unavailable D1 / stale denied op always fail closed.
      return new Response(null,{status:503,headers});
    }
  }
};
