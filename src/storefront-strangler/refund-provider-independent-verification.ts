/* eslint-disable prettier/prettier -- Owner-only Stripe evidence; no caller-supplied refund outcome can authorize accounting. */
/**
 * Read the refund again using the private legal owner's own Stripe credential.
 * A verified webhook or a private API caller is an input signal, NOT provider
 * authority. No SQL, caller-selected URL, redirect, or customer credentials.
 */
type StripeOwnerEnv={STRIPE_SECRET_KEY?:string;STRIPE_LIVEMODE?:string};
export type StripeRefundClaim={
  orderId:string;refundId:string;providerRefundId:string;paymentIntentId:string;
  amountMinor:number;currency:string;status:string;
};
const statuses=new Set(["pending","requires_action","succeeded","failed","canceled"]);
const money=(v:unknown)=>typeof v==="number"&&Number.isSafeInteger(v)&&v>0;
export async function independentlyVerifyOwnerStripeRefund(
  env:StripeOwnerEnv, claim:StripeRefundClaim
):Promise<"pending"|"requires_action"|"succeeded"|"failed"|"canceled">{
  const live=env.STRIPE_LIVEMODE==="true";
  const secret=env.STRIPE_SECRET_KEY||"";
  if(!(live?/^(sk|rk)_live_/:/^(sk|rk|rkcs)_test_/).test(secret))
    throw Error("owner_refund_stripe_credential_unavailable");
  // IDs were already parsed and scoped against canonical D1 by the owner.
  if(!/^re_[A-Za-z0-9_-]{4,200}$/.test(claim.providerRefundId))
    throw Error("owner_refund_provider_id_invalid");
  const response=await fetch(
    "https://api.stripe.com/v1/refunds/"+encodeURIComponent(claim.providerRefundId),
    {method:"GET",headers:{authorization:"Bearer "+secret},
      redirect:"manual",signal:AbortSignal.timeout(15_000)}
  );
  if(response.status!==200)throw Error("owner_refund_stripe_fetch_failed");
  const text=await response.text();
  if(text.length>131072)throw Error("owner_refund_stripe_response_oversized");
  let provider:Record<string,unknown>;
  try{provider=JSON.parse(text);}catch{throw Error("owner_refund_stripe_response_invalid");}
  if(!provider||typeof provider!=="object"||Array.isArray(provider))
    throw Error("owner_refund_stripe_response_invalid");
  const reference=provider.payment_intent;
  const paymentIntent=typeof reference==="string"?reference:
    (reference&&typeof reference==="object"&&!Array.isArray(reference)
      ?(reference as Record<string,unknown>).id:null);
  const metadata=provider.metadata;
  const m=metadata&&typeof metadata==="object"&&!Array.isArray(metadata)?
    metadata as Record<string,unknown>:null;
  if(provider.object!=="refund"||provider.id!==claim.providerRefundId||
     provider.livemode!==live||paymentIntent!==claim.paymentIntentId||
     !money(provider.amount)||provider.amount!==claim.amountMinor||
     typeof provider.currency!=="string"||
     provider.currency.toUpperCase()!==claim.currency||
     !m||m.fore_order_id!==claim.orderId||m.fore_refund_id!==claim.refundId||
     typeof provider.status!=="string"||!statuses.has(provider.status))
    throw Error("owner_refund_independent_provider_scope_mismatch");
  // Never trust a caller's false success. A stale pending webhook is safe:
  // the independently fetched current Stripe state wins.
  if(claim.status==="succeeded"&&provider.status!=="succeeded")
    throw Error("owner_refund_unproven_provider_success");
  return provider.status as "pending"|"requires_action"|"succeeded"|"failed"|"canceled";
}
