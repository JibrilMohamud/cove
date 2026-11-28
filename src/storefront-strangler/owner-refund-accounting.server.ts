import { hasProductionQuarantineBusinessDb } from "./production-quarantine-owner";
/* eslint-disable prettier/prettier -- Isolated QA owner-first refund posting; never a raw D1 writer. */
import type {CoveEnv} from "../features/fore/api.server";
import {ApiError} from "../features/fore/service";
import {isReviewedPaidQaPrimary} from "./reviewed-paid-qa-primary";
import {dispatchCanonicalOwnerCommand} from "./canonical-owner-command-gateway";

export async function postStageOwnerRefundAccounting(
  env:CoveEnv,orderId:string,refundId:string
) {
  // Fail closed if the caller is enabled but any isolated QA boundary is
  // missing. No alternate route can bypass this contract with a production
  // primary-D1 binding, a chosen owner namespace or a fabricated success flag.
  if((!hasProductionQuarantineBusinessDb(env.DB)&&(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED!=="1"||
    env.COVE_SSR_STAGING!=="1"||
    env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1"||
    !isReviewedPaidQaPrimary(env.COVE_LEGAL_WRITER_PRIMARY_ID)))||
    !/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET||"")||
    !env.LEGAL_AUTHORITY?.getByName)
    throw new ApiError(503,"Owner-first refund accounting is not certified.");
  try {
    return await dispatchCanonicalOwnerCommand(
      env.LEGAL_AUTHORITY.getByName("cove-staged-legal-global-v1"),
      env.COVE_RIGHTS_OWNER_SECRET!,"commerce.post-refund-accounting",
      {orderId,refundId}
    );
  }catch{
    throw new ApiError(503,"Refund owner accounting was not acknowledged.");
  }
}
