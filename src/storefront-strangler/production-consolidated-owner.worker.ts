/* eslint-disable prettier/prettier -- private production persistence candidate */
import {WorkerEntrypoint} from "cloudflare:workers";
import {handleLiteraryOwnerService,type LiteraryOwnerServiceEnv} from "./literary-owner-service";
import {LITERARY_READ_ROUTE,LITERARY_HANDOFF_ROUTE,LITERARY_PUBLICATION_ROUTE} from "./literary-owner-protocol";
import {readPublicationSource} from "./publication-source-reader";
import {PUBLICATION_SOURCE_ROUTE} from "./publication-source-protocol";
import {readSoundsPublicationSource} from "./sounds-source-reader";
import {SOUNDS_SOURCE_ROUTE} from "./sounds-source-protocol";
import legacyLegal,{CoveLegalAuthority as ExistingLegalAuthority} from "./legal-authority.worker";
import backend,{type BackendEnv} from "../persistence-backend.worker";
import {nativeFencedBusinessDb} from "./consolidated-owner-qa.worker";
import {bindPublicationOwner} from "./publication-owner-routing.server";
import {attestDisabledOwnerFromBackend} from "./production-disabled-owner-attestation";
import {publishCheckedBiosyncOwned} from "./owner-biosync-checked-publication.stage";
import {persistSourceWithdrawal,persistSourceWithdrawalsBatch,type AuthoritySql} from "./legal-authority-core";
import {denyCommercialProduct,denyCommercialProductsBatch,denyCommercialSubject} from "./commercial-legal-core";
import {denyMarket} from "./market-authority-core";
import {denyPaidOrder,denyPaidEntitlement,denyPaidEntitlementsBatch} from "./commercial-entitlement-core";
import {LITERARY_BUDGET_CRON,LITERARY_BUDGET_PROBE_CRON,rollOwnedLiteraryBudget,recordOwnedBudgetTick} from "./literary-owner-budget-rollover";
import {assertCronSettled} from "../lib/cron-result-guard";
import {productionPersistenceEnrolled,productionBiosyncEnrolled,productionBiosyncBridgeEnrolled,productionNamedBiosyncEnrolled,productionLiteraryBudgetEnrolled,productionBiosyncRequest,
  productionOwnerInternalRequest,maintenanceBusinessRoute,checkToken,bearer,refuse,noStore,
  PRODUCTION_OWNER_OBJECT,PRODUCTION_SCHEDULES,OWNER_SCHEDULE_PATH,OWNER_BIOSYNC_PATH,
  type ProductionPersistenceEnv} from "./production-persistence-enrollment";

type LegalEnv=Parameters<typeof legacyLegal.fetch>[1];
type Env=LegalEnv&ProductionPersistenceEnv&LiteraryOwnerServiceEnv&{
  COVE_PUBLICATION_SOURCE_READER_SECRET?:string;
  COVE_PRODUCTION_LITERARY_BUDGET_CRON_ENABLED?:string;
  COVE_PRODUCTION_LITERARY_BUDGET_RELEASE_SHA?:string;
  COVE_SOUNDS_SOURCE_READER_SECRET?:string;
};
type Port={fetch(request:Request):Promise<Response>};
type Storage={sql:AuthoritySql;transactionSync<T>(fn:()=>T):T};

// Retain the deployed DO class name, namespace and inherited schema/handlers.
// No existing QA lease, test credential, positive grant or synthetic proof is
// accepted by this production mode. Unrecognized production commands deny.
const negativeRoutes=new Set([
  "/deny-next","/deny-next-batch","/market/deny-next",
  "/commercial/deny-next","/commercial/deny-batch","/commercial/subject/deny-next",
  "/commercial/order/deny-next","/commercial/entitlement/deny-next","/commercial/entitlement/deny-batch"
]);
const reply=(value:unknown,status=200)=>Response.json(value,{status,headers:noStore});
const body=async(request:Request,max:number)=>{
  const length=request.headers.get("content-length");
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)>max))throw Error("body_bound");
  const reader=request.body?.getReader();
  if(!reader)throw Error("body_missing");
  const chunks:Uint8Array[]=[];let n=0;
  try{
    for(;;){const part=await reader.read();if(part.done)break;
      n+=part.value.byteLength;
      if(n>max){await reader.cancel();throw Error("body_bound");}
      chunks.push(part.value);
    }
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(n);let at=0;
  for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as unknown;
};
function nativeBusinessEnv(env:Env,owner:Port):BackendEnv{
  if(!productionPersistenceEnrolled(env))throw Error("production_persistence_not_enrolled");
  // Remove raw primary, separate literary storage and owner-only secrets.
  // Backend receives only the native business facade and closed command port.
  const bindings=Object.fromEntries(Object.entries(env).filter(([key])=>
    !["PRIMARY_DB","LITERARY_CONTENT_DB","LITERARY_BUCKET","DB",
      "COVE_PUBLICATION_SOURCE_READER_SECRET","COVE_SOUNDS_SOURCE_READER_SECRET",
      "COVE_BIOSYNC_CLIENT_TOKEN_SHA256"].includes(key)&&!key.startsWith("COVE_LITERARY_")));
  const db=bindPublicationOwner(nativeFencedBusinessDb(env.PRIMARY_DB),{
    owner,secret:env.COVE_RIGHTS_OWNER_SECRET!,territory:"US",currency:"USD"
  });
  return {...bindings,DB:db,COVE_QA_SCHEDULE_OWNER_ENABLED:"0",
    COVE_PUBLICATION_COMMANDS_ENABLED:"0",COVE_QA_OWNER_UNBOUND_READ_ENABLED:"0"} as BackendEnv;
}
function ownerCall(env:Env,path:string,value:unknown){
  return env.LEGAL_AUTHORITY!.getByName(PRODUCTION_OWNER_OBJECT).fetch(
    new Request("https://legal-authority.internal"+path,{
      method:"POST",headers:{authorization:"Bearer "+env.COVE_RIGHTS_OWNER_SECRET,
        "content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(value)
    }));
}
function scheduleInput(raw:unknown){
  const x=raw as {cron?:unknown;slot?:unknown}|null;
  if(!x||Object.keys(x).sort().join(",")!=="cron,slot"||
    typeof x.cron!=="string"||!PRODUCTION_SCHEDULES.includes(x.cron)||
    !Number.isSafeInteger(x.slot)||Math.abs(Number(x.slot)-Math.floor(Date.now()/60000))>2)
    throw Error("production_cron_invalid");
  return {cron:x.cron,slot:Number(x.slot)};
}
export class CoveLegalAuthority extends ExistingLegalAuthority{
  override async fetch(request:Request):Promise<Response>{
    const env=this.env as Env,route=new URL(request.url).pathname;
    if(env.COVE_PRODUCTION_BIOSYNC_BRIDGE_ENABLED==="1"&&route===OWNER_BIOSYNC_PATH){
      if(!productionBiosyncBridgeEnrolled(env))return refuse();
      if(!productionOwnerInternalRequest(request,env.COVE_RIGHTS_OWNER_SECRET!))return refuse(401);
      try{return reply(await publishCheckedBiosyncOwned(env.PRIMARY_DB,env.BUCKET,await body(request,1024)));}
      catch{return refuse();}
    }
    if(env.COVE_PRODUCTION_PERSISTENCE_OWNER_ENABLED!=="1")return super.fetch(request);
    if(!productionPersistenceEnrolled(env))return refuse();
    // Preserve the old explicitly nonauthorizing challenge. It is still true
    // that the production positive-rights owner is disabled.
    if(route==="/__cove/legal-owner/attest-disabled")return super.fetch(request);
    if(!productionOwnerInternalRequest(request,env.COVE_RIGHTS_OWNER_SECRET!))return refuse(401);
    if(!negativeRoutes.has(route)&&route!==OWNER_BIOSYNC_PATH&&route!==OWNER_SCHEDULE_PATH)
      return refuse(503);
    const storage=this.ctx.storage as unknown as Storage;
    try{
      const raw=await body(request,route===OWNER_SCHEDULE_PATH?512:route===OWNER_BIOSYNC_PATH?1024:24000);
      if(route===OWNER_BIOSYNC_PATH){
        if(!productionBiosyncEnrolled(env))return refuse();
        return reply(await publishCheckedBiosyncOwned(env.PRIMARY_DB,env.BUCKET,raw));
      }
      if(route===OWNER_SCHEDULE_PATH){
        if(env.COVE_PRODUCTION_PERSISTENCE_CRON_ENABLED!=="1")return refuse();
        const x=scheduleInput(raw);
        // Production-specific durable journal, never reuse synthetic receipts.
        const sql=storage.sql;
        sql.exec("CREATE TABLE IF NOT EXISTS cove_production_schedule_receipts(cron TEXT NOT NULL,slot INTEGER NOT NULL,state TEXT NOT NULL,task_count INTEGER,PRIMARY KEY(cron,slot))");
        const claim=storage.transactionSync(()=>{
          const old=sql.exec<{state:string;task_count:number|null}>(
            "SELECT state,task_count FROM cove_production_schedule_receipts WHERE cron=? AND slot=?",x.cron,x.slot
          ).toArray()[0];
          if(old)return {fresh:false,...old};
          sql.exec("INSERT INTO cove_production_schedule_receipts(cron,slot,state) VALUES(?,?,'pending')",x.cron,x.slot);
          return {fresh:true,state:"pending",task_count:null};
        });
        if(!claim.fresh){
          if(claim.state!=="complete")return refuse(claim.state==="pending"?409:503);
          return reply({schema:"cove.production.owner-schedule.v1",...x,completed:true,taskCount:claim.task_count});
        }
        const tasks:Promise<unknown>[]=[];let failed=false;
        try{
          const {scheduleBackendOwnedWork}=await import("../persistence-backend.worker");
          scheduleBackendOwnedWork({cron:x.cron},nativeBusinessEnv(env,this),{
            waitUntil(promise){const task=Promise.resolve(promise);task.catch(()=>{});tasks.push(task);}
          },true);
        }catch{failed=true;}
        const settled=await Promise.allSettled(tasks);
        try{
          if(failed||tasks.length<1||tasks.length>4)throw Error("schedule_failed");
          assertCronSettled(settled);
          sql.exec("UPDATE cove_production_schedule_receipts SET state='complete',task_count=? WHERE cron=? AND slot=? AND state='pending'",tasks.length,x.cron,x.slot);
          return reply({schema:"cove.production.owner-schedule.v1",...x,completed:true,taskCount:tasks.length});
        }catch{
          sql.exec("UPDATE cove_production_schedule_receipts SET state='failed' WHERE cron=? AND slot=? AND state='pending'",x.cron,x.slot);
          return refuse();
        }
      }
      // Same existing negative primitives and existing legal DO tables.
      // They issue tombstones only, not a positive grant or serving receipt.
      const result=storage.transactionSync(()=>{
        switch(route){
          case "/deny-next":return persistSourceWithdrawal(storage.sql,raw);
          case "/deny-next-batch":return persistSourceWithdrawalsBatch(storage.sql,raw);
          case "/market/deny-next":return denyMarket(storage.sql,raw);
          case "/commercial/deny-next":return denyCommercialProduct(storage.sql,raw);
          case "/commercial/deny-batch":return denyCommercialProductsBatch(storage.sql,raw);
          case "/commercial/subject/deny-next":return denyCommercialSubject(storage.sql,raw);
          case "/commercial/order/deny-next":return denyPaidOrder(storage.sql,raw);
          case "/commercial/entitlement/deny-next":return denyPaidEntitlement(storage.sql,raw);
          case "/commercial/entitlement/deny-batch":return denyPaidEntitlementsBatch(storage.sql,raw);
          default:throw Error("production_positive_command_denied");
        }
      });
      return reply(result,"applied" in result&&result.applied===false?409:200);
    }catch{return refuse();}
  }
}
/** Named, service-binding-only ingress for the independent hourly publisher. */
export class CoveBioSyncEntrypoint extends WorkerEntrypoint<Env>{
  async fetch(request:Request):Promise<Response>{
    const env=this.env;
    if(!productionNamedBiosyncEnrolled(env))return refuse();
    if(!productionBiosyncRequest(request))return refuse(404);
    if(!await checkToken(bearer(request),env.COVE_BIOSYNC_CLIENT_TOKEN_SHA256))return refuse(401);
    try{return await ownerCall(env,OWNER_BIOSYNC_PATH,await body(request,1024));}catch{return refuse();}
  }
}
export class CoveBusinessEntrypoint extends WorkerEntrypoint<Env>{
  async fetch(request:Request):Promise<Response>{
    const env=this.env;
    if(!productionPersistenceEnrolled(env))return refuse();
    if(productionBiosyncRequest(request)){
      if(!productionBiosyncEnrolled(env))return refuse();
      if(!await checkToken(bearer(request),env.COVE_BIOSYNC_CLIENT_TOKEN_SHA256))return refuse(401);
      try{return await ownerCall(env,OWNER_BIOSYNC_PATH,await body(request,1024));}catch{return refuse();}
    }
    if(!await checkToken(request.headers.get("x-cove-backend-token")||"",env.FORE_BACKEND_TOKEN_SHA256))return refuse(401);
    if(!maintenanceBusinessRoute(request))return refuse();
    // Original authenticated handler, original legal/commerce SQL fences,
    // no remotely supplied SQL, no second primary binding.
    return backend.fetch(request,nativeBusinessEnv(env,env.LEGAL_AUTHORITY!.getByName(PRODUCTION_OWNER_OBJECT)),this.ctx);
  }
  async attestDisabledOwner(){
    if(!productionPersistenceEnrolled(this.env))throw Error("production_persistence_not_enrolled");
    return attestDisabledOwnerFromBackend(this.env);
  }
}
export default {
  // Preserve the private original default entrypoint and disabled challenge.
  async fetch(request:Request,env:Env){
    const route=new URL(request.url).pathname;
    // Already-live independently authenticated private services. Preserve
    // their exact protocols even while positive legal issuance is disabled.
    if([LITERARY_READ_ROUTE,LITERARY_HANDOFF_ROUTE,LITERARY_PUBLICATION_ROUTE,
      PUBLICATION_SOURCE_ROUTE,SOUNDS_SOURCE_ROUTE].includes(route)){
      if(env.COVE_RIGHTS_OWNER_ENABLED!=="0"||env.COVE_RIGHTS_OWNER_TEST_EXPIRES_AT||
        env.COVE_SSR_STAGING==="1"||env.FORE_ENVIRONMENT!=="production")return refuse();
      if([LITERARY_READ_ROUTE,LITERARY_HANDOFF_ROUTE,LITERARY_PUBLICATION_ROUTE].includes(route))
        return handleLiteraryOwnerService(request,env);
      if(route===PUBLICATION_SOURCE_ROUTE)
        return readPublicationSource(request,env as unknown as Parameters<typeof readPublicationSource>[1]);
      return readSoundsPublicationSource(request,env);
    }
    return legacyLegal.fetch(request,env);
  },
  async scheduled(controller:{cron:string;scheduledTime:number},env:Env){
    if([LITERARY_BUDGET_CRON,LITERARY_BUDGET_PROBE_CRON].includes(controller.cron)){
      if(env.COVE_PRODUCTION_LITERARY_BUDGET_CRON_ENABLED!=="1"||!productionLiteraryBudgetEnrolled(env))
        throw Error("literary_budget_owner_not_enrolled");
      const receipt=await rollOwnedLiteraryBudget(env.PRIMARY_DB,env.LITERARY_CONTENT_DB!);
      await recordOwnedBudgetTick(env.LITERARY_CONTENT_DB!,receipt,controller.scheduledTime,env.COVE_PRODUCTION_LITERARY_BUDGET_RELEASE_SHA||"",controller.cron);
      console.info(JSON.stringify(receipt));
      return;
    }
    if(!productionPersistenceEnrolled(env)||env.COVE_PRODUCTION_PERSISTENCE_CRON_ENABLED!=="1")
      throw Error("production_schedule_not_enrolled");
    const x=scheduleInput({cron:controller.cron,slot:Math.floor(controller.scheduledTime/60000)});
    const response=await ownerCall(env,OWNER_SCHEDULE_PATH,x);
    if(response.status!==200||response.headers.get("cache-control")!=="no-store")
      throw Error("production_schedule_not_acknowledged");
    const r=await response.json() as {schema?:unknown;cron?:unknown;slot?:unknown;completed?:unknown;taskCount?:unknown};
    if(r.schema!=="cove.production.owner-schedule.v1"||r.cron!==x.cron||r.slot!==x.slot||
      r.completed!==true||!Number.isSafeInteger(r.taskCount)||Number(r.taskCount)<1||Number(r.taskCount)>4)
      throw Error("production_schedule_receipt_invalid");
  }
};
