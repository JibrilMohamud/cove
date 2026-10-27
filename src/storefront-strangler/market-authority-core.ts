/* eslint-disable prettier/prettier -- Global market withdrawal is a strongly consistent authorization veto. */
import type {AuthoritySql} from "./legal-authority-core";
const territoryPattern=/^[A-Z]{2}$/;
const operationPattern=/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

/**
 * A market withdrawal must veto ALL products and grants in the territory,
 * including old paid leases and unpublished/old offer evidence. This table
 * intentionally has NO grant or re-enable command: restoring a market
 * requires a separately reviewed owner-first positive publication protocol
 * with fresh canonical evidence; deleting a tombstone here is forbidden.
 *
 * Every operation is stable and scope-bound. The caller MUST run this
 * function in the Durable Object's SQLite transactionSync.
 */
export function createMarketAuthoritySchema(sql:AuthoritySql){
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_market_withdrawals(
    territory TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    withdrawn_at TEXT NOT NULL
  ) WITHOUT ROWID`);
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_market_withdrawal_ops(
    operation_id TEXT PRIMARY KEY,
    territory TEXT NOT NULL
  ) WITHOUT ROWID`);
}
export function denyMarket(sql:AuthoritySql,raw:unknown,now=new Date().toISOString()){
  if(!raw||typeof raw!=="object"||Array.isArray(raw))
    throw Error("invalid_market_denial");
  const {territory,operationId}=raw as Record<string,unknown>;
  if(typeof territory!=="string"||!territoryPattern.test(territory)||
     typeof operationId!=="string"||!operationPattern.test(operationId)||
     !Number.isFinite(Date.parse(now)))
    throw Error("invalid_market_denial");
  const old=sql.exec<{territory:string}>(
    "SELECT territory FROM cove_market_withdrawal_ops WHERE operation_id=?",
    operationId).toArray()[0];
  if(old&&old.territory!==territory)
    throw Error("market_denial_operation_scope_collision");
  // No broad UPDATE/DELETE. A second withdrawal cannot undo the first.
  sql.exec("INSERT OR IGNORE INTO cove_market_withdrawals(territory,operation_id,withdrawn_at) VALUES(?,?,?)",
    territory,operationId,now);
  if(!old)sql.exec(
    "INSERT INTO cove_market_withdrawal_ops(operation_id,territory) VALUES(?,?)",
    operationId,territory);
  return {applied:true,territory,withdrawn:true};
}
export function marketIsWithdrawn(sql:AuthoritySql,territory:unknown){
  if(typeof territory!=="string"||!territoryPattern.test(territory))
    throw Error("invalid_market_authorization_scope");
  return sql.exec<{denied:number}>(
    "SELECT 1 denied FROM cove_market_withdrawals WHERE territory=? LIMIT 1",
    territory).toArray().length>0;
}
