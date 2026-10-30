/* eslint-disable prettier/prettier -- QA-only owner-first contract versions, no direct-D1 fallback. */
import type {CoveEnv} from "../features/fore/api.server";
import type {CatalogDB} from "../features/fore/catalog-model.server";
import {saveContractVersion} from "../features/fore/traditional-publishing.server";
import {ApiError} from "../features/fore/service";
import {dispatchCanonicalOwnerCommand} from "./canonical-owner-command-gateway";
import {ownerContractVersionSchema} from "./owner-contract-version-schema";
const QA_PRIMARIES=new Set([
  "5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
  "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e"
]);
export async function saveStageOwnerContractVersion(env:CoveEnv,db:CatalogDB,actorUserId:string,raw:unknown){
  if(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED!=="1")
    return saveContractVersion(db,actorUserId,raw);
  if(env.COVE_SSR_STAGING!=="1"||
     env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1"||
     !QA_PRIMARIES.has(env.COVE_LEGAL_WRITER_PRIMARY_ID||"")||
     !/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET||"")||
     !env.LEGAL_AUTHORITY?.getByName)
    throw new ApiError(503,"Distribution contract owner is not certified.");
  const parsed=ownerContractVersionSchema.safeParse(raw);
  if(!parsed.success)throw new ApiError(400,"Invalid distribution contract.");
  const contract=parsed.data;
  const fingerprint=new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(JSON.stringify([actorUserId,contract]))));
  const operationId="contract:"+[...fingerprint].map(b=>b.toString(16).padStart(2,"0")).join("");
  try{
    const ack=await dispatchCanonicalOwnerCommand(
      env.LEGAL_AUTHORITY.getByName("cove-staged-legal-global-v1"),
      env.COVE_RIGHTS_OWNER_SECRET!,"publishing.save-contract-version",
      {actorUserId,operationId,contract});
    return {id:ack.id,contractId:ack.contractId,versionNumber:ack.versionNumber,status:ack.status};
  }catch{
    // Never fall back to direct canonical D1 after ambiguous owner failure.
    throw new ApiError(503,"Distribution contract version was not acknowledged by its canonical owner.");
  }
}
