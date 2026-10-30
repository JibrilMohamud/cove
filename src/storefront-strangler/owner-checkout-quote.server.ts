/* eslint-disable prettier/prettier -- QA owner independently prices and persists quotes; no caller D1 fallback. */
import type {CoveEnv} from "../features/fore/api.server";
import {ApiError} from "../features/fore/service";
import {dispatchCanonicalOwnerCommand} from "./canonical-owner-command-gateway";

const QA_IDS=new Set(["5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
  "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e"]);
export async function createStageOwnerCheckoutQuote(
  env:CoveEnv,user:{id:string},request:unknown
):Promise<Record<string,unknown>>{
  if(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED!=="1"||
     env.COVE_SSR_STAGING!=="1"||
     env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1"||
     !QA_IDS.has(env.COVE_LEGAL_WRITER_PRIMARY_ID||"")||
     !/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET||"")||
     !env.LEGAL_AUTHORITY?.getByName)
    throw new ApiError(503,"Canonical checkout quote owner is unavailable.");
  try{
    const ack=await dispatchCanonicalOwnerCommand(
      env.LEGAL_AUTHORITY.getByName("cove-staged-legal-global-v1"),
      env.COVE_RIGHTS_OWNER_SECRET!,"commerce.create-quote",{userId:user.id,request});
    const {schema:_,userId:__,persisted:___,...quote}=ack;
    return quote;
  }catch{
    throw new ApiError(503,"Canonical checkout quote could not be verified or persisted.");
  }
}
