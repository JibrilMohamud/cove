/* eslint-disable prettier/prettier -- Imported by the private owner; never accepts SQL or provider success from a caller. */
import type {CatalogDB} from "../features/fore/catalog-model.server";
import type {CoveEnv} from "../features/fore/api.server";
import {postPaidSettlementTransaction,type SettlementPayment,type SettlementOrder,type SettlementAcquiredLine} from "../features/fore/paid-settlement-transaction.server";
import {reconcileOwnerPaidSettlementEffects} from "../features/fore/commerce.server";
import {readPaidOrderPermission} from "./commercial-entitlement-core";
import {readCommercialProofs} from "./commercial-legal-core";
import {marketIsWithdrawn} from "./market-authority-core";
import type {AuthoritySql} from "./legal-authority-core";

type OwnerEnv={PRIMARY_DB:CatalogDB;STRIPE_SECRET_KEY?:string;STRIPE_LIVEMODE?:string;STRIPE_TAX_ENABLED?:string};
type OwnerContext={env:OwnerEnv;sql:AuthoritySql;executing:Set<string>;
  publish:(order:{id:string;user_id:string;territory_code:string})=>Promise<void>};
const id=/^[a-zA-Z0-9_-]{8,160}$/;
/** The owner derives the PI identity from canonical state and independently
 * retrieves Stripe's result with its own server key. Metadata, caller-supplied
 * success flags and HTTP-200 alone cannot manufacture a payment.
 */
async function verifiedPayment(env:OwnerEnv,order:SettlementOrder):Promise<SettlementPayment>{
  if(Number(order.stripe_due_minor)===0){
    if(order.stripe_payment_intent_id)throw Error("internal_order_has_stripe_identity");
    return {provider:"internal",paymentIntentId:null,chargeId:null,receiptUrl:null,paymentMethod:"Internal balance"};
  }
  const live=env.STRIPE_LIVEMODE==="true",key=env.STRIPE_SECRET_KEY||"";
  if(!(live?/^(sk|rk)_live_/:/^(sk|rk|rkcs)_test_/).test(key)||
     !/^pi_[a-zA-Z0-9_-]{4,200}$/.test(order.stripe_payment_intent_id||""))
    throw Error("owner_stripe_verifier_unavailable");
  const url="https://api.stripe.com/v1/payment_intents/"+encodeURIComponent(String(order.stripe_payment_intent_id))+"?expand[]=latest_charge.balance_transaction";
  const response=await fetch(url,{headers:{authorization:"Bearer "+key},
    redirect:"error",signal:AbortSignal.timeout(15_000)});
  if(response.status!==200){
    const reason=response.status===401?"owner_stripe_credential_rejected":
      response.status===403?"owner_stripe_permission_denied":
      response.status===404?"owner_stripe_payment_not_found":
      response.status===429?"owner_stripe_verification_rate_limited":
      response.status===400?"owner_stripe_verification_request_rejected":"owner_stripe_verification_failed";
    throw Error(reason);
  }
  const text=await response.text();if(text.length>131072)throw Error("owner_stripe_receipt_too_large");
  const pi=JSON.parse(text);
  if(pi.id!==order.stripe_payment_intent_id||pi.object!=="payment_intent"||pi.status!=="succeeded"||
     pi.livemode!==live||!Number.isSafeInteger(pi.amount_received)||
     pi.amount_received!==Number(order.stripe_due_minor)||pi.amount!==Number(order.stripe_due_minor)||
     typeof pi.currency!=="string"||pi.currency.toUpperCase()!==order.currency||
     pi.metadata?.fore_order_id!==order.id||
     (order.stripe_customer_id&&pi.customer!==order.stripe_customer_id))
    throw Error("owner_stripe_order_scope_mismatch");
  const charge=pi.latest_charge&&typeof pi.latest_charge==="object"?pi.latest_charge:null;
  if(charge&&(charge.payment_intent!==pi.id||charge.refunded===true||
     Number(charge.amount_refunded||0)>0||charge.disputed===true))
    throw Error("owner_stripe_charge_not_settleable");
  const bt=charge?.balance_transaction;
  if(!bt||typeof bt!=="object"||!Number.isSafeInteger(bt.fee)||bt.fee<0||
     !Number.isSafeInteger(bt.net)||typeof bt.id!=="string"||!/^txn_[a-zA-Z0-9_-]{3,200}$/.test(bt.id)||
     typeof bt.currency!=="string"||bt.currency.toUpperCase()!==order.currency)
    throw Error("owner_stripe_fee_not_available");
  return {provider:"stripe",paymentIntentId:pi.id,chargeId:charge?.id||null,
    processorFee:{amountMinor:bt.fee,currency:bt.currency.toUpperCase(),reference:bt.id,netMinor:bt.net},
    receiptUrl:charge?.receipt_url||null,paymentMethod:charge?.payment_method_details?.type||"Stripe"};
}

export async function executeOwnerPaidSettlement(ctx:OwnerContext,raw:unknown){
  if(!raw||typeof raw!=="object"||Array.isArray(raw)||Object.keys(raw).join(",")!=="orderId"||
     typeof (raw as {orderId?:unknown}).orderId!=="string"||!id.test((raw as {orderId:string}).orderId))
    throw Error("invalid_owner_settlement_command");
  const {orderId}=raw as {orderId:string};
  // Fixed stage labels are used only to classify unexpected private-owner TypeErrors.
  let phase="owner_authority_gate";
  if(ctx.executing.has(orderId))throw Error("owner_settlement_already_executing");
  ctx.executing.add(orderId);
  try{
    const {env,sql}=ctx,db=env.PRIMARY_DB;
    if(!readPaidOrderPermission(sql,{orderId}).allowed)throw Error("owner_settlement_order_withdrawn");
    phase="canonical_order_read";
    const order=await db.prepare("SELECT * FROM commerce_orders WHERE id=?").bind(orderId).first<SettlementOrder>();
    if(!order||!id.test(order.user_id)||!/^[A-Z]{2}$/.test(order.territory_code)||
       !["pending_payment","processing","authorized","payment_failed","paid"].includes(order.status)||
       marketIsWithdrawn(sql,order.territory_code))throw Error("owner_settlement_order_scope_invalid");
    phase="canonical_lines_read";
    const lines=(await db.prepare("SELECT product_id,rights_grant_id,rights_snapshot_json,sales_channel FROM commerce_order_items WHERE order_id=? ORDER BY id LIMIT 26")
      .bind(orderId).all<SettlementAcquiredLine>()).results;
    if(!lines.length||lines.length>25||new Set(lines.map(l=>l.product_id)).size!==lines.length)
      throw Error("owner_settlement_line_inventory_invalid");
    const verifyRights=()=>{
      if(!readPaidOrderPermission(sql,{orderId}).allowed||marketIsWithdrawn(sql,order.territory_code))
        throw Error("owner_settlement_order_withdrawn");
      for(const line of lines){
        const rights=readCommercialProofs(sql,[line.product_id],order.territory_code,"retail")[0];
        const snapshot=JSON.parse(line.rights_snapshot_json||"null");
        if(!rights||!snapshot||line.sales_channel!=="retail"||snapshot.grantId!==line.rights_grant_id||
           snapshot.grantId!==rights.grant_id||snapshot.editionId!==rights.edition_id||
           snapshot.contractId!==rights.contract_id||snapshot.contractVersionId!==rights.contract_version_id||
           snapshot.territory!==order.territory_code||snapshot.salesChannel!=="retail")
          throw Error("owner_settlement_acquired_rights_changed");
      }
    };
    phase="initial_rights_check";
    verifyRights();
    phase="stripe_payment_verification";
    const payment=await verifiedPayment(env,order);
    phase="verified_rights_recheck";
    verifyRights();
    phase="durable_owner_command";
    const reference=payment.paymentIntentId||"internal:"+orderId;
    const prior=sql.exec<{payment_reference:string}>("SELECT payment_reference FROM cove_paid_settlement_commands WHERE order_id=?",orderId).toArray()[0];
    if(prior&&prior.payment_reference!==reference)throw Error("owner_settlement_identity_collision");
    sql.exec("INSERT INTO cove_paid_settlement_commands(order_id,payment_reference,state) VALUES(?,?,'pending') ON CONFLICT(order_id) DO UPDATE SET state='pending'",orderId,reference);
    // If D1 commits but its acknowledgement is lost, the SAME command loads
    // the atomic canonical receipt after a DO restart, without extra tender,
    // entitlements, promo counters or sale ledger entries.
    phase="atomic_canonical_transaction";
    const result=await postPaidSettlementTransaction(db,orderId,payment);
    phase="postcommit_effects";
    await reconcileOwnerPaidSettlementEffects({...env,DB:db,STRIPE_LIVEMODE:env.STRIPE_LIVEMODE||"false"} as unknown as CoveEnv,orderId);
    phase="effects_receipt";
    await db.prepare("UPDATE commerce_settlement_receipts SET effects_completed_at=COALESCE(effects_completed_at,?) WHERE order_id=?")
      .bind(new Date().toISOString(),orderId).run();
    verifyRights();
    sql.exec("UPDATE cove_paid_settlement_commands SET state='complete' WHERE order_id=?",orderId);
    phase="owner_permission_publication";
    await ctx.publish({id:orderId,user_id:order.user_id,territory_code:order.territory_code});
    phase="publication_receipt";
    await db.prepare("UPDATE commerce_settlement_receipts SET owner_published_at=COALESCE(owner_published_at,?) WHERE order_id=? AND effects_completed_at IS NOT NULL")
      .bind(new Date().toISOString(),orderId).run();
    return {schema:"cove.owner-paid-settlement.v1",orderId,settled:true,
      effectsReconciled:true,accessPublished:true,applied:result.applied};
  }catch(error){
    // Never reflect raw unexpected exceptions to QA: only a fixed stage code.
    // An unknown failure does not authorize fallback or reopen buyer access.
    if(error instanceof TypeError)throw Error("owner_settlement_phase_"+phase);
    throw error;
  }finally{ctx.executing.delete(orderId);}
}
