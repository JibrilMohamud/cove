/* eslint-disable prettier/prettier -- Exact Stripe dispute evidence is checked with the private legal owner's credential. */
type OwnerStripeEnv={STRIPE_SECRET_KEY?:string;STRIPE_LIVEMODE?:string};
export type VerifiedStripeDispute={
  id:string;chargeId:string;amountMinor:number;currency:string;
  status:string;reason:string;evidenceDueAt:string|null;
};
const id=/^dp_[A-Za-z0-9_-]{4,150}$/;
const charge=/^ch_[A-Za-z0-9_-]{4,150}$/;
const allowed=new Set(["needs_response","under_review","warning_needs_response",
  "warning_under_review","warning_closed","won","lost"]);
/** Fixed endpoint; caller supplies only a verified Stripe dispute ID, not
 * status, order identity, ledger amounts, credentials or an arbitrary URL. */
export async function verifyOwnerStripeDispute(
  env:OwnerStripeEnv,disputeId:string
):Promise<VerifiedStripeDispute>{
  if(!id.test(disputeId))throw Error("owner_dispute_id_invalid");
  const live=env.STRIPE_LIVEMODE==="true";
  const key=env.STRIPE_SECRET_KEY||"";
  if(!(live?/^(sk|rk)_live_/:/^(sk|rk|rkcs)_test_/).test(key))
    throw Error("owner_dispute_stripe_credential_unavailable");
  const response=await fetch("https://api.stripe.com/v1/disputes/"+encodeURIComponent(disputeId),{
    method:"GET",headers:{authorization:"Bearer "+key},
    redirect:"manual",signal:AbortSignal.timeout(15000)
  });
  if(response.status!==200)throw Error("owner_dispute_stripe_fetch_failed");
  const text=await response.text();
  if(text.length>131072)throw Error("owner_dispute_stripe_response_oversized");
  let r:Record<string,unknown>;
  try{r=JSON.parse(text)}catch{throw Error("owner_dispute_stripe_invalid_json")}
  if(!r||typeof r!=="object"||Array.isArray(r))throw Error("owner_dispute_stripe_invalid");
  const c=r.charge;
  const chargeId=typeof c==="string"?c:
    (c&&typeof c==="object"&&!Array.isArray(c)?(c as Record<string,unknown>).id:null);
  const amount=r.amount;
  const currency=r.currency;
  const status=r.status;
  if(r.object!=="dispute"||r.id!==disputeId||r.livemode!==live||
     typeof chargeId!=="string"||!charge.test(chargeId)||
     !Number.isSafeInteger(amount)||Number(amount)<=0||Number(amount)>1_000_000_000_000||
     typeof currency!=="string"||!/^[a-zA-Z]{3}$/.test(currency)||
     typeof status!=="string"||!allowed.has(status))
    throw Error("owner_dispute_provider_scope_mismatch");
  const details=r.evidence_details;
  const due=details&&typeof details==="object"&&!Array.isArray(details)?
    (details as Record<string,unknown>).due_by:null;
  const evidenceDueAt=typeof due==="number"&&Number.isSafeInteger(due)&&due>0?
    new Date(due*1000).toISOString():null;
  return {id:disputeId,chargeId,amountMinor:Number(amount),
    currency:currency.toUpperCase(),status,reason:typeof r.reason==="string"?
      r.reason.slice(0,120):"",evidenceDueAt};
}
