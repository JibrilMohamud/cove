/* eslint-disable prettier/prettier -- Stage-only verified Stripe Tax ID writer, never a public D1 mutation. */
import type {CoveEnv} from "../features/fore/api.server";
import {ApiError} from "../features/fore/service";
import {dispatchCanonicalOwnerCommand} from "./canonical-owner-command-gateway";
const QA_IDS=new Set(["5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
 "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e"]);
export async function confirmStageOwnerStripeTax(env:CoveEnv,input:{
 kind:"transaction"|"reversal";orderId:string;refundId?:string;taxTransactionId:string
}):Promise<void>{
 if(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED!=="1"||
    env.COVE_SSR_STAGING!=="1"||
    env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1"||
    !QA_IDS.has(env.COVE_LEGAL_WRITER_PRIMARY_ID||"")||
    !/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET||"")||
    !env.LEGAL_AUTHORITY?.getByName)
   throw new ApiError(503,"Stripe Tax requires the independently verified private QA owner.");
 try{
  const result=await dispatchCanonicalOwnerCommand(
   env.LEGAL_AUTHORITY.getByName("cove-staged-legal-global-v1"),
   env.COVE_RIGHTS_OWNER_SECRET!,"commerce.confirm-tax",input);
  if(result.saved!==true)throw Error("owner_tax_confirmation_missing");
 }catch{throw new ApiError(503,"Stripe Tax provider verification or owner recording failed.");}
}
