/* eslint-disable prettier/prettier -- Stage-only webhook journal owner; never allow raw D1 fallback. */
import type {CoveEnv} from "../features/fore/api.server";
import {ApiError} from "../features/fore/service";
import {dispatchCanonicalOwnerCommand} from "./canonical-owner-command-gateway";

const QA_DB_IDS=new Set([
  "5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
  "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e"
]);
function port(env:CoveEnv){
  if(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED!=="1"||
     env.COVE_SSR_STAGING!=="1"||
     env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1"||
     !QA_DB_IDS.has(env.COVE_LEGAL_WRITER_PRIMARY_ID||"")||
     !/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET||"")||
     !env.LEGAL_AUTHORITY?.getByName)
    throw new ApiError(503,"Webhook owner is not certified.");
  return env.LEGAL_AUTHORITY.getByName("cove-staged-legal-global-v1");
}
type Claim={eventId:string;eventType:string;payloadSha256:string;livemode:boolean};
type Finish={eventId:string;payloadSha256:string;token:string;outcome:"processed"|"failed"};
export async function claimStageOwnerStripeWebhook(env:CoveEnv,claim:Claim) {
  const owner=port(env);
  try{
    return await dispatchCanonicalOwnerCommand(owner,env.COVE_RIGHTS_OWNER_SECRET!,
      "commerce.claim-webhook",claim) as {
      schema:string;eventId:string;payloadSha256:string;claimed:boolean;duplicate:boolean;token:string|null
    };
  }catch{
    throw new ApiError(503,"Webhook owner could not claim verified Stripe event.");
  }
}
export async function finishStageOwnerStripeWebhook(env:CoveEnv,finish:Finish) {
  const owner=port(env);
  try{
    return await dispatchCanonicalOwnerCommand(owner,env.COVE_RIGHTS_OWNER_SECRET!,
      "commerce.finish-webhook",finish);
  }catch{
    throw new ApiError(503,"Webhook owner did not acknowledge the final Stripe event state.");
  }
}
