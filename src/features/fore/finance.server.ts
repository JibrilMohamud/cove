/* eslint-disable prettier/prettier, @typescript-eslint/no-explicit-any -- Typed public facades have no financial SQL or fallback. */
import type {CatalogDB} from "./catalog-model.server";
import {invokeFinanceOwner,type FinanceActor} from "../../storefront-strangler/finance-owner-routing.server";
export async function accrueRoyaltiesForOrder(db:CatalogDB,orderId:string):Promise<void>{
 await invokeFinanceOwner(db,"accrueRoyaltiesForOrder",[orderId]);
}
export async function reverseRoyaltiesForRefund(db:CatalogDB,refundId:string):Promise<void>{
 await invokeFinanceOwner(db,"reverseRoyaltiesForRefund",[refundId]);
}
export async function reverseRoyaltiesForChargeback(db:CatalogDB,orderId:string,disputeId:string):Promise<void>{
 await invokeFinanceOwner(db,"reverseRoyaltiesForChargeback",[orderId,disputeId]);
}
export async function createRoyaltyContract(db:CatalogDB,raw:unknown,actor?:FinanceActor):Promise<any>{
 return invokeFinanceOwner(db,"createRoyaltyContract",[raw],actor);
}
export async function createFinanceParty(db:CatalogDB,raw:unknown,actor?:FinanceActor):Promise<any>{
 return invokeFinanceOwner(db,"createFinanceParty",[raw],actor);
}
export async function createPayoutBatch(db:CatalogDB,raw:unknown,actor?:FinanceActor):Promise<any>{
 return invokeFinanceOwner(db,"createPayoutBatch",[raw],actor);
}
export async function approvePayoutBatch(db:CatalogDB,batchId:string,actor?:FinanceActor):Promise<any>{
 return invokeFinanceOwner(db,"approvePayoutBatch",[batchId],actor);
}
export async function settlePayoutBatch(db:CatalogDB,raw:unknown,actor?:FinanceActor):Promise<any>{
 return invokeFinanceOwner(db,"settlePayoutBatch",[raw],actor);
}
export async function financeAdminSnapshot(db: CatalogDB) {
  const [parties, contracts, events, calculations, batches, statements] = await Promise.all([
    db.prepare("SELECT * FROM finance_parties ORDER BY updated_at DESC LIMIT 200").all<any>(),
    db
      .prepare(
        `SELECT rc.*,rcv.id version_id,rcv.version,rcv.calculation_basis,rcv.fore_commission_bps,rcv.default_royalty_rate_bps,rcv.payment_terms_days,rcv.reserve_bps,rcv.rules_version_hash,rcv.effective_from version_effective_from,rcv.effective_to version_effective_to,(SELECT COUNT(*) FROM finance_royalty_rules rr WHERE rr.contract_version_id=rcv.id) rule_count FROM finance_royalty_contracts rc LEFT JOIN finance_royalty_contract_versions rcv ON rcv.contract_id=rc.id WHERE rc.status<>'retired' ORDER BY rc.updated_at DESC,rcv.version DESC LIMIT 500`,
      )
      .all<any>(),
    db
      .prepare("SELECT * FROM finance_royalty_events ORDER BY created_at DESC LIMIT 300")
      .all<any>(),
    db
      .prepare("SELECT * FROM finance_royalty_calculations ORDER BY calculated_at DESC LIMIT 300")
      .all<any>(),
    db.prepare("SELECT * FROM payout_batches ORDER BY created_at DESC LIMIT 100").all<any>(),
    db.prepare("SELECT * FROM finance_statements ORDER BY generated_at DESC LIMIT 100").all<any>(),
  ]);
  return {
    parties: parties.results,
    contracts: contracts.results,
    royaltyEvents: events.results,
    royaltyCalculations: calculations.results,
    payoutBatches: batches.results,
    statements: statements.results,
  };
}
