/* eslint-disable prettier/prettier -- A fixed domain command; no caller-side settlement fallback. */
import type {CoveEnv} from "../features/fore/api.server";
import {ApiError} from "../features/fore/service";
import {dispatchCanonicalOwnerCommand} from "./canonical-owner-command-gateway";

function settlementPort(env:CoveEnv){
  if(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED!=="1"||env.COVE_SSR_STAGING!=="1"||
     env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1"||
     !["5e3a6b69-6f3d-4b19-b837-01f7aa56ce87","7c7ab994-f6b3-419d-a72d-71eb9ea22e7e"].includes(env.COVE_LEGAL_WRITER_PRIMARY_ID||"")||
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
  }catch{throw new ApiError(503,"Payment owner did not acknowledge the complete settlement.");}
  const order=await env.DB.prepare("SELECT * FROM commerce_orders WHERE id=?").bind(orderId).first<Record<string,unknown>>();
  if(!order||order.status!=="paid")throw new ApiError(503,"Payment owner receipt is not canonical.");
  return order;
}
