/* eslint-disable prettier/prettier -- Owner-confirmed staged Stripe status transitions, never raw D1 fallback. */
import type {CoveEnv} from "../features/fore/api.server";
import {ApiError} from "../features/fore/service";
import {dispatchCanonicalOwnerCommand} from "./canonical-owner-command-gateway";

type Status="processing"|"authorized"|"payment_failed"|"canceled";
export async function updateStageOwnerPaymentState(env:CoveEnv,command:{
  orderId:string;paymentIntentId:string;state:Status;failureCode:string|null;
}){
  if(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED!=="1"||
     env.COVE_SSR_STAGING!=="1"||
     env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1"||
     !["5e3a6b69-6f3d-4b19-b837-01f7aa56ce87","7c7ab994-f6b3-419d-a72d-71eb9ea22e7e"]
      .includes(env.COVE_LEGAL_WRITER_PRIMARY_ID||"")||
     !/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET||"")||
     !env.LEGAL_AUTHORITY?.getByName)
    throw new ApiError(503,"Stripe payment-state owner is not certified.");
  try{
    return await dispatchCanonicalOwnerCommand(
      env.LEGAL_AUTHORITY.getByName("cove-staged-legal-global-v1"),
      env.COVE_RIGHTS_OWNER_SECRET!,"commerce.update-payment-state",command
    ) as {schema:string;state:Status;applied:boolean;orderId:string;paymentIntentId:string};
  }catch{
    throw new ApiError(503,"Stripe payment-state owner did not acknowledge canonical transition.");
  }
}
