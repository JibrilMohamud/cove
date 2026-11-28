import { hasProductionQuarantineBusinessDb } from "./production-quarantine-owner";
/* eslint-disable prettier/prettier -- Enrolled refund creation has no raw-primary fallback. */
import type {CoveEnv} from "../features/fore/api.server";
import {ApiError} from "../features/fore/service";
import {isReviewedPaidQaPrimary} from "./reviewed-paid-qa-primary";
import {dispatchCanonicalOwnerCommand} from "./canonical-owner-command-gateway";

type RefundRequest={orderId:string;amountMinor?:number;reason:string;idempotencyKey:string};
export async function reserveStageOwnerRefundIntent(env:CoveEnv,input:RefundRequest) {
  if((!hasProductionQuarantineBusinessDb(env.DB)&&(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED!=="1"||
     env.COVE_SSR_STAGING!=="1"||
     env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1"||
     !isReviewedPaidQaPrimary(env.COVE_LEGAL_WRITER_PRIMARY_ID)))||
     !/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET||"")||
     !env.LEGAL_AUTHORITY?.getByName)
    throw new ApiError(503,"Refund reservation owner is not certified.");
  try {
    return await dispatchCanonicalOwnerCommand(
      env.LEGAL_AUTHORITY.getByName("cove-staged-legal-global-v1"),
      env.COVE_RIGHTS_OWNER_SECRET!,"commerce.reserve-refund",input
    );
  }catch{
    throw new ApiError(503,"Refund reservation was not acknowledged by the canonical owner.");
  }
}
