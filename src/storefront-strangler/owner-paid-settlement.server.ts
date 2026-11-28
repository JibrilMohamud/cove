/* eslint-disable prettier/prettier -- A fixed domain command; no caller-side settlement fallback. */
import type {CoveEnv} from "../features/fore/api.server";
import {ApiError} from "../features/fore/service";
import {isReviewedPaidQaPrimary} from "./reviewed-paid-qa-primary";
import {dispatchCanonicalOwnerCommand,CanonicalSettlementRefusal} from "./canonical-owner-command-gateway";

function settlementPort(env:CoveEnv){
  if(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED!=="1"||env.COVE_SSR_STAGING!=="1"||
     env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1"||
     !isReviewedPaidQaPrimary(env.COVE_LEGAL_WRITER_PRIMARY_ID)||
     !env.LEGAL_AUTHORITY?.getByName)throw new ApiError(503,"Payment owner is not certified.");
  return env.LEGAL_AUTHORITY.getByName("cove-staged-legal-global-v1");
}
export async function recoverStageOwnerPaidSettlements(env:CoveEnv,limit=10){
  try{return await dispatchCanonicalOwnerCommand(settlementPort(env),env.COVE_RIGHTS_OWNER_SECRET||"",
    "commerce.recover-settlements",{limit});}
  catch{throw new ApiError(503,"Payment recovery owner unavailable.");}
}
export async function settleStageOwnerPaidOrder(env:CoveEnv,orderId:string){
  try{
    await dispatchCanonicalOwnerCommand(settlementPort(env),
      env.COVE_RIGHTS_OWNER_SECRET||"","commerce.settle-order",{orderId});
  }catch(error){
    // Only the protected detached QA primary receives a fixed diagnostic code.
    // All other callers retain the ordinary fail-closed response.
    if(env.COVE_SSR_STAGING==="1"&&env.COVE_LEGAL_WRITER_PRIMARY_ID==="f9354381-bd9f-496b-bd05-d6f62a32ec0c"&&
       error instanceof CanonicalSettlementRefusal)
      throw new ApiError(503,"QA settlement: "+error.reason);
    throw new ApiError(503,"Payment owner did not acknowledge the complete settlement.");
  }
  const order=await env.DB.prepare("SELECT * FROM commerce_orders WHERE id=?").bind(orderId).first<Record<string,unknown>>();
  if(!order||order.status!=="paid")throw new ApiError(503,"Payment owner receipt is not canonical.");
  return order;
}
