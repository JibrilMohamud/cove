/* eslint-disable prettier/prettier -- Isolated QA owner-first refund posting; never a raw D1 writer. */
import type {CoveEnv} from "../features/fore/api.server";
import {ApiError} from "../features/fore/service";
import {dispatchCanonicalOwnerCommand} from "./canonical-owner-command-gateway";

const QA_DB_IDS=new Set([
  "5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
  "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e"
]);
export async function postStageOwnerRefundAccounting(
  env:CoveEnv,orderId:string,refundId:string
) {
  // Fail closed if the caller is enabled but any isolated QA boundary is
  // missing. No alternate route can bypass this contract with a production
  // primary-D1 binding, a chosen owner namespace or a fabricated success flag.
  if(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED!=="1"||
    env.COVE_SSR_STAGING!=="1"||
    env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1"||
    !QA_DB_IDS.has(env.COVE_LEGAL_WRITER_PRIMARY_ID||"")||
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
