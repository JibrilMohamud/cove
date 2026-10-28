/* eslint-disable prettier/prettier -- Exact owner-command receipts are a payment trust boundary. */
import {ApiError} from "../features/fore/service";
import type {CoveEnv} from "../features/fore/api.server";

const QA_PRIMARY_IDS=new Set([
  "5e3a6b69-6f3d-4b19-b837-01f7aa56ce87",
  "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e",
]);

/** Refund and dispute callers cannot mutate entitlements themselves when
 * enrolled. The exact private owner durably withdraws the order and owns
 * its D1 reconciliation. No raw writer binding, buyer list or SQL is sent.
 * Production enrollment remains disabled until the independent writer and
 * infrastructure certification is complete. */
export async function revokePaidOrderAccess(
  env:CoveEnv,orderId:string,operationId:string
):Promise<void> {
  if(env.COVE_LEGAL_CONSUMER_STAGE_ENABLED!=="1")return;
  if(env.COVE_SSR_STAGING!=="1"||
     env.COVE_CANONICAL_LEGAL_WRITE_LOCK!=="1"||
     !QA_PRIMARY_IDS.has(env.COVE_LEGAL_WRITER_PRIMARY_ID||"")||
     !env.LEGAL_AUTHORITY?.getByName||
     !/^[a-f0-9]{64}$/.test(env.COVE_RIGHTS_OWNER_SECRET||"")||
     !/^[a-zA-Z0-9_-]{8,160}$/.test(orderId)||
     !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(operationId))
    throw new ApiError(503,"Refund entitlement owner is not certified.");
  let payload:unknown;
  try {
    const response=await env.LEGAL_AUTHORITY
      .getByName("cove-staged-legal-global-v1")
      .fetch(new Request("https://legal-authority.internal/commercial/order/revoke",{
        method:"POST",headers:{"content-type":"application/json",
          authorization:"Bearer "+env.COVE_RIGHTS_OWNER_SECRET},
        body:JSON.stringify({orderId,operationId})
      }));
    if(response.status!==200)throw Error("owner_revocation_unavailable");
    payload=await response.json();
  }catch{
    throw new ApiError(503,"Refund owner did not acknowledge entitlement withdrawal.");
  }
  const receipt=payload as Record<string,unknown>|null;
  if(!receipt||Array.isArray(receipt)||
     receipt.schema!=="cove.paid-order-revocation.v1"||
     receipt.orderDenied!==true||receipt.reconciled!==true||
     receipt.orderId!==orderId||receipt.operationId!==operationId)
    throw new ApiError(503,"Refund ownership receipt was invalid.");
}
