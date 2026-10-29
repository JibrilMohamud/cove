/* eslint-disable prettier/prettier -- Security-sensitive, tightly scoped stage canonical commands. */
import {z} from "zod/v3";
import {ApiError} from "../features/fore/service";
import {dispatchCanonicalOwnerCommand} from "./canonical-owner-command-gateway";

/**
 * Actual Cove administrator -> authenticated, isolated owner-first writer.
 * This is intentionally NOT a generic SQL executor or a production switch.
 * The private writer requires its own independently leased QA DB and owner.
 */
export type StageCanonicalAdminEnv={
  COVE_SSR_STAGING?:string;
  COVE_CANONICAL_LEGAL_WRITE_LOCK?:string;
  COVE_LEGAL_QUARANTINE_WRITER_STAGE?:string;
  COVE_LEGAL_WRITER_PRIMARY_ID?:string;
  COVE_LEGAL_QUARANTINE_SECRET?:string;
  LEGAL_QUARANTINE_WRITER?:{fetch(request:Request):Promise<Response>};
};
const QA_DB_IDS=new Set([
  "5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
  "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
]);
const operationId=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
const productId=z.string().regex(/^prd_[a-zA-Z0-9_-]{3,120}$/).refine(
  id=>!id.startsWith("prd_gutenberg_"),"Commercial product only"
);
const subjectId=z.string().regex(/^[a-zA-Z0-9_-]{3,160}$/);
// Matches the private legal writer exactly. Numeric Gutenberg IDs and the
// three trusted regional import namespaces only; no arbitrary SQL subjects.
const sourceId=z.string().regex(/^(?:[0-9]{1,10}|(?:pgca|pgau|pgeu)_[a-z0-9_]{1,90})$/);
const evidenceId=z.string().regex(/^gre_[a-z0-9_:-]{1,120}$/);
const territory=z.string().regex(/^[A-Z]{2}$/);
const currency=z.string().regex(/^[A-Z]{3}$/);
const command=z.discriminatedUnion("action",[
  z.object({action:z.literal("suspend-grant"),targetId:subjectId,operationId}).strict(),
  // Deny-first source operations cannot be expressed as legacy admin writes.
  z.object({action:z.literal("quarantine-source"),sourceId,operationId,
    message:z.string().max(500)}).strict(),
  z.object({action:z.literal("revoke-source-evidence"),sourceId,evidenceId,
    territory,operationId}).strict(),
  z.object({action:z.literal("retract-sources"),operations:z.array(z.object({
    sourceId,operationId
  }).strict()).min(1).max(25).refine(rows=>
    new Set(rows.map(r=>r.sourceId)).size===rows.length,
    "Source IDs must be unique"
  )}).strict(),
  z.object({action:z.literal("suspend-contract"),targetId:subjectId,operationId}).strict(),
  z.object({action:z.literal("withdraw-retail"),productId,operationId}).strict(),
  z.object({action:z.literal("publish-retail"),productId,territory,currency,operationId}).strict(),
  z.object({action:z.literal("pause-market"),territory,operationId}).strict(),
  z.object({action:z.literal("revoke-entitlement"),entitlementId:z.string().regex(/^[a-zA-Z0-9_-]{8,160}$/),operationId}).strict(),
  // A terminal, negative-only distribution decision. Never accept an
  // owner_only/distributable edit or allowExistingOwners=true on this path.
  z.object({
    action:z.literal("withdraw-distribution"),
    publicationVersionId:subjectId,
    status:z.enum(["blocked","recalled"]),
    allowExistingOwners:z.literal(false),
    reasonCode:z.string().min(1).max(120),
    reasonDetail:z.string().max(2000),
    actorUserId:subjectId,operationId
  }).strict(),
]);
type OwnerAck={ [key:string]:unknown };
export async function executeStageCanonicalAdminCommand(
  env:StageCanonicalAdminEnv,input:unknown
) {
  // Never silently fall back to old raw D1 (including if only one QA
  // binding or environment flag is absent). The writer separately checks
  // its own 15-minute lease and exact independent D1 identity.
  if(env.COVE_SSR_STAGING!=="1"||
     env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1"||
     env.COVE_LEGAL_QUARANTINE_WRITER_STAGE!=="1"||
     !QA_DB_IDS.has(env.COVE_LEGAL_WRITER_PRIMARY_ID||"")||
     !/^[a-f0-9]{64}$/.test(env.COVE_LEGAL_QUARANTINE_SECRET||"")||
     !env.LEGAL_QUARANTINE_WRITER?.fetch)
    throw new ApiError(503,"Owner-first canonical writer is not configured for isolated staging.");
  const x=command.parse(input);
  let ack:OwnerAck;
  try{
    ack=await dispatchCanonicalOwnerCommand(
      env.LEGAL_QUARANTINE_WRITER,
      env.COVE_LEGAL_QUARANTINE_SECRET!,
      ("rights."+x.action) as Parameters<typeof dispatchCanonicalOwnerCommand>[2],
      x
    );
  }catch(error){
    if(error instanceof Error&&error.message==="canonical_command_receipt_mismatch")
      throw new ApiError(503,"Canonical legal owner write receipt does not match the request.");
    if(error instanceof Error&&
       ["canonical_command_receipt_invalid","canonical_command_receipt_too_large"].includes(error.message))
      throw new ApiError(503,"Canonical legal owner write receipt malformed.");
    throw new ApiError(503,"Canonical legal owner write was not acknowledged.");
  }
  if(!ack||typeof ack!=="object"||Array.isArray(ack))
    throw new ApiError(503,"Canonical legal owner write receipt malformed.");
  const valid=(()=>{
    switch(x.action){
      case "quarantine-source":
        return ack.quarantined===true && ack.sourceId===x.sourceId;
      case "revoke-source-evidence":
        return ack.evidenceRevoked===true && ack.sourceId===x.sourceId &&
          ack.evidenceId===x.evidenceId && ack.territory===x.territory;
      case "retract-sources":
        return ack.retracted===x.operations.length &&
          Array.isArray(ack.sourceIds) &&
          ack.sourceIds.length===x.operations.length &&
          ack.sourceIds.every((id:unknown,i:number)=>id===x.operations[i].sourceId);
      case "suspend-grant":
      case "suspend-contract":
        return ack.suspended===true && ack.ownerDenied===true &&
          ack.subject===(x.action==="suspend-grant"?"grant":"contract") &&
          ack.subjectId===x.targetId;
      case "withdraw-retail":
        return ack.withdrawn===true && Number.isSafeInteger(ack.ownerEpoch) &&
          Number(ack.ownerEpoch)>0;
      case "publish-retail":
        return ack.published===true && Number.isSafeInteger(ack.ownerEpoch) &&
          Number(ack.ownerEpoch)>0;
      case "pause-market":
        return ack.marketWithdrawn===true && ack.territory===x.territory;
      case "withdraw-distribution":
        return ack.withdrawn===true && ack.ownerDenied===true &&
          ack.publicationVersionId===x.publicationVersionId &&
          ack.status===x.status && Number.isSafeInteger(ack.ownerEpoch) &&
          Number(ack.ownerEpoch)>0;
      case "revoke-entitlement":
        return ack.revoked===true && Number.isSafeInteger(ack.epoch) &&
          Number(ack.epoch)>0;
    }
  })();
  if(!valid)
    throw new ApiError(503,"Canonical legal owner write receipt does not match the request.");
  return {action:x.action,ownerFirst:true,receipt:ack};
}

/**
 * Explicit market PAUSE only. The legacy market editor accepts positive
 * activations and arbitrary metadata; those cannot be represented by a
 * withdrawal receipt. Never accept or ignore extra edit fields.
 * Authenticated localization.manage callers enter the same private
 * strongly consistent denial command used by commerce administrators.
 */
export async function executeStageMarketEditorPause(
  env:StageCanonicalAdminEnv,input:unknown
){
  const x=z.object({
    ownerAction:z.literal("pause"),
    countryCode:territory,
    operationId,
  }).strict().parse(input);
  return executeStageCanonicalAdminCommand(env,{
    action:"pause-market",territory:x.countryCode,operationId:x.operationId,
  });
}

/**
 * Existing rights-editor POST endpoints may opt into the owner-first
 * *negative-only* transition with an explicit, minimal command. Never accept
 * a mixed edit+withdraw request: an uncommitted metadata edit cannot be
 * represented as a durable owner-approved grant or contract revision.
 * Active/new positive edits remain blocked by the staged DB write lock.
 */
export async function executeStageRightsEditorSuspension(
  env:StageCanonicalAdminEnv,kind:"grant"|"contract",input:unknown
){
  const x=z.object({
    ownerAction:z.literal("suspend"),
    id:subjectId,
    status:z.literal("suspended"),
    operationId,
  }).strict().parse(input);
  return executeStageCanonicalAdminCommand(env,{
    action:kind==="grant"?"suspend-grant":"suspend-contract",
    targetId:x.id,operationId:x.operationId,
  });
}
