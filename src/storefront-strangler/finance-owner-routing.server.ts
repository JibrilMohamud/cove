/* eslint-disable prettier/prettier, @typescript-eslint/no-explicit-any -- The private owner alone installs exact financial algorithms. */
import type {CatalogDB} from "../features/fore/catalog-model.server";
import {ApiError} from "../features/fore/service";
import {dispatchFinanceOwnerAction} from "./publication-owner-routing.server";
export const financeActions=["createFinanceParty","createRoyaltyContract","createRoyaltyContractVersion",
 "createPayoutBatch","approvePayoutBatch","settlePayoutBatch","recordUsageEvent",
 "processUsageEventRoyalty","createUsagePool","allocateUsagePool"] as const;
export type FinanceAction=typeof financeActions[number];
export type FinanceMethod=FinanceAction|"calculateAndAccrueRoyalty"|"accrueSaleRoyaltiesForOrder"|
 "accrueRoyaltiesForOrder"|"reverseRoyaltiesForRefund"|"reverseRoyaltiesForChargeback";
export type FinanceActor={userId:string;operationId?:string};
export type FinanceExecutors=Record<FinanceMethod,(db:CatalogDB,...args:any[])=>Promise<any>>;
const privateExecutors=new WeakMap<object,FinanceExecutors>();
/** Runtime importer checks permit ONLY legal-authority.worker.ts to install
 * these closures. They and their SQL are absent from every public bundle. */
export function bindPrivateFinanceExecutors(db:CatalogDB,executors:FinanceExecutors){
 privateExecutors.set(db,executors);
}
export async function invokeFinanceOwner(db:CatalogDB,method:FinanceMethod,args:unknown[],actor?:FinanceActor):Promise<any>{
 const local=privateExecutors.get(db);
 if(local)return local[method](db,...args);
 if(!financeActions.includes(method as FinanceAction)||!actor?.userId)
   throw new ApiError(503,"Financial mutations require the private financial owner.");
 return dispatchFinanceOwnerAction(db,method as FinanceAction,args,actor);
}
