/* eslint-disable prettier/prettier -- Privately fenced checkout draft + preparation; never release to live customer routing. */
import type {CoveEnv} from "../features/fore/api.server";
import {ApiError} from "../features/fore/service";
import {dispatchCanonicalOwnerCommand} from "./canonical-owner-command-gateway";

const QA_PRIMARIES=new Set(["5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
  "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e"]);

function privateCheckoutPort(env:CoveEnv){
  if(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED!=="1"||
     env.COVE_SSR_STAGING!=="1"||
     env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1"||
     !QA_PRIMARIES.has(env.COVE_LEGAL_WRITER_PRIMARY_ID||"")||
     !/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET||"")||
     !env.LEGAL_AUTHORITY?.getByName)
    throw new ApiError(503,"Canonical checkout owner is not certified.");
  return env.LEGAL_AUTHORITY.getByName("cove-staged-legal-global-v1");
}

export async function materializeStageCheckoutDraft(env:CoveEnv,input:{
  userId:string;quoteId:string;idempotencyKey:string;cartFingerprint:string;
  captureMethod:"manual"|"automatic"|"automatic_async";
  soundsStation?:string;soundsRecording?:string;
}){
  try{return await dispatchCanonicalOwnerCommand(privateCheckoutPort(env),
    env.COVE_RIGHTS_OWNER_SECRET!,"commerce.materialize-checkout-draft",input);}
  catch{throw new ApiError(503,"Canonical checkout owner could not materialize the order.");}
}

export async function prepareStageCheckoutDraft(env:CoveEnv,input:{
  userId:string;orderId:string;quoteId:string;
}){
  try{return await dispatchCanonicalOwnerCommand(privateCheckoutPort(env),
    env.COVE_RIGHTS_OWNER_SECRET!,"commerce.prepare-checkout-draft",input);}
  catch{throw new ApiError(503,"Canonical checkout owner could not reserve checkout tenders.");}
}
