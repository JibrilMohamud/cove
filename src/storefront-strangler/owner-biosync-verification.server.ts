/* eslint-disable prettier/prettier -- Independently verified QA-only Biosync canonical writer. */
import type {CoveEnv} from "../features/fore/api.server";
import {ApiError} from "../features/fore/service";
import {dispatchCanonicalOwnerCommand} from "./canonical-owner-command-gateway";
const QA=new Set(["5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
 "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e"]);
export async function dispatchStageOwnerVerifiedBiosync(env:CoveEnv,actorUserId:string,request:unknown){
 if(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED!=="1"||
    env.COVE_SSR_STAGING!=="1"||env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1"||
    !QA.has(env.COVE_LEGAL_WRITER_PRIMARY_ID||"")||
    !/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET||"")||
    !env.LEGAL_AUTHORITY?.getByName)
   throw new ApiError(503,"Commercial Biosync verification requires a private QA owner.");
 try{
  const result=await dispatchCanonicalOwnerCommand(
    env.LEGAL_AUTHORITY.getByName("cove-staged-legal-global-v1"),
    env.COVE_RIGHTS_OWNER_SECRET!,"audio.verify-biosync",{actorUserId,request});
  if(result.status!=="verified")throw Error("owner_biosync_receipt_invalid");
  return {id:String(result.id),status:"verified",precision:result.precision,
    coverageBps:Number(result.coverageBps),
    timingManifestSha256:String(result.timingManifestSha256),
    cueCount:Number(result.cueCount)};
 }catch{throw new ApiError(503,"Private Biosync owner did not certify this manifest.");}
}
