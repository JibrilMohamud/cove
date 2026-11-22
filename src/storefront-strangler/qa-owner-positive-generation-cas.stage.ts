/* eslint-disable prettier/prettier -- Owner/primary compare-and-swap protocol is reviewed as exact SQL. */
/**
 * ISOLATED QA ONLY. Executable, single-statement positive generation CAS,
 * deliberately incompatible with the sealed negative publication fence.
 *
 * The existing QA owner currently DOES NOT issue positive-authorizing receipts.
 * Without a distinct, genuinely reconciled owner-side positive certificate this
 * code always refuses publication. DO NOT route into production or serving.
 *
 * A committed primary generation cannot settle a legal race: consumers must
 * independently recheck the current owner before AND after reading any grant.
 */
import {
  currentQaOwnerEpochForNegativePublication,
  type QaOwnerReadBracket,
} from "./current-owner-primary-read-bracket.stage";

const QA_PRIMARY_ID = "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e";
const FENCE_SCHEMA = "cove.qa.owner-positive-generation.v1";
const OWNER_SCHEMA = "cove.qa.owner-reconciled-positive-certificate.v1";
const OWNER_ROUTE = "https://legal-authority.internal/qa/positive-generation-certificate";
const MAX_LEASE_MS = 30_000;

const FENCE_SELECT = `SELECT publication_schema,primary_id,owner_journal_version,
 owner_mutation_epoch,owner_rehearsal_revision,source_revision,
 active_generation,manifest_sha256,dirty,pending_withdrawals,pending_writes,
 eligibility_valid_until_ms,publication_revision
 FROM cove_qa_owner_positive_publication_fence WHERE slot=1`;

/** One SQLite statement changes the whole generation pointer (or nothing).
 * Counts, revision, explicit negative cohorts and real territorial rights VIEW
 * must match the reviewed SEALED candidate. A scalar SELECT before the CAS
 * is informational only; all authorizing WHERE tests repeat inside the CAS.
 */
export const QA_POSITIVE_GENERATION_CAS_SQL = `UPDATE cove_qa_owner_positive_publication_fence
 SET owner_mutation_epoch=?,source_revision=?,active_generation=?,
     manifest_sha256=?,dirty=0,pending_withdrawals=0,pending_writes=0,
     eligibility_valid_until_ms=?,publication_revision=publication_revision+1
 WHERE slot=1 AND publication_schema=? AND primary_id=?
   AND owner_journal_version=? AND owner_rehearsal_revision=?
   AND owner_mutation_epoch<=? AND publication_revision=?
   AND dirty=1 AND publication_revision<9007199254740991
   AND EXISTS(
     SELECT 1 FROM cove_qa_owner_positive_candidate c
     JOIN cove_qa_owner_positive_source_revision s ON s.slot=1
     WHERE c.generation=? AND c.primary_id=? AND c.owner_journal_version=?
       AND c.owner_epoch=? AND c.owner_rehearsal_revision=?
       AND c.source_revision=? AND c.manifest_sha256=?
       AND c.catalog_rows=? AND c.allow_rows=? AND c.deny_rows=?
       AND c.catalog_rows=c.allow_rows+c.deny_rows
       AND c.territory='US' AND c.sealed=1 AND c.dirty=0
       AND c.eligibility_valid_until_ms>=?
       AND s.revision=c.source_revision AND s.dirty=0
       AND (SELECT count(*) FROM products WHERE storefront_status='active')=c.catalog_rows
       AND (SELECT count(*) FROM cove_qa_owner_positive_candidate_products r
            WHERE r.generation=c.generation AND r.territory=c.territory)=c.catalog_rows
       AND (SELECT count(*) FROM cove_qa_owner_positive_candidate_products r
            WHERE r.generation=c.generation AND r.allowed=1)=c.allow_rows
       AND (SELECT count(*) FROM cove_qa_owner_positive_candidate_products r
            WHERE r.generation=c.generation AND r.allowed=0)=c.deny_rows
       AND NOT EXISTS(
         SELECT 1 FROM products p
         LEFT JOIN cove_qa_owner_positive_candidate_products r
           ON r.product_id=p.id AND r.generation=c.generation AND r.territory=c.territory
         WHERE p.storefront_status='active' AND r.product_id IS NULL
       )
       AND NOT EXISTS(
         SELECT 1 FROM cove_qa_owner_positive_candidate_products r
         WHERE r.generation=c.generation AND (
           NOT EXISTS(SELECT 1 FROM products p
             WHERE p.id=r.product_id AND p.storefront_status='active')
           OR (r.allowed=1 AND NOT EXISTS(
             SELECT 1 FROM retail_product_availability_rows legal
             WHERE legal.product_id=r.product_id AND legal.territory_code=r.territory))
           OR (r.allowed=0 AND EXISTS(
             SELECT 1 FROM retail_product_availability_rows legal
             WHERE legal.product_id=r.product_id AND legal.territory_code=r.territory))
         )
       )
   )
 RETURNING publication_schema,primary_id,owner_journal_version,
 owner_mutation_epoch,owner_rehearsal_revision,source_revision,
 active_generation,manifest_sha256,dirty,pending_withdrawals,pending_writes,
 eligibility_valid_until_ms,publication_revision`;

/** Safe denial-only convergence if owner advances in the commit window. */
export const QA_DIRTY_GENERATION_CAS_SQL = `UPDATE cove_qa_owner_positive_publication_fence
 SET dirty=1,eligibility_valid_until_ms=0,
     publication_revision=publication_revision+1
 WHERE slot=1 AND active_generation=? AND publication_revision=?
   AND dirty=0 AND publication_revision<9007199254740991
 RETURNING dirty,eligibility_valid_until_ms`;

type Statement = {bind(...params:unknown[]):Statement;first<T=unknown>():Promise<T|null>};
type Database = {withSession(mode:"first-primary"):{prepare(sql:string):Statement}};
type PositiveContext = Omit<QaOwnerReadBracket,"primary">&{
  primary:Database;
  COVE_QA_POSITIVE_GENERATION_ONLY?:string;
};
type Row=Record<string,unknown>;
type Certificate={
  schema:string;authorizing:true;challenge:string;primaryId:string;
  journalVersion:string;rehearsalRevision:"A"|"B";mutationEpoch:string;
  generation:number;sourceRevision:number;manifestSha256:string;
  territory:"US";catalogRows:number;allowRows:number;denyRows:number;
  completeHistoricalWithdrawals:true;completeCatalog:true;
  eligibilityValidUntilMs:number;
};
const blocked=():never=>{throw Error("qa_owner_positive_primary_publication_denied");};
const validNumber=(v:unknown,min=0)=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=min;
const randomChallenge=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),
  b=>b.toString(16).padStart(2,"0")).join("");
async function boundedJson(res:Response):Promise<unknown>{
  if(res.status!==200||!res.body||
     !/\bno-store\b/i.test(res.headers.get("cache-control")||"")||
     !/^application\/json(?:;|$)/i.test(res.headers.get("content-type")||""))blocked();
  const reader=res.body.getReader(),decoder=new TextDecoder("utf-8",{fatal:true});
  let raw="",bytes=0;
  try{
    while(true){
      const part=await reader.read();
      if(part.done)break;
      bytes+=part.value.byteLength;
      if(bytes>2048){await reader.cancel().catch(()=>undefined);blocked();}
      raw+=decoder.decode(part.value,{stream:true});
    }
    raw+=decoder.decode();
  }catch{blocked();}finally{reader.releaseLock();}
  try{return JSON.parse(raw);}catch{return blocked();}
}
async function positiveCertificate(
  x:PositiveContext,current:{epoch:number;version:string;primaryId:string;rehearsal:"A"|"B"},
  now:number
):Promise<Certificate>{
  const challenge=randomChallenge();
  const res=await x.owner.fetch(new Request(OWNER_ROUTE,{
    method:"POST",
    headers:{authorization:"Bearer "+x.secret,"content-type":"application/json",
      "cache-control":"no-store"},
    body:JSON.stringify({challenge}),
  }));
  const parsed=await boundedJson(res);
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))blocked();
  const c=parsed as Record<string,unknown>;
  if(Object.keys(c).sort().join(",")!==[
    "allowRows","authorizing","catalogRows","challenge","completeCatalog",
    "completeHistoricalWithdrawals","denyRows","eligibilityValidUntilMs",
    "generation","journalVersion","manifestSha256","mutationEpoch",
    "primaryId","rehearsalRevision","schema","sourceRevision","territory",
  ].sort().join(",")||
    c.schema!==OWNER_SCHEMA||c.authorizing!==true||c.challenge!==challenge||
    c.primaryId!==current.primaryId||c.journalVersion!==current.version||
    c.rehearsalRevision!==current.rehearsal||c.mutationEpoch!==String(current.epoch)||
    c.territory!=="US"||c.completeHistoricalWithdrawals!==true||
    c.completeCatalog!==true||!validNumber(c.generation,1)||
    !validNumber(c.sourceRevision,1)||!validNumber(c.catalogRows,1)||
    !validNumber(c.allowRows)||!validNumber(c.denyRows)||
    c.catalogRows!==Number(c.allowRows)+Number(c.denyRows)||
    typeof c.manifestSha256!=="string"||!/^[a-f0-9]{64}$/.test(c.manifestSha256)||
    !validNumber(c.eligibilityValidUntilMs,now+1)||
    Number(c.eligibilityValidUntilMs)>now+MAX_LEASE_MS)
    blocked();
  return c as Certificate;
}
function firstPrimary(x:PositiveContext){
  const session=x.primary.withSession("first-primary");
  if(!session?.prepare)blocked();
  return session;
}
const read=(x:PositiveContext)=>firstPrimary(x).prepare(FENCE_SELECT).first<Row>();
function validFence(row:Row|null,x:PositiveContext,owner:{
  epoch:number;version:string;primaryId:string;rehearsal:"A"|"B"
}){
  return !!row&&row.publication_schema===FENCE_SCHEMA&&
    row.primary_id===QA_PRIMARY_ID&&row.primary_id===x.primaryId&&
    row.owner_journal_version===owner.version&&
    row.owner_rehearsal_revision===owner.rehearsal&&
    validNumber(row.owner_mutation_epoch)&&validNumber(row.source_revision)&&
    validNumber(row.active_generation)&&validNumber(row.publication_revision)&&
    validNumber(row.pending_withdrawals)&&validNumber(row.pending_writes)&&
    validNumber(row.eligibility_valid_until_ms)&&
    (row.dirty===0||row.dirty===1);
}

/** Testable real SQLite pointer promotion. No production DB/owner/serving wiring.
 * The positive certificate is never accepted from a caller or historical audit;
 * current QA owner has no such endpoint, so this fails CLOSED until a genuinely
 * reconciled independent owner is implemented and separately reviewed.
 */
export async function publishQaOwnerPositiveGeneration(x:PositiveContext):Promise<{
  schema:string;generation:number;ownerEpoch:number;atomic:true;
  primaryCommitted:true;authorizing:false;productionReady:false
}>{
  if(x?.COVE_QA_POSITIVE_GENERATION_ONLY!=="1"||x.primaryId!==QA_PRIMARY_ID)
    blocked();
  const now=x.nowMs||Date.now,started=now();
  if(!validNumber(started,1))blocked();
  const owner=await currentQaOwnerEpochForNegativePublication(x);
  const c=await positiveCertificate(x,owner,started);
  const prior=await read(x);
  if(!validFence(prior,x,owner)||Number(prior.owner_mutation_epoch)>owner.epoch||
    prior.dirty!==1||Number(prior.publication_revision)>=Number.MAX_SAFE_INTEGER)
    blocked();
  const updated=await firstPrimary(x).prepare(QA_POSITIVE_GENERATION_CAS_SQL).bind(
    owner.epoch,c.sourceRevision,c.generation,c.manifestSha256,c.eligibilityValidUntilMs,
    FENCE_SCHEMA,QA_PRIMARY_ID,owner.version,owner.rehearsal,owner.epoch,
    prior.publication_revision,
    c.generation,QA_PRIMARY_ID,owner.version,owner.epoch,owner.rehearsal,
    c.sourceRevision,c.manifestSha256,c.catalogRows,c.allowRows,c.denyRows,
    c.eligibilityValidUntilMs,
  ).first<Row>();
  if(!validFence(updated,x,owner)||updated.dirty!==0||
    updated.owner_mutation_epoch!==owner.epoch||
    updated.source_revision!==c.sourceRevision||
    updated.active_generation!==c.generation||
    updated.manifest_sha256!==c.manifestSha256||
    updated.eligibility_valid_until_ms!==c.eligibilityValidUntilMs||
    updated.pending_withdrawals!==0||updated.pending_writes!==0||
    updated.publication_revision!==Number(prior.publication_revision)+1)
    blocked();
  const observed=await read(x);
  const again=await currentQaOwnerEpochForNegativePublication(x);
  const ended=now();
  if(!validFence(observed,x,owner)||observed.dirty!==0||
    observed.active_generation!==c.generation||
    observed.publication_revision!==updated.publication_revision||
    again.epoch!==owner.epoch||again.rehearsal!==owner.rehearsal||
    !validNumber(ended,started)||ended>=c.eligibilityValidUntilMs){
    // A new owner denial can win between D1 CAS and final owner challenge.
    // Invalidate this QA candidate eagerly; no serving path uses it anyway.
    try{await firstPrimary(x).prepare(QA_DIRTY_GENERATION_CAS_SQL)
      .bind(c.generation,updated.publication_revision).first();}catch{/* deny */}
    blocked();
  }
  // Deliberately NOT an authorization receipt: source-wide legal migration,
  // positive certificate issuer and production reader parity remain open.
  return {schema:FENCE_SCHEMA,generation:c.generation,ownerEpoch:owner.epoch,
    atomic:true,primaryCommitted:true,authorizing:false,productionReady:false};
}
