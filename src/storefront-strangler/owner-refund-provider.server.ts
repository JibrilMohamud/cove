import { hasProductionQuarantineBusinessDb } from "./production-quarantine-owner";
/* eslint-disable prettier/prettier -- Private stage refund provider record, no fallback D1 writer. */
import type {CoveEnv} from "../features/fore/api.server";
import {ApiError} from "../features/fore/service";
import {isReviewedPaidQaPrimary} from "./reviewed-paid-qa-primary";
import {dispatchCanonicalOwnerCommand} from "./canonical-owner-command-gateway";

type StripeRefundReceipt={
  orderId:string;refundId:string;providerRefundId:string;
  paymentIntentId:string;amountMinor:number;currency:string;
  status:"pending"|"requires_action"|"succeeded"|"failed"|"canceled"
};
export async function recordStageOwnerRefundProvider(
  env:CoveEnv,receipt:StripeRefundReceipt
){
  if((!hasProductionQuarantineBusinessDb(env.DB)&&(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED!=="1"||
    env.COVE_SSR_STAGING!=="1"||
    env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1"||
    !isReviewedPaidQaPrimary(env.COVE_LEGAL_WRITER_PRIMARY_ID)))||
    !/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET||"")||
    !env.LEGAL_AUTHORITY?.getByName)
    throw new ApiError(503,"Owner-first Stripe refund record is not certified.");
  try{
    return await dispatchCanonicalOwnerCommand(
      env.LEGAL_AUTHORITY.getByName("cove-staged-legal-global-v1"),
      env.COVE_RIGHTS_OWNER_SECRET!,"commerce.record-refund-provider",receipt
    );
  }catch{
    throw new ApiError(503,"Stripe refund provider owner did not acknowledge.");
  }
}
