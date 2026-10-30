/* eslint-disable prettier/prettier -- Private owner verifies the payment provider before releasing ANY reserved tender. */
import type {CatalogDB} from "../features/fore/catalog-model.server";
type OwnerEnv={PRIMARY_DB:CatalogDB;STRIPE_SECRET_KEY?:string;STRIPE_LIVEMODE?:string};
const orderId=/^[a-zA-Z0-9_-]{8,160}$/;
type Checkout={id:string;user_id:string;status:string;currency:string;
  stripe_due_minor:number;stripe_payment_intent_id:string|null;stripe_customer_id:string|null};
export async function executeOwnerUnpaidCancellation(env:OwnerEnv,raw:unknown){
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw Error("owner_cancellation_payload_invalid");
  const q=raw as Record<string,unknown>;
  if(Object.keys(q).sort().join(",")!=="orderId,source,userId"||
     typeof q.orderId!=="string"||!orderId.test(q.orderId)||
     typeof q.userId!=="string"||!orderId.test(q.userId)||
     !["customer","reconciliation"].includes(String(q.source)))
    throw Error("owner_cancellation_scope_invalid");
  const db=env.PRIMARY_DB;
  const order=await db.prepare(
    "SELECT id,user_id,status,currency,stripe_due_minor,stripe_payment_intent_id,stripe_customer_id FROM commerce_orders WHERE id=? AND user_id=?"
  ).bind(q.orderId,q.userId).first<Checkout>();
  if(!order||order.id!==q.orderId||order.user_id!==q.userId||
     !["pending_payment","payment_failed","authorized","processing","canceled"].includes(order.status)||
     typeof order.currency!=="string"||!/^[A-Z]{3}$/.test(order.currency)||
     !Number.isSafeInteger(order.stripe_due_minor)||order.stripe_due_minor<0)
    throw Error("owner_cancellation_not_unpaid");
  if(order.stripe_payment_intent_id){
    const live=env.STRIPE_LIVEMODE==="true",key=env.STRIPE_SECRET_KEY||"";
    if(!(live?/^(sk|rk)_live_/:/^(sk|rk|rkcs)_test_/).test(key)||
       !/^pi_[A-Za-z0-9_-]{4,150}$/.test(order.stripe_payment_intent_id))
      throw Error("owner_cancellation_provider_unavailable");
    const response=await fetch("https://api.stripe.com/v1/payment_intents/"+
      encodeURIComponent(order.stripe_payment_intent_id),{
        method:"GET",headers:{authorization:"Bearer "+key},
        redirect:"manual",signal:AbortSignal.timeout(15000)
      });
    if(response.status!==200)throw Error("owner_cancellation_provider_unverified");
    const payload=await response.text();
    if(payload.length>131072)throw Error("owner_cancellation_provider_response_large");
    let pi:Record<string,unknown>;
    try{pi=JSON.parse(payload)}catch{throw Error("owner_cancellation_provider_invalid")}
    const meta=pi?.metadata&&typeof pi.metadata==="object"&&!Array.isArray(pi.metadata)?
      pi.metadata as Record<string,unknown>:null;
    if(pi?.object!=="payment_intent"||pi.id!==order.stripe_payment_intent_id||
       pi.status!=="canceled"||pi.livemode!==live||
       !Number.isSafeInteger(pi.amount)||pi.amount!==order.stripe_due_minor||
       typeof pi.currency!=="string"||pi.currency.toUpperCase()!==order.currency||
       !meta||meta.fore_order_id!==order.id||
       (order.stripe_customer_id!==null&&pi.customer!==order.stripe_customer_id))
      throw Error("owner_cancellation_provider_not_canceled");
  }
  const at=new Date().toISOString();
  const stmts=[
    db.prepare(
      "UPDATE commerce_orders SET status='canceled',canceled_at=COALESCE(canceled_at,?),updated_at=? WHERE id=? AND user_id=? AND status IN ('pending_payment','payment_failed','authorized','processing')"
    ).bind(at,at,order.id,order.user_id),
    db.prepare(
      "UPDATE commerce_balance_reservations SET status='released',updated_at=? WHERE order_id=? AND status='reserved' AND EXISTS(SELECT 1 FROM commerce_orders WHERE id=? AND user_id=? AND status='canceled')"
    ).bind(at,order.id,order.id,order.user_id),
    db.prepare(
      "UPDATE commerce_promo_redemptions SET status='released',updated_at=? WHERE order_id=? AND status='reserved' AND EXISTS(SELECT 1 FROM commerce_orders WHERE id=? AND user_id=? AND status='canceled')"
    ).bind(at,order.id,order.id,order.user_id)
  ];
  await db.batch(stmts);
  const confirmed=await db.prepare(
    "SELECT status FROM commerce_orders WHERE id=? AND user_id=?"
  ).bind(order.id,order.user_id).first<{status:string}>();
  if(confirmed?.status!=="canceled")
    throw Error("owner_cancellation_canonical_confirmation_failed");
  const still=await db.prepare(
    "SELECT (SELECT COUNT(*) FROM commerce_balance_reservations WHERE order_id=? AND status='reserved')+(SELECT COUNT(*) FROM commerce_promo_redemptions WHERE order_id=? AND status='reserved') remaining"
  ).bind(order.id,order.id).first<{remaining:number}>();
  if(still?.remaining!==0)throw Error("owner_cancellation_reserved_funds_unreconciled");
  return {schema:"cove.owner-unpaid-cancellation.v1",orderId:order.id,userId:order.user_id,
    canceled:true,providerVerified:!!order.stripe_payment_intent_id,tenderReleased:true};
}

/** This is a diagnostic record, not a payment or entitlement authority.
 * Fixed schema + replay collision detection prevent an adapter from issuing
 * arbitrary SQL or silently changing a completed reconciliation report. */
export async function recordOwnerReconciliationRun(db:CatalogDB,raw:unknown){
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw Error("owner_reconcile_report_invalid");
  const q=raw as Record<string,unknown>;
  if(Object.keys(q).sort().join(",")!=="checked,details,finishedAt,mismatches,repaired,runId,startedAt"||
     typeof q.runId!=="string"||!/^recon_[0-9a-f-]{36}$/.test(q.runId)||
     ![q.checked,q.mismatches,q.repaired].every(x=>Number.isSafeInteger(x)&&Number(x)>=0&&Number(x)<=500)||
     typeof q.startedAt!=="string"||typeof q.finishedAt!=="string"||
     !Number.isFinite(Date.parse(q.startedAt))||!Number.isFinite(Date.parse(q.finishedAt))||
     Date.parse(q.finishedAt)<Date.parse(q.startedAt)||
     !Array.isArray(q.details)||q.details.length>100||
     !q.details.every(x=>x&&typeof x==="object"&&!Array.isArray(x)&&
       Object.keys(x).every(k=>["orderId","action","error","foreStatus","stripeStatus"].includes(k))&&
       Object.values(x).every(v=>typeof v==="string"&&v.length<=200)))
    throw Error("owner_reconcile_report_scope_invalid");
  const json=JSON.stringify(q.details),at=q.finishedAt as string;
  if(json.length>12000)throw Error("owner_reconcile_report_oversize");
  await db.prepare(
    "INSERT INTO commerce_reconciliation_runs(id,started_at,finished_at,status,checked_orders,mismatches,repaired,details_json) VALUES(?,?,?,'complete',?,?,?,?) ON CONFLICT(id) DO NOTHING"
  ).bind(q.runId,q.startedAt,at,q.checked,q.mismatches,q.repaired,json).run();
  const saved=await db.prepare(
    "SELECT started_at,finished_at,status,checked_orders,mismatches,repaired,details_json FROM commerce_reconciliation_runs WHERE id=?"
  ).bind(q.runId).first<{started_at:string;finished_at:string;status:string;checked_orders:number;
    mismatches:number;repaired:number;details_json:string}>();
  if(!saved||saved.started_at!==q.startedAt||saved.finished_at!==at||
     saved.status!=="complete"||saved.checked_orders!==q.checked||
     saved.mismatches!==q.mismatches||saved.repaired!==q.repaired||
     saved.details_json!==json)throw Error("owner_reconcile_report_replay_collision");
  return {schema:"cove.owner-reconciliation-report.v1",runId:q.runId,
    recorded:true,checked:q.checked,mismatches:q.mismatches,repaired:q.repaired};
}
