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

/** A private, short-leased QA owner handles negative partner commands only. */
export async function dispatchPrivatePartnerAction(db:object,
 action:"certify"|"issue-credential"|"revoke-credential"|"submit-feed"|"asset-expectations"|"upload-asset"|"assign-contract"|"reconcile-public-domain",
 payload:Record<string,unknown>):Promise<unknown> {
 const context=owners.get(db);
 if(!context)throw new ApiError(503,"Partner mutations require a privately bound owner.");
 try{
   const operationId="partner:"+crypto.randomUUID();
   const receipt=await dispatchCanonicalOwnerCommand(context.owner,context.secret,
     "publishing.partner-private-action",{operationId,action,payload});
   return receipt.result;
 }catch{throw new ApiError(503,"Private partner owner refused the command.");}
}

/** Publisher draft metadata may be edited only by a private QA owner. */
export async function dispatchPrivatePublishingEditor(db:object,
 action:"account-save"|"member-invite"|"identity-start"|"tax-submit"|"payout-submit"|"title-save"|"edition-save"|"asset-upload"|"accessibility-sign"|"edition-submit"|"revision-open"|"update-policy"|"owner-optin"|"review-submission",payload:Record<string,unknown>):Promise<unknown>{
 const context=owners.get(db);
 if(!context)throw new ApiError(503,"Publishing editor requires a private canonical owner.");
 try{
   const operationId="editor:"+crypto.randomUUID();
   const receipt=await dispatchCanonicalOwnerCommand(context.owner,context.secret,
     "publishing.editor-action",{action,payload,operationId});
   return receipt.result;
 }catch{throw new ApiError(503,"Private publishing editor owner refused this action.");}
}

/** QA-only copyright/trust command. No delegated SQL and no public fallback. */
export async function dispatchPrivateTrustAction(db:object,
 action:"sign-rights"|"upload-evidence"|"assess-content"|"submit-notice"|
 "validate-notice"|"submit-counter"|"validate-counter"|"court-action"|
 "resolve-dispute"|"repeat-policy"|"review-evidence",
 payload:Record<string,unknown>):Promise<unknown>{
 const context=owners.get(db);
 if(!context)throw new ApiError(503,"A private legal-trust owner is required.");
 try{
   const operationId="trust:"+crypto.randomUUID();
   const receipt=await dispatchCanonicalOwnerCommand(context.owner,context.secret,
     "trust.owner-action",{action,operationId,payload});
   return receipt.result;
 }catch{throw new ApiError(503,"Private legal-trust owner denied the command.");}
}

/** Fixed, non-SQL private preorder command. Both server and owner reject
 * nonleased production. Positive payment and release claims are forbidden. */
export async function dispatchPrivatePreorderAction(
 db:object,action:"ensure-plan"|"register-paid"|"update-lowest"|"customer-cancel"|
  "publisher-cancel"|"lease-refunds"|"complete-refund"|"advance",
 payload:Record<string,unknown>
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Typed private command family has heterogeneous validated receipts.
):Promise<any> {
 const context=owners.get(db);
 if(!context)throw new ApiError(503,"Preorder primary writer is not privately owned.");
 const operationId="preorder:"+crypto.randomUUID();
 try {
   const receipt=await dispatchCanonicalOwnerCommand(context.owner,context.secret,
     "preorder.owner-action",{action,payload,operationId});
   return receipt.result;
 }catch{
   throw new ApiError(503,"Private preorder owner refused this operation.");
 }
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

export async function dispatchFinanceOwnerAction(db:object,action:import("./finance-owner-routing.server").FinanceAction,
 args:unknown[],actor:import("./finance-owner-routing.server").FinanceActor){
 const context=owners.get(db);
 if(!context)throw new ApiError(503,"Financial mutations require the private financial owner.");
 if(args.length!==1)throw new ApiError(400,"Invalid financial command arguments.");
 const canonical=(x:unknown):string=>Array.isArray(x)?"["+x.map(canonical).join(",")+"]":
   x&&typeof x==="object"?"{"+Object.keys(x).sort().map(k=>JSON.stringify(k)+":"+canonical((x as Record<string,unknown>)[k])).join(",")+"}":JSON.stringify(x)??"null";
 const key=actor.operationId||canonical(args);
 const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(canonical([action,actor.userId,key])));
 const operationId="finance:"+Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,"0")).join("");
 const receipt=await dispatchCanonicalOwnerCommand(context.owner,context.secret,"finance.owner-action",
   {action,args,actorUserId:actor.userId,operationId});
 return receipt.result;
}

export async function dispatchAccountOwnerAction(db:object,command:
 {action:"register-device";userId:string;device:unknown}|
 {action:"revoke-device";userId:string;deviceId:string}|
 {action:"erasure-tick";limit:number}){
 const context=owners.get(db);
 if(!context)throw new ApiError(503,"Account permission mutations require the private account owner.");
 const receipt=await dispatchCanonicalOwnerCommand(context.owner,context.secret,"account.owner-action",command);
 return receipt.result;
}

export type RegionalEpubRepairResult={skipped:string;scanned?:never;repaired?:never;
 missingOrMismatched?:never;conflicts?:never;nextAfter?:never;maybeMore?:never}|{
 skipped?:never;scanned:number;repaired:number;missingOrMismatched:number;conflicts:number;
 nextAfter:string;maybeMore:boolean};
export async function dispatchRegionalEpubRepair(db:object,input:{after:string;limit:number}):Promise<RegionalEpubRepairResult>{
 const context=owners.get(db);
 if(!context)throw new ApiError(503,"Regional EPUB repair requires its private canonical owner.");
 const receipt=await dispatchCanonicalOwnerCommand(context.owner,context.secret,"catalog.repair-regional-assets",input);
 return receipt.result as RegionalEpubRepairResult;
}

/** A QA-only owner command; the original shared moderation writer is retired. */
export async function dispatchPrivateModerationAction(db:object,staffUserId:string,
  action:{caseId:string;actionType:string;reasonCode:string;rationale:string}) {
  const context=owners.get(db);
  if(!context)throw new ApiError(503,"Moderation actions require a private owner.");
  const input=JSON.stringify({staffUserId,action});
  const hash=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(input)));
  const operationId="moderation:"+Array.from(hash,x=>x.toString(16).padStart(2,"0")).join("");
  try {
    const receipt=await dispatchCanonicalOwnerCommand(context.owner,context.secret,
      "moderation.execute-action",{staffUserId,operationId,action});
    return receipt.result as {id:string;actionType:string};
  }catch{throw new ApiError(503,"Private moderation owner refused or did not acknowledge this action.");}
}


/** QA-only privately scoped rights-party metadata and negative territory rules. */
export async function dispatchPrivateRightsConfiguration(db:object,
 action:"upsert-party"|"upsert-territory-set",actorUserId:string,payload:unknown){
 const context=owners.get(db);
 if(!context)throw new ApiError(503,"Rights configuration requires private authority.");
 if(!payload||typeof payload!=="object"||Array.isArray(payload))
   throw new ApiError(400,"Invalid rights configuration payload.");
 const request={action,actorUserId,payload:payload as Record<string,unknown>};
 const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",
   new TextEncoder().encode(JSON.stringify(request))));
 const operationId="rights:"+Array.from(digest,b=>b.toString(16).padStart(2,"0")).join("");
 try {
  const receipt=await dispatchCanonicalOwnerCommand(context.owner,context.secret,
    "rights.private-configuration",{...request,operationId});
  return receipt.result;
 }catch{throw new ApiError(503,"Private rights configuration owner refused the request.");}
}

/** Staging-only regional withdrawal. The owner verifies the active ingest
 * lease and independently selects and denies stale catalog rows. */
export async function dispatchCatalogStaleWithdrawal(db:object,input:{
 sourceId:"pg_ca"|"pg_au"|"pg_eu";cycleStartedAt:string;leaseToken:string;runId:string
}):Promise<{staleCount:number}> {
 const context=owners.get(db);
 if(!context)throw new ApiError(503,"Stale catalog denial requires private owner.");
 try{
  const result=await dispatchCanonicalOwnerCommand(context.owner,context.secret,
   "catalog.withdraw-stale",input);
  return {staleCount:Number(result.staleCount)};
 }catch{throw new ApiError(503,"Private catalog owner refused the stale-source denial.");}
}

/** Fixed negative-only changes; never a caller-supplied SQL statement. */
export async function dispatchCatalogNegativeSource(db:object,
 action:"quarantine-regional"|"mark-us-retry",cacheId:string,reason="") {
 const context=owners.get(db);
 if(!context){
  // A corrupt but already authorized public-US EPUB may still be repaired
  // from the independently validated Gutenberg mirror in legacy local QA.
  // Skipping this retry *marker* performs no D1 write or positive grant;
  // regional rights quarantine must never be skipped.
  if(action==="mark-us-retry"&&/^[0-9]{1,10}$/.test(cacheId))
   return {changed:false};
  throw new ApiError(503,"Regional catalog quarantine requires private owner.");
 }
 try{
  const result=await dispatchCanonicalOwnerCommand(context.owner,context.secret,
   "catalog.negative-source",{action,cacheId,reason:reason.slice(0,500)});
  if(result.denied!==true)throw Error("catalog_negative_denial_missing");
  return {changed:result.changed===true};
 }catch{throw new ApiError(503,"Private catalog owner refused source quarantine.");}
}

/** A bounded regional-source ingest lease and checkpoint command.
 * Public callers cannot choose SQL or independently publish legal authority. */
export async function dispatchCatalogRegionalState(db:object,input:{
  action:"acquire"|"degraded"|"unchanged"|"same-snapshot"|"complete"|"failed";
  sourceId:"pg_ca"|"pg_au"|"pg_eu";leaseToken:string;runId:string;
  data:Record<string,unknown>
}):Promise<{acquired:boolean}> {
  const context=owners.get(db);
  if(!context)throw new ApiError(503,"Regional ingestion requires a private owner.");
  try{
    const ack=await dispatchCanonicalOwnerCommand(context.owner,context.secret,
      "catalog.regional-state",input);
    return {acquired:ack.acquired===true};
  }catch{throw new ApiError(503,"Private owner refused regional ingestion transition.");}
}
