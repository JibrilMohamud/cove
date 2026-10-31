/* eslint-disable prettier/prettier -- A typed publication command, never a delegated SQL executor. */
import {ApiError} from "../features/fore/service";
import {dispatchCanonicalOwnerCommand} from "./canonical-owner-command-gateway";
import type {CatalogDB} from "../features/fore/catalog-model.server";
type OwnerPort={fetch(request:Request):Promise<Response>};
type Context={owner:OwnerPort;secret:string;territory:string;currency:string};
const owners=new WeakMap<object,Context>();
export type PublicationActivation={publicationVersionId:string;actorUserId:string|null;
  triggerType:"schedule"|"rollback"|"staff"};

export function bindPublicationOwner<T extends CatalogDB>(db:T,context:Context):T {
  if(!/^[a-f0-9]{64}$/.test(context.secret)||!/^[A-Z]{2}$/.test(context.territory)||
    !/^[A-Z]{3}$/.test(context.currency)||!context.owner?.fetch)
    throw Error("invalid_publication_owner_binding");
  // Do not mutate or globally brand the underlying D1 handle. The owner
  // itself receives its independently bound raw PRIMARY_DB, without this
  // caller facade, so it cannot recursively dispatch back into itself.
  const facade=new Proxy(db,{get(target,key){
    if(key==="withSession") {
      const open=Reflect.get(target,key,target);
      if(typeof open!=="function")return undefined;
      return (...args:unknown[])=>bindPublicationOwner(open.apply(target,args),context);
    }
    const value=Reflect.get(target,key,target);
    return typeof value==="function"?value.bind(target):value;
  }});
  owners.set(facade,context);return facade;
}
export function hasPublicationOwner(db:object){return owners.has(db);}
export async function dispatchPublicationRecovery(db:object) {
  const context=owners.get(db);
  if(!context)throw new ApiError(503,"Publication owner is not configured.");
  const operationId="publication-recovery:"+crypto.randomUUID();
  try {
    const result=await dispatchCanonicalOwnerCommand(
      context.owner,context.secret,"publication.recover",{operationId}
    ) as {schema?:unknown;ownerFirst?:unknown;operationId?:unknown;
      checked?:unknown;recovered?:unknown;blocked?:unknown}|null;
    if(!result||result.schema!=="cove.publication-recovery.v1"||result.ownerFirst!==true||
      result.operationId!==operationId||[result.checked,result.recovered,result.blocked]
        .some(n=>!Number.isSafeInteger(n)||Number(n)<0||Number(n)>25)||
      Number(result.recovered)+Number(result.blocked)!==result.checked)
      throw Error("publication_recovery_receipt_mismatch");
    return {checked:Number(result.checked),recovered:Number(result.recovered),blocked:Number(result.blocked)};
  } catch {throw new ApiError(503,"Publication recovery owner did not acknowledge completion.");}
}
export function scopePublicationOwnerEnv<T extends {
  DB:CatalogDB;COVE_PUBLICATION_COMMANDS_ENABLED?:string;COVE_SSR_STAGING?:string;
  COVE_LEGAL_WRITER_PRIMARY_ID?:string;COVE_RIGHTS_OWNER_SECRET?:string;
  COVE_PUBLICATION_COMMAND_TERRITORY?:string;COVE_PUBLICATION_COMMAND_CURRENCY?:string;
  LEGAL_AUTHORITY?:{getByName(name:string):OwnerPort};
}>(env:T):T {
  if(env.COVE_PUBLICATION_COMMANDS_ENABLED!=="1")return env;
  // The implementation is compiled for the production migration, but an
  // isolated caller cannot enroll production through a feature toggle. The
  // production owner stays locked until the remaining writer paths close.
  if(env.COVE_SSR_STAGING!=="1"||
    !["5e3a6b69-6f3d-4b19-b837-01f7aa56ce87","7c7ab994-f6b3-419d-a72d-71eb9ea22e7e"]
      .includes(env.COVE_LEGAL_WRITER_PRIMARY_ID||"")||
    !env.LEGAL_AUTHORITY?.getByName||!/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET||""))
    throw Error("publication_owner_cutover_not_certified");
  return {...env,DB:bindPublicationOwner(env.DB,{
    owner:env.LEGAL_AUTHORITY.getByName("cove-staged-legal-global-v1"),
    secret:env.COVE_RIGHTS_OWNER_SECRET!,territory:env.COVE_PUBLICATION_COMMAND_TERRITORY||"",
    currency:env.COVE_PUBLICATION_COMMAND_CURRENCY||""
  })};
}
export async function dispatchPublicationActivation(db:object,command:PublicationActivation) {
  const context=owners.get(db);
  if(!context)throw new ApiError(503,"Publication owner is not configured.");
  const operationId="activation:"+crypto.randomUUID();
  let receipt:unknown;
  try{
    receipt=await dispatchCanonicalOwnerCommand(context.owner,context.secret,
      "publication.activate",{...command,operationId,territory:context.territory,currency:context.currency});
  }catch{throw new ApiError(503,"Publication activation owner did not acknowledge completion.");}
  const result=receipt as {schema?:unknown;operationId?:unknown;publicationVersionId?:unknown;
    ownerFirst?:unknown;state?:unknown;versionNumber?:unknown}|null;
  if(!result||result.schema!=="cove.publication-activation.v1"||result.operationId!==operationId||
    result.publicationVersionId!==command.publicationVersionId||result.ownerFirst!==true||
    !["live","updated"].includes(String(result.state))||
    !Number.isSafeInteger(result.versionNumber)||Number(result.versionNumber)<1)
    throw new ApiError(503,"Publication owner receipt does not match this activation.");
  return {publicationVersionId:command.publicationVersionId,
    state:String(result.state),versionNumber:Number(result.versionNumber)};
}

export async function dispatchPublicationPreorder(db:object,command:{publicationVersionId:string}) {
  const context=owners.get(db);
  if(!context)throw new ApiError(503,"Publication owner is not configured.");
  const operationId="preorder:"+crypto.randomUUID();
  let receipt:unknown;
  try{
    receipt=await dispatchCanonicalOwnerCommand(context.owner,context.secret,
      "publication.open-preorder",{...command,operationId,territory:context.territory,currency:context.currency});
  }catch{throw new ApiError(503,"Preorder publication owner did not acknowledge completion.");}
  const result=receipt as {schema?:unknown;operationId?:unknown;publicationVersionId?:unknown;
    ownerFirst?:unknown;state?:unknown;versionNumber?:unknown}|null;
  if(!result||result.schema!=="cove.publication-preorder.v1"||result.operationId!==operationId||
    result.publicationVersionId!==command.publicationVersionId||result.ownerFirst!==true||
    result.state!=="preorder"||!Number.isSafeInteger(result.versionNumber)||Number(result.versionNumber)<1)
    throw new ApiError(503,"Publication owner receipt does not match this preorder.");
  return {publicationVersionId:command.publicationVersionId,state:"preorder",versionNumber:Number(result.versionNumber)};
}

export async function dispatchPublicationMaterialization(db:object,command:{submissionId:string;reviewerUserId:string}) {
  const context=owners.get(db);
  if(!context)throw new ApiError(503,"Publication owner is not configured.");
  const operationId="materialize:"+crypto.randomUUID();
  try {
    const receipt=await dispatchCanonicalOwnerCommand(context.owner,context.secret,
      "publication.materialize",{...command,operationId,territory:context.territory,currency:context.currency});
    // Canonical fields preserve the original materializer's result contract.
    // The caller cannot supply a product or substitute an owner's identities.
    return {id:receipt.publicationId,submission_id:command.submissionId,
      product_id:receipt.productId,edition_id:receipt.editionId,work_id:receipt.workId,
      publicationVersionId:receipt.publicationVersionId,versionNumber:receipt.versionNumber,
      releaseState:receipt.releaseState,ownerUpdatePolicy:receipt.ownerUpdatePolicy};
  } catch {throw new ApiError(503,"Publication materialization owner did not acknowledge completion.");}
}

/** Owner-bound job only; callers cannot provide SQL, a feed ID or a positive grant. */
export async function dispatchPartnerFeedProcessing(db:object,limit=25) {
  const context=owners.get(db);
  if(!context)throw new ApiError(503,"Partner feed application requires its private owner.");
  if(!Number.isSafeInteger(limit)||limit<1||limit>25)
    throw new ApiError(400,"Invalid partner feed batch limit.");
  const operationId="partner-preview:"+crypto.randomUUID();
  try {
    const receipt=await dispatchCanonicalOwnerCommand(context.owner,context.secret,
      "partner.process-feed",{limit,operationId});
    return {leased:Number(receipt.leased),applied:Number(receipt.applied),
      failed:Number(receipt.failed),sandbox:Number(receipt.sandbox)};
  }catch {throw new ApiError(503,"Partner feed owner did not acknowledge completion.");}
}

/** No D1 SQL, grant or product can be selected by a public catalog caller.
 * The owner independently verifies original source rows on isolated QA D1. */
export async function dispatchCatalogFreeNormalization(db:object,sourceId:string,_at:string) {
  const context=owners.get(db);
  if(!context)throw new ApiError(503,"Catalog normalization requires private authority.");
  if(!/^(?:[0-9]{1,10}|(?:pgca|pgau|pgeu)_[a-z0-9_]{1,90})$/.test(sourceId))
    throw new ApiError(400,"Invalid Gutenberg source identifier.");
  const operationId="catalog-free:"+crypto.randomUUID();
  try {
    return await dispatchCanonicalOwnerCommand(context.owner,context.secret,
      "catalog.normalize-gutenberg",{sourceId,operationId});
  }catch{throw new ApiError(503,"Private catalog owner did not accept verified source proof.");}
}

/** Private user imports stay strictly scoped to the staged owner.
 * Owner independently checks the exact R2 object and import ownership. */
export async function dispatchCatalogPersonalImport(db:object,input:{
  id:string;userId:string;title:string;author:string;language:string;
  objectKey:string;createdAt:string;
}) {
  const context=owners.get(db);
  if(!context)throw new ApiError(503,"Personal imports require private catalog authority.");
  const operationId="catalog-personal:"+crypto.randomUUID();
  try {
    return await dispatchCanonicalOwnerCommand(context.owner,context.secret,
      "catalog.personal-import",{...input,operationId});
  }catch{throw new ApiError(503,"Private catalog owner did not accept personal import.");}
}

/** An owner-only support action; every staff permission and case scope is
 * independently rechecked at the primary owner. Production remains locked. */
export async function dispatchSupportOwnerAction(db:object,staffUserId:string,action:{
  caseId:string;actionType:string;targetId:string;reasonCode:string;
  rationale:string;idempotencyKey:string;amountMinor?:number
}) {
  const context=owners.get(db);
  if(!context)throw new ApiError(503,"Support operations require a private canonical owner.");
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(action.idempotencyKey));
  const operationId="support:"+Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,"0")).join("");
  try {
    const ack=await dispatchCanonicalOwnerCommand(context.owner,context.secret,
      "support.execute-action",{staffUserId,operationId,action});
    return ack.result;
  }catch{throw new ApiError(503,"Private support owner did not acknowledge this operation.");}
}

/** This operation is intentionally NEGATIVE-only until external provider
 * evidence and an owner-controlled positive verification path are certified. */
export async function dispatchPublishingOnboardingReview(db:object,command:{
  reviewerUserId:string;accountId:string;kind:"identity"|"tax"|"payout";
  recordId:string;status:"verified"|"failed"|"expired"|"manual_review"|"restricted";
  reasonCode:string;withholdingBps?:number;requirementsDue?:string[];
}) {
  const context=owners.get(db);
  if(!context)throw new ApiError(503,"Publishing onboarding requires a private owner.");
  const operationId="onboarding:"+crypto.randomUUID();
  try {
    const ack=await dispatchCanonicalOwnerCommand(context.owner,context.secret,
      "publishing.review-onboarding",{...command,operationId});
    return {saved:true,applied:ack.applied===true};
  }catch {throw new ApiError(503,"Publishing onboarding owner refused unverified decision.");}
}

/** Publisher actor is derived from authenticated API identity and rechecked
 * against the current owner-side publishing membership, edition, and evidence. */
export async function dispatchCommercialAudioMetadata(db:object,
  action:"profile"|"narrators"|"agreement-add"|"agreement-end",userId:string,payload:unknown){
  const context=owners.get(db);
  if(!context)throw new ApiError(503,"Commercial audiobook edits require a private publisher owner.");
  const operationId="audiometa:"+crypto.randomUUID();
  try{
    const ack=await dispatchCanonicalOwnerCommand(context.owner,context.secret,
      "publishing.audio-metadata",{action,userId,payload,operationId});
    return ack.result as Record<string,unknown>;
  }catch {throw new ApiError(503,"The private owner did not certify this audiobook metadata change.");}
}

export async function dispatchPublishingOwnerValidationJob(
  db:object,action:"lease-validation"|"complete-validation"|"lease-rights-scan"|"complete-rights-scan",
  payload:unknown) {
  const context=owners.get(db);
  if(!context)throw new ApiError(503,"Publishing validation requires its private owner.");
  try {
    const receipt=await dispatchCanonicalOwnerCommand(context.owner,context.secret,
      "publishing.worker-jobs",{action,payload,operationId:"publishing-jobs:"+crypto.randomUUID()});
    return receipt.result as Record<string,unknown>;
  }catch{throw new ApiError(503,"Private publishing worker did not certify this job.");}
}

export async function dispatchCommercialAudioQcJob(db:object,action:"lease"|"complete",payload:unknown) {
  const context=owners.get(db);
  if(!context)throw new ApiError(503,"Commercial audiobook QC requires its private owner.");
  try {
    const receipt=await dispatchCanonicalOwnerCommand(context.owner,context.secret,
      "publishing.audio-qc-jobs",{action,payload,operationId:"audio-qc:"+crypto.randomUUID()});
    return receipt.result as Record<string,unknown>;
  }catch{throw new ApiError(503,"Private audio owner did not certify this QC job.");}
}

export async function dispatchCommercialAudioUploadMetadata(db:object,payload:{
  userId:string;editionId:string;kind:"chapter"|"preview";title:string;position:number;
  durationMs:number;sampleRateHz:number;bitrateKbps:number|null;bitrateMode:string;
  channels:number;rms:number|null;peak:number|null;noise:number|null;filename:string;
  mime:"audio/mpeg"|"audio/mp4";length:number;sha:string;fileId:string;key:string;
}) {
  const context=owners.get(db);
  if(!context)throw new ApiError(503,"Commercial audio uploads require the private owner.");
  try {
    const receipt=await dispatchCanonicalOwnerCommand(context.owner,context.secret,
      "publishing.audio-register-upload",{...payload,operationId:"audio-upload:"+payload.fileId});
    return receipt.result as Record<string,unknown>;
  }catch{throw new ApiError(503,"Private owner did not verify the stored audio upload.");}
}
