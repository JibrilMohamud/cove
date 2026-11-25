/* eslint-disable prettier/prettier -- transaction-local isolated budget fence */
import type {CatalogDB} from "../features/fore/catalog-model.server";

export const LITERARY_BUDGET_CRON="25 * * * *";
const isolatedIdentity="EXISTS(SELECT 1 FROM literary_budget_domain_identity WHERE id=1 AND domain='cove-isolated-literary-budget' AND schema_version=1) AND NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('rights_grants','products','payment_orders'))";
const precedingActive="EXISTS(SELECT 1 FROM literary_budget_cutover WHERE day=? AND status='active')";
const destinationWritable="NOT EXISTS(SELECT 1 FROM literary_budget_cutover WHERE day=? AND status IN ('active','closed'))";

/** Native owner operation. Primary is read only; one isolated D1 batch
 * carries forward the frozen reservation total, prepares and activates the
 * current UTC day. Never bootstrap or reopen a closed day. */
export async function rollOwnedLiteraryBudget(primary:CatalogDB, isolated:CatalogDB, clock=()=>Date.now()){
  if(!primary?.prepare||!isolated?.prepare||!isolated.batch||primary===isolated)throw Error("literary_budget_binding_invalid");
  const today=new Date(clock()).toISOString().slice(0,10);
  const yesterday=new Date(Date.parse(today+"T00:00:00Z")-86400000).toISOString().slice(0,10);
  const [identity,previous,current]=await Promise.all([
    isolated.prepare("SELECT CASE WHEN "+isolatedIdentity+" THEN 1 ELSE 0 END valid").first<{valid:number}>(),
    isolated.prepare("SELECT status FROM literary_budget_cutover WHERE day=?").bind(yesterday).first<{status:string}>(),
    isolated.prepare("SELECT status FROM literary_budget_cutover WHERE day=?").bind(today).first<{status:string}>()
  ]);
  if(identity?.valid!==1)throw Error("literary_budget_binding_invalid");
  async function frozen(){
    const authority=await primary.prepare("SELECT (SELECT value FROM cove_runtime_config WHERE key='literary_processing_owner') owner,(SELECT value FROM cove_runtime_config WHERE key='literary_budget_domain') domain,EXISTS(SELECT 1 FROM literary_profile_jobs WHERE status='running' AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) jobs,EXISTS(SELECT 1 FROM literary_profile_state WHERE id=1 AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) sweep,COALESCE((SELECT reserved_units FROM literary_profile_budget WHERE day=?),0) units,COALESCE((SELECT calls FROM literary_profile_budget WHERE day=?),0) calls").bind(today,today).first<{owner:string;domain:string;jobs:number;sweep:number;units:number;calls:number}>();
    if(!authority||!["draining","isolated"].includes(authority.owner)||authority.domain!=="isolated"||authority.jobs!==0||authority.sweep!==0||
      !Number.isSafeInteger(authority.units)||authority.units<0||authority.units>100_000_000||!Number.isSafeInteger(authority.calls)||authority.calls<0)
      throw Error("literary_budget_primary_not_frozen");
    return authority;
  }
  const first=await frozen();
  const receipt=(state:string)=>({schema:"cove.owner-literary-budget-rollover.v1",day:today,previousDay:yesterday,state,primaryMutation:false});
  if(current?.status==="active")return receipt("already_active");
  if(current?.status==="closed")throw Error("literary_budget_closed_day");
  if(previous?.status!=="active")return receipt("previous_day_not_active");
  const second=await frozen();
  if(first.owner!==second.owner||first.units!==second.units||first.calls!==second.calls||new Date(clock()).toISOString().slice(0,10)!==today)
    throw Error("literary_budget_frozen_snapshot_drift");
  const guard=isolatedIdentity+" AND "+precedingActive+" AND "+destinationWritable;
  const result=await isolated.batch([
    isolated.prepare("INSERT INTO literary_profile_budget(day,reserved_units,calls) SELECT ?,?,? WHERE "+guard+
      " ON CONFLICT(day) DO UPDATE SET reserved_units=MAX(reserved_units,excluded.reserved_units),calls=MAX(calls,excluded.calls)")
      .bind(today,second.units,second.calls,yesterday,today),
    isolated.prepare("INSERT INTO literary_budget_cutover(day,status,original_reserved_units,original_calls,prepared_at,operator_receipt) SELECT ?,'prepared',?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),? WHERE "+guard+
      " ON CONFLICT(day) DO UPDATE SET original_reserved_units=MAX(original_reserved_units,excluded.original_reserved_units),original_calls=MAX(original_calls,excluded.original_calls) WHERE status='prepared'")
      .bind(today,second.units,second.calls,"continuous-fenced-literary-budget-"+today,yesterday,today),
    isolated.prepare("UPDATE literary_budget_cutover SET status='active',activated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE day=? AND status='prepared' AND original_reserved_units>=? AND original_calls>=? AND "+isolatedIdentity+" AND "+precedingActive+
      " AND EXISTS(SELECT 1 FROM literary_profile_budget WHERE day=? AND reserved_units>=? AND calls>=?) RETURNING day,status")
      .bind(today,second.units,second.calls,yesterday,today,second.units,second.calls)
  ]);
  if(!Array.isArray(result)||result.length!==3)throw Error("literary_budget_batch_failed");
  const final=await isolated.prepare("SELECT status,original_reserved_units,original_calls FROM literary_budget_cutover WHERE day=?").bind(today).first<{status:string;original_reserved_units:number;original_calls:number}>();
  if(final?.status!=="active"||final.original_reserved_units<second.units||final.original_calls<second.calls)throw Error("literary_budget_activation_unverified");
  return receipt("active");
}
