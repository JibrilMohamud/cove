/* eslint-disable prettier/prettier -- Strong private paid-entitlement revocation is a separate legal trust boundary. */
import type {AuthoritySql} from "./legal-authority-core";
import {commercialProductId,readCommercialProofs,type CommercialChannel} from "./commercial-legal-core";

const entityId=/^[a-zA-Z0-9_-]{8,160}$/;
const userIdPattern=/^[a-zA-Z0-9_-]{8,160}$/;
const opIdPattern=/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
type EntitlementScope={entitlementId:string;userId:string;productId:string};
export function validatePaidEntitlementScope(raw:unknown):EntitlementScope {
  if(!raw||typeof raw!=="object"||Array.isArray(raw))
    throw Error("invalid_paid_entitlement_scope");
  const r=raw as Record<string,unknown>;
  if(typeof r.entitlementId!=="string"||!entityId.test(r.entitlementId)||
     typeof r.userId!=="string"||!userIdPattern.test(r.userId)||
     typeof r.productId!=="string"||!commercialProductId.test(r.productId)||
     r.productId.startsWith("prd_gutenberg_"))
    throw Error("invalid_paid_entitlement_scope");
  return {entitlementId:r.entitlementId,userId:r.userId,productId:r.productId};
}
export function createPaidEntitlementSchema(sql:AuthoritySql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_paid_settlement_recovery_cursors(
    scope TEXT PRIMARY KEY,after_id TEXT NOT NULL,after_time TEXT NOT NULL
  ) WITHOUT ROWID`);
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_paid_settlement_commands(
    order_id TEXT PRIMARY KEY,payment_reference TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','complete'))
  ) WITHOUT ROWID`);
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_paid_entitlement_authority(
    entitlement_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    epoch INTEGER NOT NULL CHECK(epoch>0),
    verdict TEXT NOT NULL CHECK(verdict IN ('deny','allow')),
    product_epoch INTEGER,
    valid_until TEXT
  ) WITHOUT ROWID`);
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_paid_entitlement_ops(
    operation_id TEXT PRIMARY KEY,
    entitlement_id TEXT NOT NULL,
    epoch INTEGER NOT NULL CHECK(epoch>0)
  ) WITHOUT ROWID`);
  // No ALTER of an existing deployed buyer table is necessary. Older
  // entitlements without a verified order binding fail closed on read.
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_paid_entitlement_orders(
    entitlement_id TEXT PRIMARY KEY,order_id TEXT NOT NULL
  ) WITHOUT ROWID`);
  // Binding a buyer to a product epoch alone is insufficient: independent
  // country or channel grants can share that epoch. Old leases missing this
  // immutable acquisition snapshot deliberately fail closed on read.
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_paid_entitlement_scopes(
    entitlement_id TEXT PRIMARY KEY,
    territory TEXT NOT NULL,channel TEXT NOT NULL,
    edition_id TEXT NOT NULL,grant_id TEXT NOT NULL,
    contract_id TEXT NOT NULL,contract_version_id TEXT NOT NULL,
    FOREIGN KEY(entitlement_id) REFERENCES cove_paid_entitlement_orders(entitlement_id)
  ) WITHOUT ROWID`);
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_paid_refunded_orders(
    order_id TEXT PRIMARY KEY
  ) WITHOUT ROWID`);
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_paid_order_denial_ops(
    operation_id TEXT PRIMARY KEY,order_id TEXT NOT NULL
  ) WITHOUT ROWID`);
}
type EntRow={entitlement_id:string;user_id:string;product_id:string;
  epoch:number;verdict:"deny"|"allow";product_epoch:number|null;valid_until:string|null};
const current=(sql:AuthoritySql,id:string)=>
  sql.exec<EntRow>(
    "SELECT entitlement_id,user_id,product_id,epoch,verdict,product_epoch,valid_until FROM cove_paid_entitlement_authority WHERE entitlement_id=?",
    id
  ).toArray()[0];
/**
 * A whole paid order is revoked with ONE durable SQLite owner write,
 * regardless of its line-item count. A failed D1 entitlement reconciliation
 * cannot leave old buyer proofs usable. This order may NEVER be regranted:
 * a legitimately new purchase must have a new canonical order ID.
 */
export function denyPaidOrder(sql:AuthoritySql,raw:unknown){
  if(!raw||typeof raw!=="object"||Array.isArray(raw))
    throw Error("invalid_paid_order_denial");
  const {orderId,operationId}=raw as Record<string,unknown>;
  if(typeof orderId!=="string"||!entityId.test(orderId)||
     typeof operationId!=="string"||!opIdPattern.test(operationId))
    throw Error("invalid_paid_order_denial");
  const old=sql.exec<{order_id:string}>(
    "SELECT order_id FROM cove_paid_order_denial_ops WHERE operation_id=?",
    operationId
  ).toArray()[0];
  if(old&&old.order_id!==orderId)
    throw Error("paid_order_denial_scope_collision");
  sql.exec("INSERT OR IGNORE INTO cove_paid_refunded_orders(order_id) VALUES(?)",orderId);
  if(!old)sql.exec(
    "INSERT INTO cove_paid_order_denial_ops(operation_id,order_id) VALUES(?,?)",
    operationId,orderId
  );
  return {applied:true,orderId};
}
/** Negative authority is checked BEFORE tender consumption. An unknown
 * order has no positive buyer entitlement; this only rejects a previous
 * durable refund, fraud hold or withdrawal for its immutable order ID. */
export function readPaidOrderPermission(sql:AuthoritySql,raw:unknown){
  const orderId=(raw as {orderId?:unknown}|null)?.orderId;
  if(typeof orderId!=="string"||!entityId.test(orderId))
    throw Error("invalid_paid_order_permission_request");
  const denied=sql.exec("SELECT 1 ok FROM cove_paid_refunded_orders WHERE order_id=? LIMIT 1",
    orderId).toArray().length>0;
  return {schema:"cove.paid-order-permission.v1",orderId,allowed:!denied};
}
export function captureEntitlementEpoch(sql:AuthoritySql,raw:unknown) {
  const q=validatePaidEntitlementScope(raw);
  const prior=current(sql,q.entitlementId);
  if(prior &&(prior.user_id!==q.userId||prior.product_id!==q.productId))
    throw Error("paid_entitlement_scope_changed");
  return prior?.epoch??0;
}
export function denyPaidEntitlement(sql:AuthoritySql,raw:unknown){
  const scope=validatePaidEntitlementScope(raw);
  const op=(raw as Record<string,unknown>).operationId;
  if(typeof op!=="string"||!opIdPattern.test(op))throw Error("invalid_entitlement_denial_op");
  const oldOp=sql.exec<{entitlement_id:string;epoch:number}>(
    "SELECT entitlement_id,epoch FROM cove_paid_entitlement_ops WHERE operation_id=?",op
  ).toArray()[0];
  const prior=current(sql,scope.entitlementId);
  if(prior &&(prior.user_id!==scope.userId||prior.product_id!==scope.productId))
    throw Error("paid_entitlement_scope_changed");
  if(oldOp){
    if(oldOp.entitlement_id!==scope.entitlementId)
      throw Error("paid_entitlement_denial_collision");
    return {applied:!!prior&&prior.verdict==="deny"&&prior.epoch>=oldOp.epoch,
      epoch:oldOp.epoch};
  }
  const epoch=(prior?.epoch??0)+1;
  if(!Number.isSafeInteger(epoch))throw Error("paid_entitlement_epoch_exhausted");
  sql.exec(`INSERT INTO cove_paid_entitlement_authority(
    entitlement_id,user_id,product_id,epoch,verdict,product_epoch,valid_until)
    VALUES(?,?,?,?,'deny',NULL,NULL)
    ON CONFLICT(entitlement_id) DO UPDATE SET epoch=excluded.epoch,
      verdict='deny',product_epoch=NULL,valid_until=NULL`,
    scope.entitlementId,scope.userId,scope.productId,epoch
  );
  sql.exec("INSERT INTO cove_paid_entitlement_ops(operation_id,entitlement_id,epoch) VALUES(?,?,?)",
    op,scope.entitlementId,epoch);
  return {applied:true,epoch};
}
/**
 * A full-order refund must not leave one paid entitlement unfenced while
 * another is already revoked. Caller encloses the entire batch in SQLite
 * transactionSync. Keys and scope are generated by the private writer from
 * canonical entitlements, not accepted from a browser.
 */
export function denyPaidEntitlementsBatch(sql:AuthoritySql,raw:unknown){
  if(!raw||typeof raw!=="object"||Array.isArray(raw))
    throw Error("invalid_paid_entitlement_batch");
  const operations=(raw as {operations?:unknown}).operations;
  if(!Array.isArray(operations)||!operations.length||operations.length>25)
    throw Error("invalid_paid_entitlement_batch");
  const seen=new Set<string>(),events=new Set<string>();
  const validated=operations.map(item=>{
    const scope=validatePaidEntitlementScope(item);
    const operationId=(item as {operationId?:unknown}).operationId;
    if(typeof operationId!=="string"||!opIdPattern.test(operationId)||
       seen.has(scope.entitlementId)||events.has(operationId))
      throw Error("invalid_paid_entitlement_batch");
    seen.add(scope.entitlementId);events.add(operationId);
    return {...scope,operationId};
  });
  const receipts=validated.map(op=>({
    entitlementId:op.entitlementId,
    ...denyPaidEntitlement(sql,op)
  }));
  if(receipts.some(r=>!r.applied))
    throw Error("paid_entitlement_batch_superseded");
  return {applied:true,receipts};
}
export function publishFreshEntitlement(
  sql:AuthoritySql,raw:unknown,expectedEpoch:number,now=Date.now()
){
  const scope=validatePaidEntitlementScope(raw);
  const {validUntil,productEpoch,orderId}=raw as {
    validUntil?:unknown;productEpoch?:unknown;orderId?:unknown
  };
  if(typeof orderId!=="string"||!entityId.test(orderId))
    throw Error("invalid_entitlement_order");
  if(!Number.isSafeInteger(productEpoch)||Number(productEpoch)<=0)
    throw Error("invalid_entitlement_product_epoch");
  if(typeof validUntil!=="string"||
     !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(validUntil)||
     !Number.isFinite(Date.parse(validUntil))||
     Date.parse(validUntil)<=now||Date.parse(validUntil)>now+30*60000)
    throw Error("invalid_entitlement_lease");
  if(!Number.isSafeInteger(expectedEpoch)||expectedEpoch<0)
    throw Error("invalid_entitlement_base_epoch");
  const market=raw as {territory?:unknown;channel?:unknown};
  if(typeof market.territory!=="string" || !/^[A-Z]{2}$/.test(market.territory) ||
     !["retail","subscription","library"].includes(String(market.channel)))
    throw Error("invalid_entitlement_market");
  // A canonical D1 verification may have awaited several services. In that
  // interval the owner may have accepted a paid contract/grant withdrawal.
  // Recheck CURRENT product permission inside the SAME synchronous owner
  // transaction as the buyer write; a stale positive receipt is forbidden.
  const currentRights=readCommercialProofs(sql,[scope.productId],
    market.territory,market.channel as CommercialChannel);
  if(currentRights.length!==1||currentRights[0].epoch!==Number(productEpoch))
    throw Error("paid_entitlement_product_epoch_stale");
  const right=currentRights[0];
  if(typeof right.contract_id!=="string" || typeof right.contract_version_id!=="string")
    throw Error("paid_entitlement_contract_missing");
  const priorScope=sql.exec<{
    territory:string;channel:string;edition_id:string;grant_id:string;
    contract_id:string;contract_version_id:string
  }>(`SELECT territory,channel,edition_id,grant_id,contract_id,contract_version_id
      FROM cove_paid_entitlement_scopes WHERE entitlement_id=?`,
    scope.entitlementId).toArray()[0];
  if(priorScope && (
    priorScope.territory!==market.territory ||
    priorScope.channel!==market.channel ||
    priorScope.edition_id!==right.edition_id ||
    priorScope.grant_id!==right.grant_id ||
    priorScope.contract_id!==right.contract_id ||
    priorScope.contract_version_id!==right.contract_version_id
  ))throw Error("paid_entitlement_acquisition_scope_changed");
  const prior=current(sql,scope.entitlementId);
  if(prior &&(prior.user_id!==scope.userId||prior.product_id!==scope.productId))
    throw Error("paid_entitlement_scope_changed");
  if(sql.exec("SELECT order_id FROM cove_paid_refunded_orders WHERE order_id=?",orderId).toArray().length)
    throw Error("paid_order_already_revoked");
  if(sql.exec("SELECT 1 ok FROM cove_paid_settlement_commands WHERE order_id=? AND state='pending'",orderId).toArray().length)
    throw Error("paid_order_settlement_incomplete");
  // A denial is terminal for THIS entitlement ID. Otherwise a lagging
  // canonical entitlement row could reauthorize the same refunded or held
  // buyer immediately after an acknowledged owner-first withdrawal.
  // Legitimate reinstatement requires a separately verified new entitlement
  // identity and immutable purchase receipt, never replay of this ID.
  if(prior?.verdict==="deny")
    throw Error("paid_entitlement_revocation_terminal");
  const previousOrder=sql.exec<{order_id:string}>(
    "SELECT order_id FROM cove_paid_entitlement_orders WHERE entitlement_id=?",
    scope.entitlementId
  ).toArray()[0];
  // A purchase entitlement belongs permanently to ONE canonical order.
  // A refund cannot be escaped by reusing its entitlement ID with a new
  // receipt. A genuinely new purchase needs a distinct entitlement ID.
  if(previousOrder && previousOrder.order_id!==orderId)
    throw Error("paid_entitlement_order_swap_forbidden");
  if((prior?.epoch??0)!==expectedEpoch)
    return {applied:false,epoch:prior?.epoch??null};
  // A fresh *verified* lease for the identical buyer and product epoch is
  // a renewal, not a new grant. Keep the entitlement epoch stable to avoid
  // gratuitous consumer/token invalidation every five minutes. An owner
  // denial or a new product rights epoch still requires a new epoch.
  const sameGrant=prior?.verdict==="allow"&&
    prior.product_epoch===Number(productEpoch)&&previousOrder?.order_id===orderId;
  const epoch=sameGrant?expectedEpoch:expectedEpoch+1;
  if(!Number.isSafeInteger(epoch)||epoch<=0)
    throw Error("paid_entitlement_epoch_exhausted");
  sql.exec(`INSERT INTO cove_paid_entitlement_authority(
    entitlement_id,user_id,product_id,epoch,verdict,product_epoch,valid_until)
    VALUES(?,?,?,?,'allow',?,?)
    ON CONFLICT(entitlement_id) DO UPDATE SET epoch=excluded.epoch,
      verdict='allow',product_epoch=excluded.product_epoch,valid_until=excluded.valid_until`,
    scope.entitlementId,scope.userId,scope.productId,epoch,Number(productEpoch),validUntil
  );
  sql.exec(`INSERT INTO cove_paid_entitlement_orders(entitlement_id,order_id)
    VALUES(?,?) ON CONFLICT(entitlement_id) DO UPDATE
    SET order_id=excluded.order_id`,scope.entitlementId,orderId);
  sql.exec(`INSERT INTO cove_paid_entitlement_scopes(
    entitlement_id,territory,channel,edition_id,grant_id,contract_id,contract_version_id)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(entitlement_id) DO NOTHING`,
    scope.entitlementId,market.territory,market.channel as CommercialChannel,
    right.edition_id,right.grant_id,right.contract_id,right.contract_version_id);
  return {applied:true,epoch};
}
/**
 * Product legality and buyer entitlement checked from one SQLite snapshot.
 * A contract/product withdrawal or a refund revocation invalidates access
 * immediately without KV propagation and without a primary D1 read.
 */
export function readPaidAccess(sql:AuthoritySql,raw:unknown,now=new Date().toISOString()){
  const input=raw as {territory?:unknown;channel?:unknown};
  const scope=validatePaidEntitlementScope(raw);
  if(!input||typeof input.territory!=="string"||
     !/^[A-Z]{2}$/.test(input.territory)||
     !["retail","subscription","library"].includes(String(input.channel))||
     !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(now))
    throw Error("invalid_paid_access_request");
  const rows=sql.exec<{
    entitlement_id:string;user_id:string;product_id:string;order_id:string;
    territory:string;channel:string;edition_id:string;grant_id:string;
    contract_id:string|null;contract_version_id:string|null;
    product_epoch:number;entitlement_epoch:number;valid_until:string
  }>(`SELECT e.entitlement_id,e.user_id,e.product_id,eo.order_id,
            p.territory,p.channel,p.edition_id,p.grant_id,
            p.contract_id,p.contract_version_id,
            p.epoch product_epoch,e.epoch entitlement_epoch,
            CASE WHEN e.valid_until<p.valid_until THEN e.valid_until ELSE p.valid_until END valid_until
     FROM cove_paid_entitlement_authority e
     JOIN cove_paid_entitlement_orders eo ON eo.entitlement_id=e.entitlement_id
     JOIN cove_paid_entitlement_scopes s ON s.entitlement_id=e.entitlement_id
     JOIN cove_commercial_scope_proofs p ON p.product_id=e.product_id
       AND p.territory=s.territory AND p.channel=s.channel
       AND p.edition_id=s.edition_id AND p.grant_id=s.grant_id
       AND p.contract_id=s.contract_id AND p.contract_version_id=s.contract_version_id
     JOIN cove_commercial_authority a
       ON a.product_id=p.product_id AND a.epoch=p.epoch AND a.verdict='allow'
     AND e.product_epoch=p.epoch
     WHERE e.entitlement_id=? AND e.user_id=? AND e.product_id=? AND e.verdict='allow'
       AND NOT EXISTS(SELECT 1 FROM cove_paid_refunded_orders d WHERE d.order_id=eo.order_id)
       AND NOT EXISTS(SELECT 1 FROM cove_paid_settlement_commands sc WHERE sc.order_id=eo.order_id AND sc.state='pending')
       AND NOT EXISTS(SELECT 1 FROM cove_commercial_subject_denials sd
         WHERE (sd.subject_kind='grant' AND sd.subject_id=p.grant_id)
            OR (sd.subject_kind='contract' AND sd.subject_id=p.contract_id))
       AND e.valid_until>? AND p.valid_until>?
       AND p.contract_id IS NOT NULL AND length(p.contract_id)>=3
       AND p.contract_version_id IS NOT NULL AND length(p.contract_version_id)>=3
       AND p.territory=? AND p.channel=? LIMIT 1`,
    scope.entitlementId,scope.userId,scope.productId,now,now,
    input.territory,input.channel as CommercialChannel
  ).toArray();
  return rows[0]??null;
}
