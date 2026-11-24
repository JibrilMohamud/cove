/* eslint-disable prettier/prettier -- Narrow stage-only primary cohort contract. */
import { authorizeStorefrontPresentationIds, type CatalogDB, type FirstPaintD1QueryMetrics, type PrimaryStorefrontAuthorityRow } from "../features/fore/catalog-model.server";
import { bootstrapFailureKind } from "./failure";

const STAGE_DB = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
type Input = { ids: string[]; territory: string; currency: string };
type Evidence = { rows: PrimaryStorefrontAuthorityRow[]; metrics: FirstPaintD1QueryMetrics };
type Job = { resolve(value: Evidence): void; reject(error: unknown): void };
type Cohort = { input: Input; jobs: Job[] };
type Namespace = { getByName(name: string): { fetch(request: Request): Promise<Response> } };
export type StageCohortEnv = {
  COVE_STAGE_PRIMARY_COHORT?: string;
  COVE_SSR_STAGING?: string;
  COVE_STRANGLER_MODE?: string;
  COVE_STRANGLER_DATABASE_ID?: string;
  COVE_STRANGLER_READ_MODEL?: string;
  COVE_SSR_STAGING_GATE_KEY?: string;
  STAGE_PRIMARY_COHORT?: Namespace;
  DB?: CatalogDB;
};

function enabled(env: StageCohortEnv) {
  return env.COVE_STAGE_PRIMARY_COHORT==="1" && env.COVE_SSR_STAGING==="1" &&
    env.COVE_STRANGLER_MODE==="isolated-evaluation" && env.COVE_STRANGLER_DATABASE_ID===STAGE_DB &&
    env.COVE_STRANGLER_READ_MODEL==="2" && /^[a-f0-9]{64}$/.test(env.COVE_SSR_STAGING_GATE_KEY||"");
}
function checked(raw: unknown): Input {
  if (!raw || typeof raw!=="object" || Array.isArray(raw)) throw Error("invalid stage primary cohort");
  const x=raw as Input;
  if (Object.keys(x).sort().join(",")!=="currency,ids,territory" ||
      !Array.isArray(x.ids)||x.ids.length<1||x.ids.length>128||
      x.ids.some(id=>typeof id!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_-]{1,159}$/.test(id))||
      new Set(x.ids).size!==x.ids.length||
      typeof x.territory!=="string"||!/^[A-Z]{2}$/.test(x.territory)||
      typeof x.currency!=="string"||!/^[A-Z]{3}$/.test(x.currency))
    throw Error("invalid stage primary cohort");
  return {ids:[...x.ids],territory:x.territory,currency:x.currency};
}

/** DO-only pending cohort. Never share a query with a request arriving
 * after dispatch. No settled result, promise, lease or legal grant cache.
 * Exact candidate order, currency and territory are part of the key.
 * Every admitted request receives its own response from a primary snapshot
 * that begins AFTER its admission. This is not production owner authority. */
export class FreshPrimaryCohorts {
  private pending = new Map<string,Cohort>();
  private active = 0;
  constructor(private read: (x: Input)=>Promise<Evidence>,
    private defer: (fn: ()=>void)=>void = fn=>{setTimeout(fn,20);}) {}
  submit(raw: unknown): Promise<Evidence> {
    const input=checked(raw);
    const key=JSON.stringify(input);
    return new Promise((resolve,reject)=>{
      let cohort=this.pending.get(key);
      if(cohort&&cohort.jobs.length>=32){
        this.flush(key,cohort);
        cohort=undefined;
      }
      if(!cohort){
        if(this.pending.size+this.active>=64){reject(Error("stage primary cohort overloaded"));return;}
        const created={input,jobs:[] as Job[]};
        this.pending.set(key,created);
        cohort=created;
        this.defer(()=>this.flush(key,created));
      }
      cohort.jobs.push({resolve,reject});
    });
  }
  private flush(key:string, cohort:Cohort) {
    if(this.pending.get(key)!==cohort)return;
    this.pending.delete(key); // Detach BEFORE initiating any primary read.
    this.active++;
    const jobs=cohort.jobs.splice(0);
    void (async()=>{
      try {
        const evidence=await this.read(cohort.input);
        if(evidence.metrics.servedByPrimary!==true)throw Error("D1 primary cohort receipt unavailable");
        for(const job of jobs)job.resolve(evidence);
      } catch(error){for(const job of jobs)job.reject(error);}
      finally{this.active--;}
    })();
  }
}

const reply=(status:number,body:unknown)=>Response.json(body,{status,headers:{"cache-control":"no-store"}});
const kinds=new Set(["d1-resource-window","d1-queue-full","d1-queue-wait","service-overloaded","transient-service","database","unclassified"]);
export class CoveStagePrimaryReadCohort {
  private cohorts: FreshPrimaryCohorts;
  constructor(_state:unknown,private env:StageCohortEnv){
    this.cohorts=new FreshPrimaryCohorts(async ({ids,territory,currency})=>{
      if(!enabled(this.env))throw Error("D1 stage cohort disabled");
      const db=this.env.DB as CatalogDB & {withSession?:(anchor:"first-primary")=>CatalogDB};
      if(typeof db?.withSession!=="function")throw Error("D1 primary session unavailable");
      const metrics:FirstPaintD1QueryMetrics={};
      const rows=await authorizeStorefrontPresentationIds(db.withSession("first-primary"),ids,territory,currency,metrics);
      return {rows,metrics};
    });
  }
  async fetch(request:Request):Promise<Response>{
    if(!enabled(this.env))return reply(503,{error:"disabled"});
    if(request.headers.get("authorization")!=="Bearer "+this.env.COVE_SSR_STAGING_GATE_KEY)
      return reply(401,{error:"denied"});
    const url=new URL(request.url);
    if(request.method!=="POST"||url.pathname!=="/primary-cohort"||url.search||request.headers.has("cookie"))
      return reply(404,{error:"denied"});
    let input:Input;
    try{
      const raw=await request.text();
      if(raw.length>24000)return reply(413,{error:"denied"});
      input=checked(JSON.parse(raw));
    }catch{return reply(400,{error:"denied"});}
    try{
      const evidence=await this.cohorts.submit(input);
      return reply(200,{schema:"cove.stage.primary-cohort.v1",...evidence});
    }catch(error){
      const kind=bootstrapFailureKind(error);
      return reply(503,{error:kinds.has(kind)?kind:"unclassified"});
    }
  }
}
export function stagePrimaryCohortReader(env:StageCohortEnv):typeof authorizeStorefrontPresentationIds|undefined{
  if(env.COVE_STAGE_PRIMARY_COHORT===undefined||env.COVE_STAGE_PRIMARY_COHORT==="0")return undefined;
  if(!enabled(env)||!env.STAGE_PRIMARY_COHORT?.getByName)throw Error("D1 stage cohort binding denied");
  return async (_db,ids,territory,currency,metrics)=>{
    const input=checked({ids,territory,currency});
    const response=await env.STAGE_PRIMARY_COHORT!.getByName("primary:"+territory).fetch(new Request("https://cohort.internal/primary-cohort",{
      method:"POST",headers:{"authorization":"Bearer "+env.COVE_SSR_STAGING_GATE_KEY,"content-type":"application/json"},
      body:JSON.stringify(input),
    }));
    const body=await response.json() as Evidence & {schema?:string;error?:string};
    if(response.status!==200){
      // Preserve the existing fixed provider failure classification. Never
      // retry, bypass the owner, or replace a denied sample.
      const messages:Record<string,string>={
        "d1-resource-window":"D1 DB is overloaded. Too many resources consumed within a 10 second window",
        "d1-queue-full":"D1 DB is overloaded. Too many requests queued",
        "d1-queue-wait":"D1 DB is overloaded. Requests queued for too long",
      };
      throw Error(messages[body.error||""]||"D1 stage cohort unavailable");
    }
    if(body.schema!=="cove.stage.primary-cohort.v1"||body.metrics?.servedByPrimary!==true||
      !Array.isArray(body.rows)||body.rows.length>25||
      body.rows.some((row,i)=>!row||!ids.includes(row.product_id)||(i>0&&ids.indexOf(row.product_id)<=ids.indexOf(body.rows[i-1].product_id))))
      throw Error("D1 stage cohort response invalid");
    if(metrics)Object.assign(metrics,body.metrics);
    return body.rows;
  };
}
