/* eslint-disable prettier/prettier -- Private QA owner is the only enrolled dispute financial executor. */
import type {CoveEnv} from "../features/fore/api.server";
import {ApiError} from "../features/fore/service";
import {dispatchCanonicalOwnerCommand} from "./canonical-owner-command-gateway";

import {isReviewedPaidQaPrimary} from "./reviewed-paid-qa-primary";
export async function syncStageOwnerStripeDispute(env:CoveEnv,command:{
  disputeId:string;eventType:"charge.dispute.created"|"charge.dispute.updated"|"charge.dispute.closed"|"charge.dispute.funds_withdrawn"|"charge.dispute.funds_reinstated"
}){
  if(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED!=="1"||
     env.COVE_SSR_STAGING!=="1"||
     env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1"||
     !isReviewedPaidQaPrimary(env.COVE_LEGAL_WRITER_PRIMARY_ID)||
     !/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET||"")||
     !env.LEGAL_AUTHORITY?.getByName)
    throw new ApiError(503,"Dispute owner is not independently certified.");
  try{
    return await dispatchCanonicalOwnerCommand(
      env.LEGAL_AUTHORITY.getByName("cove-staged-legal-global-v1"),
      env.COVE_RIGHTS_OWNER_SECRET!,"commerce.sync-dispute",command
    ) as {schema:string;disputeId:string;synced:true;linked:boolean;
      ownerDenied:boolean;accountingReconciled:true};
  }catch{
    throw new ApiError(503,"Stripe dispute owner did not acknowledge the canonical posting.");
  }
}
