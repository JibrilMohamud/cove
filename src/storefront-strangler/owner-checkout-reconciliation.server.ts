/* eslint-disable prettier/prettier -- No caller-side D1 fallback on the enrolled checkout and cron writer plane. */
import type {CoveEnv} from "../features/fore/api.server";
import {ApiError} from "../features/fore/service";
import {dispatchCanonicalOwnerCommand} from "./canonical-owner-command-gateway";
const QA=new Set(["5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
  "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e"]);
function ownerPort(env:CoveEnv){
  if(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED!=="1"||
     env.COVE_SSR_STAGING!=="1"||env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1"||
     !QA.has(env.COVE_LEGAL_WRITER_PRIMARY_ID||"")||
     !/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET||"")||
     !env.LEGAL_AUTHORITY?.getByName)
    throw new ApiError(503,"The protected commerce writer is not certified.");
  return env.LEGAL_AUTHORITY.getByName("cove-staged-legal-global-v1");
}
export async function cancelStageOwnerUnpaidCheckout(
  env:CoveEnv,command:{orderId:string;userId:string;source:"customer"|"reconciliation"}
){
  try{
    return await dispatchCanonicalOwnerCommand(ownerPort(env),env.COVE_RIGHTS_OWNER_SECRET!,
      "commerce.cancel-unpaid",command);
  }catch{throw new ApiError(503,"The owner could not independently verify checkout cancellation.");}
}
export async function recordStageOwnerReconciliation(
  env:CoveEnv,command:{runId:string;startedAt:string;finishedAt:string;
    checked:number;mismatches:number;repaired:number;details:Array<Record<string,string>>}
){
  try{
    return await dispatchCanonicalOwnerCommand(ownerPort(env),env.COVE_RIGHTS_OWNER_SECRET!,
      "commerce.record-reconciliation",command);
  }catch{throw new ApiError(503,"The owner did not acknowledge the reconciliation journal.");}
}
