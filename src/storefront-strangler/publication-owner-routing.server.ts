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
