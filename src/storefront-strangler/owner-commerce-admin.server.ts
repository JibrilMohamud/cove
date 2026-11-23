/* eslint-disable prettier/prettier -- Independent staff ACL and financial mutation occur inside the QA legal owner. */
import type {CoveEnv} from "../features/fore/api.server";
import {ApiError} from "../features/fore/service";
import {isReviewedPaidQaPrimary} from "./reviewed-paid-qa-primary";
import {dispatchCanonicalOwnerCommand} from "./canonical-owner-command-gateway";
export async function executeStageOwnerMonetaryAdmin(env:CoveEnv,command:{
  action:"promo"|"gift-card"|"store-credit";
  operationId:string;
  actor:{userId:string;authProvider:string;authSubject:string;aal:"aal1"|"aal2"};
  payload:Record<string,unknown>
}):Promise<Record<string,unknown>>{
  if(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED!=="1"||
     env.COVE_SSR_STAGING!=="1"||
     env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1"||
     !isReviewedPaidQaPrimary(env.COVE_LEGAL_WRITER_PRIMARY_ID)||
     !/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET||"")||
     !env.LEGAL_AUTHORITY?.getByName)
    throw new ApiError(503,"Monetary commerce administrator owner is unavailable.");
  try{
    return await dispatchCanonicalOwnerCommand(
      env.LEGAL_AUTHORITY.getByName("cove-staged-legal-global-v1"),
      env.COVE_RIGHTS_OWNER_SECRET!,"commerce.admin-monetary",command
    );
  }catch{
    throw new ApiError(503,"The commerce owner rejected or could not confirm the financial operation.");
  }
}
