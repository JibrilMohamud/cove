/* eslint-disable prettier/prettier -- Isolated owner-issued positive receipt: strict fixed schema and fresh D1 reads. */
/**
 * QA-ONLY independently issued positive owner certificate.
 *
 * This is real code called from CoveLegalAuthority, not a mock issuer. It
 * verifies every member of a *small, virgin synthetic QA corpus* using the
 * owner's current durable legal SQL, the enrolled SQL mutation journal, and
 * independently read primary-D1 candidate/source/right views. It is not a
 * historical migration for the 82,247-book PRODUCTION catalog. The upper
 * bound of 16, explicit QA binding, explicit opt-in and owner short lease
 * make production-positive publication impossible through this adapter.
 *
 * No evidence is accepted in a client request except a fresh challenge.
 * These compact QA checks are insufficient for production contract/version,
 * language, territorial or full legal source provenance. Full real-catalog
 * resolver parity and owner writer exclusivity remain independent gates.
 */
import {
  readAuthority,readAuthorizedPresentations,
  type AuthoritySql,
} from "./legal-authority-core";
import {marketIsWithdrawn} from "./market-authority-core";
import {readOwnerSqlMutationJournal} from "./owner-sql-mutation-journal";

export const QA_POSITIVE_CERTIFICATE_PATH="/qa/positive-generation-certificate";
export const QA_POSITIVE_CERTIFICATE_SCHEMA="cove.qa.owner-reconciled-positive-certificate.v1";
export const QA_POSITIVE_MANIFEST_SCHEMA="cove.qa.owner-candidate-manifest.v1";
const QA_ID="7c7ab994-f6b3-419d-a72d-71eb9ea22e7e";
const QA_LIMIT=16,MAX_QA_LEASE=25_000;
const productRE=/^prd_gutenberg_(?:[0-9]{1,10}|(?:pgca|pgau|pgeu)_[a-z0-9_]{1,90})$/;
const digestRE=/^[a-f0-9]{64}$/;
type Row=Record<string,unknown>;
type DBStatement={
  bind(...values:unknown[]):DBStatement;
  first<T=Row>():Promise<T|null>;
  all<T=Row>():Promise<{results:T[]}>;
};
export type QAOwnerPrimaryDB={
  withSession(mode:"first-primary"):{prepare(sql:string):DBStatement};
};
type Journal=ReturnType<typeof readOwnerSqlMutationJournal>;
type ReconcileContext={
  ownerSql:AuthoritySql;
  transactionSync:<T>(f:()=>T)=>T;
  primary:QAOwnerPrimaryDB;
  primaryId:string;
  journalVersion:string;
  rehearsalRevision:string|undefined;
  challenge:unknown;
  nowMs?:()=>number;
};
export type CandidateRow={
  generation:number;productId:string;territory:"US";allowed:0|1;proofSha256:string;
};
type Candidate={
  generation:number;primary_id:string;owner_journal_version:string;
  owner_epoch:number;owner_rehearsal_revision:"A"|"B";
  source_revision:number;manifest_sha256:string;territory:"US";
  catalog_rows:number;allow_rows:number;deny_rows:number;
  eligibility_valid_until_ms:number;sealed:1;dirty:0;
};
const fail=():never=>{throw Error("qa_owner_positive_certificate_not_reconciled");};
const integer=(v:unknown,min=0):v is number=>
  typeof v==="number"&&Number.isSafeInteger(v)&&v>=min;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function normalizeCandidate(raw:Row|null):Candidate{
  if(!raw||!integer(raw.generation,1)||raw.primary_id!==QA_ID||
    typeof raw.owner_journal_version!=="string"||
    !digestRE.test(raw.owner_journal_version)||
    !integer(raw.owner_epoch,1)||
    (raw.owner_rehearsal_revision!=="A"&&raw.owner_rehearsal_revision!=="B")||
    !integer(raw.source_revision,1)||typeof raw.manifest_sha256!=="string"||
    !digestRE.test(raw.manifest_sha256)||raw.territory!=="US"||
    !integer(raw.catalog_rows,1)||raw.catalog_rows>QA_LIMIT||
    !integer(raw.allow_rows)||!integer(raw.deny_rows)||
    raw.catalog_rows!==Number(raw.allow_rows)+Number(raw.deny_rows)||
    !integer(raw.eligibility_valid_until_ms,1)||
    raw.sealed!==1||raw.dirty!==0)fail();
  return raw as Candidate;
}
function normalizedRows(raw:Row[]):CandidateRow[]{
  if(!Array.isArray(raw)||raw.length===0||raw.length>QA_LIMIT)fail();
  const rows=raw.map((r):CandidateRow=>{
    if(!integer(r.generation,1)||!productRE.test(String(r.product_id))||
      r.territory!=="US"||(r.allowed!==0&&r.allowed!==1)||
      typeof r.proof_sha256!=="string"||!digestRE.test(r.proof_sha256))
      fail();
    return {generation:r.generation as number,productId:r.product_id as string,
      territory:"US",allowed:r.allowed,proofSha256:r.proof_sha256 as string};
  });
  if(rows.some((r,i)=>i>0&&rows[i-1].productId>=r.productId))fail();
  return rows;
}
export async function qaPositiveCandidateDigest(
  candidate:{
    generation:number;primaryId:string;journalVersion:string;ownerEpoch:number;
    rehearsalRevision:string;sourceRevision:number;territory:string;
    catalogRows:number;allowRows:number;denyRows:number;
  },rows:CandidateRow[]
):Promise<string>{
  const data=JSON.stringify({schema:QA_POSITIVE_MANIFEST_SCHEMA,candidate,rows});
  const bytes=new TextEncoder().encode(data);
  const digest=await crypto.subtle.digest("SHA-256",bytes);
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
}
function shape(c:Candidate){
  return {generation:c.generation,primaryId:c.primary_id,
    journalVersion:c.owner_journal_version,ownerEpoch:c.owner_epoch,
    rehearsalRevision:c.owner_rehearsal_revision,sourceRevision:c.source_revision,
    territory:c.territory,catalogRows:c.catalog_rows,allowRows:c.allow_rows,
    denyRows:c.deny_rows};
}
function primary(x:ReconcileContext){
  const db=x.primary.withSession("first-primary");
  if(!db||typeof db.prepare!=="function")fail();
  return db;
}
async function one(x:ReconcileContext,sql:string,values:unknown[]=[]):Promise<Row|null>{
  const stmt=primary(x).prepare(sql);
  if(!stmt||typeof stmt.bind!=="function")fail();
  return stmt.bind(...values).first<Row>();
}
async function many(x:ReconcileContext,sql:string,values:unknown[]=[]):Promise<Row[]>{
  const stmt=primary(x).prepare(sql);
  if(!stmt||typeof stmt.bind!=="function")fail();
  const response=await stmt.bind(...values).all<Row>();
  if(!response||!Array.isArray(response.results)||response.results.length>QA_LIMIT+1)
    fail();
  return response.results;
}
const CANDIDATE_SQL=`SELECT generation,primary_id,owner_journal_version,owner_epoch,
  owner_rehearsal_revision,source_revision,manifest_sha256,territory,
  catalog_rows,allow_rows,deny_rows,eligibility_valid_until_ms,sealed,dirty
 FROM cove_qa_owner_positive_candidate ORDER BY generation DESC LIMIT 1`;
const ROWS_SQL=`SELECT generation,product_id,territory,allowed,proof_sha256
 FROM cove_qa_owner_positive_candidate_products WHERE generation=?
 ORDER BY product_id LIMIT 17`;
const SOURCE_SQL=`SELECT revision,dirty FROM cove_qa_owner_positive_source_revision WHERE slot=1`;
const CATALOG_SQL=`SELECT id FROM products WHERE storefront_status='active' ORDER BY id LIMIT 17`;
const LEGAL_SQL=`SELECT product_id FROM retail_product_availability_rows
 WHERE territory_code='US' ORDER BY product_id LIMIT 17`;
function checkedEpoch(x:ReconcileContext):Journal{
  return readOwnerSqlMutationJournal(x.ownerSql,x.transactionSync,x.journalVersion);
}
function verifyOwner(x:ReconcileContext,c:Candidate,rows:CandidateRow[]){
  return x.transactionSync(()=>{
    if(marketIsWithdrawn(x.ownerSql,"US"))fail();
    const allowed=rows.filter(r=>r.allowed===1);
    const authorized=readAuthorizedPresentations(x.ownerSql,
      allowed.map(r=>r.productId),"US","USD");
    if(authorized.length!==allowed.length)fail();
    const indexed=new Map(authorized.map(row=>[row.product_id,row]));
    for(const row of rows){
      const sourceId=row.productId.slice("prd_gutenberg_".length);
      const verdict=readAuthority(x.ownerSql,sourceId,"US");
      if(!integer(verdict.revision,1)||verdict.allowed!==(row.allowed===1))fail();
      if(row.allowed===1){
        const proof=indexed.get(row.productId);
        if(!proof||proof.edition_id!=="ed_gutenberg_"+sourceId)fail();
        let offer:unknown;
        try{offer=JSON.parse(proof.offer_json);}catch{fail();}
        if(!offer||typeof offer!=="object"||Array.isArray(offer)||
          Object.keys(offer).sort().join(",")!=="amountMinor,currency,type"||
          (offer as Row).type!=="public-domain"||
          (offer as Row).currency!=="USD"||
          (offer as Row).amountMinor!==0)fail();
      }else{
        // An uninitialized owner is NOT a legal DENY archive. Demand an
        // acknowledged, journaled negative operation for this exact source.
        const history=x.ownerSql.exec<{one:number}>(
          "SELECT 1 one FROM cove_legal_denial_operations "+
          "WHERE source_id=? AND territory IN ('US','*') AND revision<=? LIMIT 1",
          sourceId,verdict.revision
        ).toArray();
        if(history.length!==1)fail();
      }
    }
    return true;
  });
}
export async function issueQaOwnerPositiveGenerationCertificate(x:ReconcileContext){
  if(!x||x.primaryId!==QA_ID||!digestRE.test(x.journalVersion||"")||
    (x.rehearsalRevision!=="A"&&x.rehearsalRevision!=="B")||
    typeof x.challenge!=="string"||!/^[a-f0-9]{32}$/.test(x.challenge)||
    typeof x.primary?.withSession!=="function"||
    typeof x.ownerSql?.exec!=="function"||
    typeof x.transactionSync!=="function")fail();
  const now=(x.nowMs||Date.now)();
  if(!integer(now,1))fail();
  const initial=checkedEpoch(x);
  if(!integer(Number(initial.mutationEpoch),1)||String(Number(initial.mutationEpoch))!==
    initial.mutationEpoch)fail();
  const [firstSource,rawCandidate]=await Promise.all([
    one(x,SOURCE_SQL),one(x,CANDIDATE_SQL)
  ]);
  const c=normalizeCandidate(rawCandidate);
  if(!firstSource||firstSource.revision!==c.source_revision||
    firstSource.dirty!==0||initial.journalVersion!==c.owner_journal_version||
    initial.mutationEpoch!==String(c.owner_epoch)||
    c.owner_rehearsal_revision!==x.rehearsalRevision||
    c.eligibility_valid_until_ms<=now)fail();
  const [rawRows,catalog,available]=await Promise.all([
    many(x,ROWS_SQL,[c.generation]),
    many(x,CATALOG_SQL),
    many(x,LEGAL_SQL),
  ]);
  const rows=normalizedRows(rawRows);
  if(rows.length!==c.catalog_rows||catalog.length!==rows.length||
    available.length!==c.allow_rows||
    rows.some(r=>r.generation!==c.generation)||
    catalog.some((r,i)=>r.id!==rows[i].productId))fail();
  const allow=rows.filter(r=>r.allowed===1).map(r=>r.productId);
  if(available.some((r,i)=>r.product_id!==allow[i]))fail();
  const hash=await qaPositiveCandidateDigest(shape(c),rows);
  if(hash!==c.manifest_sha256)fail();
  verifyOwner(x,c,rows);
  const [latestSource,latestCandidate]=await Promise.all([
    one(x,SOURCE_SQL),one(x,CANDIDATE_SQL)
  ]);
  const latest=normalizeCandidate(latestCandidate);
  if(!same(latest,c)||!same(firstSource,latestSource))fail();
  const final=checkedEpoch(x);
  const ended=(x.nowMs||Date.now)();
  if(initial.mutationEpoch!==final.mutationEpoch||
    initial.journalVersion!==final.journalVersion||
    !integer(ended,now)||ended>=c.eligibility_valid_until_ms)fail();
  const until=Math.min(c.eligibility_valid_until_ms,ended+MAX_QA_LEASE);
  if(until<=ended||until>ended+MAX_QA_LEASE)fail();
  return {
    schema:QA_POSITIVE_CERTIFICATE_SCHEMA,
    authorizing:true as const,challenge:x.challenge,primaryId:QA_ID,
    journalVersion:initial.journalVersion,
    rehearsalRevision:c.owner_rehearsal_revision,
    mutationEpoch:initial.mutationEpoch,
    generation:c.generation,sourceRevision:c.source_revision,
    manifestSha256:hash,territory:"US" as const,
    catalogRows:c.catalog_rows,allowRows:c.allow_rows,denyRows:c.deny_rows,
    completeHistoricalWithdrawals:true as const,
    completeCatalog:true as const,
    eligibilityValidUntilMs:until,
  };
}
