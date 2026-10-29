/* eslint-disable prettier/prettier -- The Stripe provider observation is owner-fenced only for isolated QA. */
import type {CoveEnv} from "../features/fore/api.server";
import {ApiError} from "../features/fore/service";
import {dispatchCanonicalOwnerCommand} from "./canonical-owner-command-gateway";

const QA_DB_IDS=new Set(["5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
  "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e"]);
/** Same leased private owner as the final refund accounting command.
 * The authenticated server Stripe response or signed webhook supplies
 * provider identity; a browser never supplies it to this route. */
export async function recordStageOwnerRefundProvider(env:CoveEnv,orderId:string,
 refundId:string,providerRefundId:string,status:string
){
  if(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED!=="1"||
     env.COVE_SSR_STAGING!=="1"||
     env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1"||
     !QA_DB_IDS.has(env.COVE_LEGAL_WRITER_PRIMARY_ID||"")||
     !/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET||"")||
     !env.LEGAL_AUTHORITY?.getByName)
    throw new ApiError(503,"Refund provider owner is not certified.");
  try{
    return await dispatchCanonicalOwnerCommand(
      env.LEGAL_AUTHORITY.getByName("cove-staged-legal-global-v1"),
      env.COVE_RIGHTS_OWNER_SECRET!,
      "commerce.record-refund-provider",
      {orderId,refundId,providerRefundId,status}
    );
  }catch{
    throw new ApiError(503,"Refund provider owner unavailable.");
  }
}
