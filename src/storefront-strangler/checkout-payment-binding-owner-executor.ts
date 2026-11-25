/* eslint-disable prettier/prettier -- Canonical checkout PaymentIntent binding is owner-only and verified against Stripe. */
import type {CatalogDB} from "../features/fore/catalog-model.server";

type OwnerEnv={PRIMARY_DB:CatalogDB;STRIPE_SECRET_KEY?:string;STRIPE_LIVEMODE?:string};
type Command={orderId:string;userId:string;paymentIntentId:string;customerId:string};
type Order={id:string;user_id:string;invoice_number:string;status:string;currency:string;
  stripe_due_minor:number;capture_method:string;stripe_customer_id:string|null;
  stripe_payment_intent_id:string|null;quote_id:string};
const orderIdPattern=/^[a-zA-Z0-9_-]{8,160}$/;
const stripeId=(prefix:string)=>new RegExp("^"+prefix+"_[a-zA-Z0-9_-]{4,150}$");
const integer=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
export type CheckoutPaymentWrite=(args:{
  command:Command;order:Order;stripeStatus:string;paymentMethodTypes:string[];
  at:string;paymentAttemptId:string
})=>Promise<{applied:boolean}>;
function parse(raw:unknown):Command{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw Error("invalid_owner_payment_binding");
  const v=raw as Record<string,unknown>;
  if(Object.keys(v).sort().join(",")!=="customerId,orderId,paymentIntentId,userId"||
     typeof v.orderId!=="string"||!orderIdPattern.test(v.orderId)||
     typeof v.userId!=="string"||!orderIdPattern.test(v.userId)||
     typeof v.paymentIntentId!=="string"||!stripeId("pi").test(v.paymentIntentId)||
     typeof v.customerId!=="string"||!stripeId("cus").test(v.customerId))
    throw Error("invalid_owner_payment_binding");
  return v as Command;
}
export async function executeOwnerCheckoutPaymentBinding(env:OwnerEnv,raw:unknown,write:CheckoutPaymentWrite){
  const cmd=parse(raw),db=env.PRIMARY_DB;
  const order=await db.prepare("SELECT * FROM commerce_orders WHERE id=? AND user_id=?")
    .bind(cmd.orderId,cmd.userId).first<Order>();
  if(!order||!integer(order.stripe_due_minor)||
     !["pending_payment","processing","authorized","payment_failed"].includes(order.status)||
     (order.stripe_payment_intent_id&&order.stripe_payment_intent_id!==cmd.paymentIntentId)||
     (order.stripe_customer_id&&order.stripe_customer_id!==cmd.customerId)||
     !["manual","automatic","automatic_async"].includes(order.capture_method))
    throw Error("owner_checkout_order_scope_invalid");
  const customer=await db.prepare("SELECT stripe_customer_id FROM commerce_customers WHERE user_id=?")
    .bind(cmd.userId).first<{stripe_customer_id:string}>();
  if(customer?.stripe_customer_id!==cmd.customerId)
    throw Error("owner_checkout_customer_mismatch");
  const quote=await db.prepare(
    "SELECT id,consumed_at,expires_at FROM commerce_checkout_quotes WHERE id=? AND user_id=?"
  ).bind(order.quote_id,cmd.userId).first<{id:string;consumed_at:string|null;expires_at:string}>();
  if(!quote?.consumed_at)throw Error("owner_checkout_quote_not_committed");
  const lines=await db.prepare(
    "SELECT id FROM commerce_order_items WHERE order_id=? LIMIT 26"
  ).bind(cmd.orderId).all<{id:string}>();
  if(lines.results.length<1||lines.results.length>25)
    throw Error("owner_checkout_invalid_order_lines");
  const live=env.STRIPE_LIVEMODE==="true",key=env.STRIPE_SECRET_KEY||"";
  if(!(live?/^(sk|rk)_live_/:/^(sk|rk|rkcs)_test_/).test(key))
    throw Error("owner_checkout_stripe_key_unavailable");
  const response=await fetch(
    "https://api.stripe.com/v1/payment_intents/"+encodeURIComponent(cmd.paymentIntentId),
    {headers:{authorization:"Bearer "+key},redirect:"manual",signal:AbortSignal.timeout(15_000)}
  );
  if(response.status!==200)throw Error("owner_checkout_stripe_verification_failed");
  const bytes=await response.text();
  if(bytes.length>131072)throw Error("owner_checkout_provider_receipt_too_large");
  let pi:{id?:string;object?:string;customer?:string;livemode?:boolean;
    metadata?:{fore_order_id?:string;fore_user_id?:string;fore_invoice?:string};
    amount?:number;currency?:string;capture_method?:string;status?:string;
    payment_method_types?:string[]};
  try{pi=JSON.parse(bytes);}catch{throw Error("owner_checkout_provider_receipt_invalid");}
  if(!pi||pi.object!=="payment_intent"||pi.id!==cmd.paymentIntentId||
     pi.customer!==cmd.customerId||pi.livemode!==live||
     pi.metadata?.fore_order_id!==order.id||
     pi.metadata?.fore_user_id!==order.user_id||
     pi.metadata?.fore_invoice!==order.invoice_number||
     pi.currency?.toUpperCase()!==order.currency||
     !integer(pi.amount)||pi.amount!==Number(order.stripe_due_minor)||
     pi.capture_method!==order.capture_method||
     typeof pi.status!=="string"||
     !["requires_payment_method","requires_confirmation","requires_action",
       "requires_capture","processing","succeeded"].includes(pi.status))
    throw Error("owner_checkout_provider_scope_mismatch");
  // The executor owns all provider, buyer and order validation. The actual
  // canonical SQL is implemented only inside the excluded private DO worker,
  // never in an importable non-owner module or a caller-selected SQL RPC.
  const at=new Date().toISOString();
  const {applied}=await write({command:cmd,order,
    stripeStatus:pi.status,paymentMethodTypes:Array.isArray(pi.payment_method_types)?
      pi.payment_method_types.slice(0,12):[],at,paymentAttemptId:"pay_"+crypto.randomUUID()});
  return {schema:"cove.owner-checkout-payment-binding.v1",orderId:cmd.orderId,
    userId:cmd.userId,paymentIntentId:cmd.paymentIntentId,customerId:cmd.customerId,
    stripeDueMinor:Number(order.stripe_due_minor),bound:true,applied};
}
