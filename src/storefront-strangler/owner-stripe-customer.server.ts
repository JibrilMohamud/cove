/* eslint-disable prettier/prettier -- Stage-only Stripe customer enrollment, no primary-D1 write fallback. */
import type {CoveEnv} from "../features/fore/api.server";
import {ApiError} from "../features/fore/service";
import {dispatchCanonicalOwnerCommand} from "./canonical-owner-command-gateway";
import {isReviewedPaidQaPrimary} from "./reviewed-paid-qa-primary";
export async function registerStageOwnerStripeCustomer(env:CoveEnv,input:{
  userId:string;customerId:string
}){
  if(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED!=="1"||
     env.COVE_SSR_STAGING!=="1"||
     env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1"||
     !isReviewedPaidQaPrimary(env.COVE_LEGAL_WRITER_PRIMARY_ID)||
     !/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET||"")||
     !env.LEGAL_AUTHORITY?.getByName)
    throw new ApiError(503,"Stripe customer owner is not certified.");
  try {
    return await dispatchCanonicalOwnerCommand(
      env.LEGAL_AUTHORITY.getByName("cove-staged-legal-global-v1"),
      env.COVE_RIGHTS_OWNER_SECRET!,"commerce.register-stripe-customer",input);
  }catch{
    throw new ApiError(503,"Stripe customer identity was not acknowledged by its canonical owner.");
  }
}
