/* eslint-disable prettier/prettier -- QA-only negative publication boundary; one fixed CAS statement. */
/**
 * Isolated primary-D1 publication of a CURRENT owner-denial epoch, never a
 * grant. Does not import production permissions, cannot create a fence,
 * cannot clear dirty/pending state or extend legal eligibility.
 *
 * The fixed CAS operates on a separately enrolled, sealed QA D1 table. Its
 * actual SQL and triggers live ONLY in scripts/staging, never drizzle/.
 * Caller cannot supply SQL, an epoch, a database identity or an operation.
 */
import {
  QA_OWNER_PRIMARY_FENCE_SCHEMA,
  currentQaOwnerEpochForNegativePublication,
  type QaOwnerReadBracket,
} from "./current-owner-primary-read-bracket.stage";

const ROW_SQL =
  "SELECT publication_schema,primary_id,owner_journal_version,owner_mutation_epoch," +
  "owner_rehearsal_revision,dirty,pending_withdrawals,pending_writes," +
  "eligibility_valid_until_ms,publication_revision " +
  "FROM cove_qa_owner_primary_publication_fence WHERE slot=1";

/**
 * Must remain ONE D1 statement. A prior SELECT is a comparison witness only:
 * concurrent writers or generation changes must be refused by this WHERE.
 * No transaction held open across a Durable Object network call.
 */
export const QA_NEGATIVE_PRIMARY_CAS_SQL =
  "UPDATE cove_qa_owner_primary_publication_fence SET " +
  "owner_mutation_epoch=?,dirty=1,pending_withdrawals=pending_withdrawals+1," +
  "eligibility_valid_until_ms=0,publication_revision=publication_revision+1 " +
  "WHERE slot=1 AND publication_schema=? AND primary_id=? " +
  "AND owner_journal_version=? AND owner_rehearsal_revision=? " +
  "AND owner_mutation_epoch=? AND publication_revision=? " +
  "AND owner_mutation_epoch<? AND pending_withdrawals<9007199254740991 " +
  "AND publication_revision<9007199254740991 " +
  "RETURNING publication_schema,primary_id,owner_journal_version," +
  "owner_mutation_epoch,owner_rehearsal_revision,dirty,pending_withdrawals," +
  "pending_writes,eligibility_valid_until_ms,publication_revision";

type Statement={
  bind(...values:unknown[]):Statement;
  first<T=unknown>():Promise<T|null>;
};
type StagePrimary={withSession(mode:"first-primary"):{prepare(sql:string):Statement}};
export type QaNegativeOwnerPublisher=Omit<QaOwnerReadBracket,"primary">&{
  primary:StagePrimary;
};

type Row=Record<string,unknown>;
const deny=():never=>{throw Error("qa_owner_primary_negative_publication_denied");};
const epoch=(v:unknown)=>{
  if(!Number.isSafeInteger(v)||Number(v)<0)return deny();
  return Number(v);
};
function matchingRow(row:Row|null,context:QaNegativeOwnerPublisher,owner:{
  version:string;primaryId:string;rehearsal:"A"|"B";
}):row is Row{
  return Boolean(row&&
    row.publication_schema===QA_OWNER_PRIMARY_FENCE_SCHEMA&&
    row.primary_id===context.primaryId&&
    row.primary_id===owner.primaryId&&
    row.owner_journal_version===context.journalVersion&&
    row.owner_journal_version===owner.version&&
    row.owner_rehearsal_revision===owner.rehearsal&&
    Number.isSafeInteger(row.owner_mutation_epoch)&&
    Number(row.owner_mutation_epoch)>=0&&
    Number.isSafeInteger(row.publication_revision)&&
    Number(row.publication_revision)>=0&&
    Number.isSafeInteger(row.pending_withdrawals)&&
    Number(row.pending_withdrawals)>=0&&
    Number.isSafeInteger(row.pending_writes)&&
    Number(row.pending_writes)>=0&&
    (row.dirty===0||row.dirty===1)&&
    Number.isSafeInteger(row.eligibility_valid_until_ms)&&
    Number(row.eligibility_valid_until_ms)>=0);
}
function primary(context:QaNegativeOwnerPublisher) {
  const session=context.primary.withSession("first-primary");
  if(!session||typeof session.prepare!=="function")deny();
  return session;
}
const readPrimary=(context:QaNegativeOwnerPublisher)=>primary(context)
  .prepare(ROW_SQL).first<Row>();

/**
 * Return a nonauthorizing acknowledgement only after owner read, primary CAS,
 * fresh primary read and a SECOND independent current-owner challenge.
 *
 * A D1 outage leaves the original DO denial intact. A concurrent rollback,
 * changed rehearsal revision, or stale publisher cannot lower an epoch.
 * Even success leaves the D1 publication DIRTY, horizon=0, so *all* current
 * serving reads continue to deny until a SEPARATE certified positive owner
 * protocol reconciles the complete catalog and proves legal eligibility.
 */
export async function advanceQaPrimaryDenialEpoch(
  context:QaNegativeOwnerPublisher
):Promise<{schema:string;ownerEpoch:number;publicationRevision:number;
  ownerFirst:true;negativeOnly:true;authorizing:false;applied:boolean}>{
  // Source of truth is the current owner, never a caller-provided epoch.
  const owner=await currentQaOwnerEpochForNegativePublication(context);
  const prior=await readPrimary(context);
  if(!matchingRow(prior,context,owner))throw Error("qa_owner_primary_negative_publication_denied");
  const previousEpoch=epoch(prior.owner_mutation_epoch);
  const previousRevision=epoch(prior.publication_revision);
  const pending=epoch(prior.pending_withdrawals);
  if(owner.epoch<previousEpoch)deny();
  let applied=false;
  if(owner.epoch>previousEpoch){
    if(pending>=Number.MAX_SAFE_INTEGER||previousRevision>=Number.MAX_SAFE_INTEGER)deny();
    const updated=await primary(context).prepare(QA_NEGATIVE_PRIMARY_CAS_SQL).bind(
      owner.epoch,
      QA_OWNER_PRIMARY_FENCE_SCHEMA,
      context.primaryId,
      context.journalVersion,
      owner.rehearsal,
      previousEpoch,
      previousRevision,
      owner.epoch
    ).first<Row>();
    if(!matchingRow(updated,context,owner)||
       updated.owner_mutation_epoch!==owner.epoch||
       updated.publication_revision!==previousRevision+1||
       updated.pending_withdrawals!==pending+1||
       updated.pending_writes!==prior.pending_writes||
       updated.dirty!==1||updated.eligibility_valid_until_ms!==0)
      deny();
    applied=true;
  }else if(prior.dirty!==1||prior.eligibility_valid_until_ms!==0||
           pending<1)deny();

  // The CAS read receipt is not itself proof of a fresh primary generation.
  const latest=await readPrimary(context);
  if(!matchingRow(latest,context,owner)||
     latest.owner_mutation_epoch!==owner.epoch||latest.dirty!==1||
     epoch(latest.pending_withdrawals)<1||latest.eligibility_valid_until_ms!==0)
    deny();
  const again=await currentQaOwnerEpochForNegativePublication(context);
  if(again.epoch!==owner.epoch||again.version!==owner.version||
     again.primaryId!==owner.primaryId||again.rehearsal!==owner.rehearsal)
    deny();
  return {schema:"cove.qa.owner-negative-primary-publication.v1",
    ownerEpoch:owner.epoch,publicationRevision:epoch(latest.publication_revision),
    ownerFirst:true,negativeOnly:true,authorizing:false,applied};
}
