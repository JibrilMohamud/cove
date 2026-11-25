/* eslint-disable prettier/prettier -- One strong-owner transaction publishes all or none of a paid order. */
import type {AuthoritySql} from "./legal-authority-core";
import {captureEntitlementEpoch,publishFreshEntitlement} from "./commercial-entitlement-core";
import {marketIsWithdrawn} from "./market-authority-core";

const id=/^[a-zA-Z0-9_-]{8,160}$/;
export type VerifiedPaidOrderLine={
  entitlementId:string;userId:string;productId:string;
  territory:string;channel:"retail";orderId:string;
  productEpoch:number;validUntil:string;expectedEpoch:number;
};
/**
 * Caller MUST execute this inside one DO SQLite transactionSync. All line
 * proofs are independently verified against canonical paid order,
 * immutable purchased grant/contract/version and risk status BEFORE entry.
 * Do not call this directly from a public request or store the inputs in KV.
 *
 * The product epoch is checked anew for each line inside THIS transaction.
 * This prevents a withdrawal arriving during D1 verification from winning
 * against a stale positive lease. A failed line throws and rolls back EVERY
 * earlier line; an already revoked purchase never receives a fresh proof.
 */
export function publishVerifiedPaidOrderAtomic(
  sql:AuthoritySql,raw:unknown,now=Date.now()
){
  if(!Array.isArray(raw)||raw.length<1||raw.length>25)
    throw Error("invalid_paid_order_atomic_inventory");
  const lines=raw as VerifiedPaidOrderLine[];
  const first=lines[0]!;
  if(!id.test(first.orderId)||!id.test(first.userId)||
     !/^[A-Z]{2}$/.test(first.territory)||first.channel!=="retail")
    throw Error("invalid_paid_order_atomic_scope");
  if(marketIsWithdrawn(sql,first.territory))
    throw Error("paid_order_market_withdrawn");
  const seenEnt=new Set<string>(),seenProd=new Set<string>();
  for(const line of lines){
    if(!line||line.orderId!==first.orderId||line.userId!==first.userId||
       line.territory!==first.territory||line.channel!==first.channel||
       seenEnt.has(line.entitlementId)||seenProd.has(line.productId)||
       !id.test(line.entitlementId)||!/^prd_[a-zA-Z0-9_-]{3,120}$/.test(line.productId)||
       line.productId.startsWith("prd_gutenberg_")||
       !Number.isSafeInteger(line.productEpoch)||line.productEpoch<=0||
       !Number.isSafeInteger(line.expectedEpoch)||line.expectedEpoch<0)
      throw Error("invalid_paid_order_atomic_line");
    seenEnt.add(line.entitlementId);seenProd.add(line.productId);
  }
  // If the order was refunded during any D1 read, reject the entire cart.
  // The paid entitlement core checks the same tombstone per line for safety.
  if(sql.exec("SELECT 1 ok FROM cove_paid_refunded_orders WHERE order_id=?",
       first.orderId).toArray().length)
    throw Error("paid_order_already_revoked");
  const receipt=[];
  for(const line of lines){
    if(captureEntitlementEpoch(sql,line)!==line.expectedEpoch)
      throw Error("paid_order_entitlement_epoch_changed");
    const result=publishFreshEntitlement(sql,line,line.expectedEpoch,now);
    if(!result.applied || !Number.isSafeInteger(result.epoch) || result.epoch<=0)
      throw Error("paid_order_atomic_publication_failed");
    receipt.push({entitlementId:line.entitlementId,epoch:result.epoch});
  }
  return {applied:true,orderId:first.orderId,receipts:receipt};
}
