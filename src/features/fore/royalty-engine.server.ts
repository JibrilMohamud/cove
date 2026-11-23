/* eslint-disable prettier/prettier, @typescript-eslint/no-explicit-any -- Typed public facades have no financial SQL or fallback. */
import type {CatalogDB} from "./catalog-model.server";
import {invokeFinanceOwner,type FinanceActor} from "../../storefront-strangler/finance-owner-routing.server";
export type RoyaltyContext = {
  sourceType:
    | "sale"
    | "refund"
    | "chargeback"
    | "subscription"
    | "library"
    | "wholesale"
    | "agency"
    | "promotion_adjustment"
    | "manual_adjustment";
  sourceId: string;
  orderId?: string | null;
  orderItemId?: string | null;
  usageEventId?: string | null;
  productId: string;
  publisherId?: string | null;
  territory: string;
  format: string;
  salesChannel: string;
  currency: string;
  quantity?: number;
  listPriceMinor?: number;
  customerPriceMinor?: number;
  taxMinor?: number;
  processorFeeMinor?: number;
  promotionDiscountMinor?: number;
  foreFundedDiscountMinor?: number;
  publisherFundedDiscountMinor?: number;
  distributorFeeMinor?: number;
  grossValueMinor?: number;
  rightsBasis?: string | null;
  promotionType?: string | null;
  promotionFundingSource?: string | null;
  distributorId?: string | null;
  subscriptionPlanId?: string | null;
  occurredAt: string;
  /** Optional contractual availability anchor (for example, a paid preorder release date). */
  availabilityAnchorAt?: string | null;
  metadata?: Record<string, unknown>;
};
export type SaleRoyaltyPlan = {
  statements: Parameters<CatalogDB["batch"]>[0];
  at: string;
  processorFees?: Map<string, number>;
  preorderReleaseDates?: Map<string, string>;
};
export async function calculateAndAccrueRoyalty(db:CatalogDB,ctx:RoyaltyContext,plan?:SaleRoyaltyPlan):Promise<any>{
 return invokeFinanceOwner(db,"calculateAndAccrueRoyalty",[ctx,plan]);
}
export async function accrueSaleRoyaltiesForOrder(db:CatalogDB,orderId:string,plan?:SaleRoyaltyPlan):Promise<void>{
 await invokeFinanceOwner(db,"accrueSaleRoyaltiesForOrder",[orderId,plan]);
}
export async function createRoyaltyContractVersion(db:CatalogDB,raw:unknown,actor?:FinanceActor):Promise<any>{
 return invokeFinanceOwner(db,"createRoyaltyContractVersion",[raw],actor);
}
export async function recordUsageEvent(db:CatalogDB,raw:unknown,actor?:FinanceActor):Promise<any>{
 return invokeFinanceOwner(db,"recordUsageEvent",[raw],actor);
}
export async function processUsageEventRoyalty(db:CatalogDB,usageEventId:string,actor?:FinanceActor):Promise<any>{
 return invokeFinanceOwner(db,"processUsageEventRoyalty",[usageEventId],actor);
}
export async function createUsagePool(db:CatalogDB,raw:unknown,actor?:FinanceActor):Promise<any>{
 return invokeFinanceOwner(db,"createUsagePool",[raw],actor);
}
export async function allocateUsagePool(db:CatalogDB,poolId:string,actor?:FinanceActor):Promise<any>{
 return invokeFinanceOwner(db,"allocateUsagePool",[poolId],actor);
}
