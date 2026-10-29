/* eslint-disable prettier/prettier -- Enrolled refund creation has no raw-primary fallback. */
import type {CoveEnv} from "../features/fore/api.server";
import {ApiError} from "../features/fore/service";
import {dispatchCanonicalOwnerCommand} from "./canonical-owner-command-gateway";

const QA_DB_IDS=new Set([
  "5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
  "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e"
]);
type RefundRequest={orderId:string;amountMinor?:number;reason:string;idempotencyKey:string};
export async function reserveStageOwnerRefundIntent(env:CoveEnv,input:RefundRequest) {
  if(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED!=="1"||
     env.COVE_SSR_STAGING!=="1"||
     env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1"||
     !QA_DB_IDS.has(env.COVE_LEGAL_WRITER_PRIMARY_ID||"")||
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
