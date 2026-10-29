/* eslint-disable prettier/prettier -- Legal contract proofs require explicit, deterministic revocation semantics. */
import type { AuthoritySql } from "./legal-authority-core";

/** Paid rights are NOT Gutenberg: no public domain fallback, no inferred entitlement. */
export const commercialProductId=/^prd_[a-zA-Z0-9_-]{3,120}$/;
export type CommercialChannel="retail"|"subscription"|"library";
const territoryPattern=/^[A-Z]{2}$/;
const isoTime=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
export type CommercialProof={
  productId:string;editionId:string;territory:string;channel:CommercialChannel;
  grantId:string;contractId:string|null;contractVersionId:string|null;
  validUntil:string;
};
export function validateCommercialProof(p:CommercialProof,now=Date.now()) {
  if(!p||!commercialProductId.test(p.productId) ||
     p.productId.startsWith("prd_gutenberg_") ||
     typeof p.editionId!=="string"|| !/^[a-zA-Z0-9_-]{3,160}$/.test(p.editionId) ||
     !territoryPattern.test(p.territory) ||
     !["retail","subscription","library"].includes(p.channel) ||
     !/^[a-zA-Z0-9_-]{3,180}$/.test(p.grantId) ||
     // Paid distribution requires a specific effective contract VERSION.
     // A missing contract must never be accepted as public-domain proof.
     typeof p.contractId!=="string" ||
     !/^[a-zA-Z0-9_-]{3,180}$/.test(p.contractId) ||
     typeof p.contractVersionId!=="string" ||
     !/^[a-zA-Z0-9_-]{3,180}$/.test(p.contractVersionId) ||
     typeof p.validUntil!=="string"||!isoTime.test(p.validUntil) ||
     !Number.isFinite(Date.parse(p.validUntil)) ||
     Date.parse(p.validUntil)<=now ||
     Date.parse(p.validUntil)>now+24*3600*1000
  )throw Error("invalid_commercial_proof");
  return p;
}
export function createCommercialAuthoritySchema(sql:AuthoritySql){
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_commercial_authority(
    product_id TEXT PRIMARY KEY,
    epoch INTEGER NOT NULL CHECK(epoch>0),
    verdict TEXT NOT NULL CHECK(verdict IN ('deny','allow'))
  ) WITHOUT ROWID`);
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_commercial_scope_proofs(
    product_id TEXT NOT NULL,territory TEXT NOT NULL,channel TEXT NOT NULL,
    epoch INTEGER NOT NULL CHECK(epoch>0),
    edition_id TEXT NOT NULL,grant_id TEXT NOT NULL,
    contract_id TEXT,contract_version_id TEXT,
    valid_until TEXT NOT NULL,
    PRIMARY KEY(product_id,territory,channel)
  ) WITHOUT ROWID`);
  // A rights-level withdrawal permanently retires each observed legal
  // identity. Scope rows are reusable storage for current epochs, so checking
  // only those rows would permit an ABA regrant after two successive contract
  // replacements. Product-level retail holds deliberately do not retire them.
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_commercial_retired_evidence(
    product_id TEXT NOT NULL,grant_id TEXT NOT NULL,
    contract_id TEXT NOT NULL,contract_version_id TEXT NOT NULL,
    PRIMARY KEY(product_id,grant_id,contract_id,contract_version_id)
  ) WITHOUT ROWID`);
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_commercial_withdrawal_ops(
    operation_id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    epoch INTEGER NOT NULL CHECK(epoch>0)
  ) WITHOUT ROWID`);
  // One contract may cover thousands of editions. Subject tombstones make
  // withdrawal O(1) and immediately effective for ALL stored product proofs,
  // without bounded product fanout or eventually-consistent invalidations.
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_commercial_subject_denials(
    subject_kind TEXT NOT NULL CHECK(subject_kind IN ('grant','contract')),
    subject_id TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY(subject_kind,subject_id)
  ) WITHOUT ROWID`);
  // Record EVERY accepted replay identity, not merely the first operation
  // that withdrew a subject. Otherwise a later operationId could be reused
  // against a different contract after an idempotent second suspension.
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_commercial_subject_denial_ops(
    operation_id TEXT PRIMARY KEY,
    subject_kind TEXT NOT NULL,
    subject_id TEXT NOT NULL
  ) WITHOUT ROWID`);
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_publication_commands(
    operation_id TEXT PRIMARY KEY,product_id TEXT NOT NULL,
    command_sha256 TEXT NOT NULL,epoch INTEGER NOT NULL CHECK(epoch>0),
    state TEXT NOT NULL CHECK(state IN ('pending','committed')),
    result_json TEXT,published_epoch INTEGER,recovery_json TEXT
  ) WITHOUT ROWID`);
  const commandSchema=sql.exec<{sql:string}>(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='cove_publication_commands'").toArray()[0];
  if(!/\brecovery_json\s+TEXT\b/i.test(commandSchema?.sql||""))
    sql.exec("ALTER TABLE cove_publication_commands ADD COLUMN recovery_json TEXT");
  sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS cove_publication_one_pending_product
    ON cove_publication_commands(product_id) WHERE state='pending'`);
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_publication_recovery_scan(
    id INTEGER PRIMARY KEY CHECK(id=1),after_operation_id TEXT NOT NULL
  )`);
  sql.exec("INSERT OR IGNORE INTO cove_publication_recovery_scan(id,after_operation_id) VALUES(1,'')");
}
type EpochRow={epoch:number;verdict:"deny"|"allow"};
const current=(sql:AuthoritySql,id:string)=>
  sql.exec<EpochRow>(
    "SELECT epoch,verdict FROM cove_commercial_authority WHERE product_id=?",id
  ).toArray()[0];
function validId(id:unknown){
  if(typeof id!=="string"||!commercialProductId.test(id)||id.startsWith("prd_gutenberg_"))
    throw Error("invalid_commercial_product");
  return id;
}
export function denyCommercialProduct(sql:AuthoritySql,raw:unknown) {
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw Error("invalid_commercial_denial");
  const {productId,operationId}=raw as Record<string,unknown>;
  const id=validId(productId);
  if(typeof operationId!=="string"||
     !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(operationId))
    throw Error("invalid_commercial_denial");
  const existing=sql.exec<{product_id:string;epoch:number}>(
    "SELECT product_id,epoch FROM cove_commercial_withdrawal_ops WHERE operation_id=?",
    operationId
  ).toArray()[0];
  const state=current(sql,id);
  if(existing) {
    if(existing.product_id!==id)throw Error("commercial_denial_scope_collision");
    return {applied:!!state && state.verdict==="deny"&&state.epoch>=existing.epoch,
      epoch:existing.epoch};
  }
  const epoch=(state?.epoch??0)+1;
  if(!Number.isSafeInteger(epoch)||epoch<=0)throw Error("commercial_epoch_exhausted");
  if(!operationId.startsWith("retail:")){
    // Execute in the same DO storage transaction as the owner denial. Do not
    // lose obsolete evidence when a later grant overwrites the current scope.
    sql.exec(`INSERT OR IGNORE INTO cove_commercial_retired_evidence(
      product_id,grant_id,contract_id,contract_version_id)
      SELECT product_id,grant_id,contract_id,contract_version_id
        FROM cove_commercial_scope_proofs
        WHERE product_id=? AND contract_id IS NOT NULL
          AND contract_version_id IS NOT NULL`,id);
  }
  sql.exec(`INSERT INTO cove_commercial_authority(product_id,epoch,verdict)
    VALUES(?,?,'deny') ON CONFLICT(product_id) DO UPDATE SET
    epoch=excluded.epoch,verdict='deny'`,id,epoch);
  sql.exec(
    "INSERT INTO cove_commercial_withdrawal_ops(operation_id,product_id,epoch) VALUES(?,?,?)",
    operationId,id,epoch
  );
  return {applied:true,epoch};
}
/**
 * Batch contract/grant revocations serialize in one owner transaction.
 * The SQL transaction is supplied by the DO and MUST roll back if any old
 * event has since been superseded by a fresh authorized publication.
 */
export function validateCommercialDenialBatch(raw:unknown){
  if(!raw||typeof raw!=="object"||Array.isArray(raw))
    throw Error("invalid_commercial_denial_batch");
  const ops=(raw as {operations?:unknown}).operations;
  if(!Array.isArray(ops)||ops.length<1||ops.length>25)
    throw Error("invalid_commercial_denial_batch");
  const ids=new Set<string>(),events=new Set<string>();
  return ops.map(item=>{
    if(!item||typeof item!=="object"||Array.isArray(item))
      throw Error("invalid_commercial_denial_batch");
    const op=item as {productId?:unknown;operationId?:unknown};
    const productId=validId(op.productId);
    if(typeof op.operationId!=="string"||
       !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(op.operationId)||
       ids.has(productId)||events.has(op.operationId))
      throw Error("invalid_commercial_denial_batch");
    ids.add(productId);events.add(op.operationId);
    return {productId,operationId:op.operationId};
  });
}
export function denyCommercialProductsBatch(sql:AuthoritySql,raw:unknown){
  const operations=validateCommercialDenialBatch(raw);
  const receipts=operations.map(op=>({productId:op.productId,
    operationId:op.operationId,...denyCommercialProduct(sql,op)}));
  if(receipts.some(r=>!r.applied))
    throw Error("commercial_denial_batch_superseded");
  return {applied:true,receipts};
}
/**
 * Permanent subject-level veto, idempotent by operation ID. A legally
 * reverified replacement must have a NEW grant or contract identity; merely
 * refreshing a product's epoch cannot revive a withdrawn subject.
 */
export function denyCommercialSubject(sql:AuthoritySql,raw:unknown){
  if(!raw||typeof raw!=="object"||Array.isArray(raw))
    throw Error("invalid_commercial_subject_denial");
  const {subjectKind,subjectId,operationId}=raw as Record<string,unknown>;
  if((subjectKind!=="grant"&&subjectKind!=="contract")||
     typeof subjectId!=="string"||
     !/^[a-zA-Z0-9_-]{3,180}$/.test(subjectId)||
     typeof operationId!=="string"||
     !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(operationId))
    throw Error("invalid_commercial_subject_denial");
  const oldOp=sql.exec<{
    subject_kind:string;subject_id:string
  }>("SELECT subject_kind,subject_id FROM cove_commercial_subject_denial_ops WHERE operation_id=?",
    operationId).toArray()[0];
  if(oldOp&&(oldOp.subject_kind!==subjectKind||oldOp.subject_id!==subjectId))
    throw Error("commercial_subject_op_scope_collision");
  const oldSubject=sql.exec<{operation_id:string}>(
    "SELECT operation_id FROM cove_commercial_subject_denials WHERE subject_kind=? AND subject_id=?",
    subjectKind,subjectId).toArray()[0];
  if(!oldSubject)sql.exec(
    "INSERT INTO cove_commercial_subject_denials(subject_kind,subject_id,operation_id) VALUES(?,?,?)",
    subjectKind,subjectId,operationId
  );
  if(!oldOp)sql.exec(
    "INSERT INTO cove_commercial_subject_denial_ops(operation_id,subject_kind,subject_id) VALUES(?,?,?)",
    operationId,subjectKind,subjectId
  );
  return {applied:true,subjectKind,subjectId};
}
/** A slow canonical verification cannot regrant after an acknowledged withdrawal. */
export function captureCommercialEpoch(sql:AuthoritySql,raw:unknown) {
  const id=validId((raw as {productId?:unknown})?.productId);
  return current(sql,id)?.epoch??0;
}
export function publishFreshCommercialProof(
  sql:AuthoritySql,p:CommercialProof,expectedEpoch:number,now=Date.now()
){
  validateCommercialProof(p,now);
  // Primary publication updates span multiple canonical tables. The owner
  // keeps the product denied for the WHOLE command, including external I/O
  // and retry recovery, so an independent positive verifier cannot observe
  // and publish an intermediate primary state.
  if(sql.exec("SELECT 1 pending FROM cove_publication_commands WHERE product_id=? AND state='pending' LIMIT 1",
    p.productId).toArray().length)
    throw Error("commercial_publication_command_pending");
  if(sql.exec("SELECT 1 ok FROM cove_commercial_subject_denials WHERE (subject_kind='grant' AND subject_id=?) OR (subject_kind='contract' AND subject_id=?) LIMIT 1",
    p.grantId,p.contractId).toArray().length)
    throw Error("commercial_subject_withdrawal_terminal");
  if(!Number.isSafeInteger(expectedEpoch)||expectedEpoch<0)
    throw Error("commercial_invalid_base_epoch");
  const state=current(sql,p.productId);
  if((state?.epoch??0)!==expectedEpoch)
    return {applied:false,epoch:state?.epoch??null};
  // Preserve CAS/replay semantics for stale verification requests; only a
  // contemporaneous positive attempt needs legal-evidence inspection.
  if(sql.exec("SELECT 1 retired FROM cove_commercial_retired_evidence WHERE product_id=? AND grant_id=? AND contract_id=? AND contract_version_id=? LIMIT 1",
    p.productId,p.grantId,p.contractId,p.contractVersionId).toArray().length)
    throw Error("commercial_reinstatement_requires_new_legal_evidence");
  // A legal withdrawal is durable before its primary-D1 reconciliation.
  // If D1 is unavailable, the prior grant/version can still appear active.
  // Never treat another lookup of that SAME evidence as reinstatement.
  // Price-only (retail:) product holds are different: they do not withdraw
  // distribution rights, and legitimately permit repricing on the same grant.
  if(state?.verdict==="deny"){
    const withdrawal=sql.exec<{operation_id:string}>(
      "SELECT operation_id FROM cove_commercial_withdrawal_ops WHERE product_id=? AND epoch=?",
      p.productId,state.epoch
    ).toArray()[0];
    if(!withdrawal)throw Error("commercial_denial_provenance_missing");
    if(!withdrawal.operation_id.startsWith("retail:")){
      const reused=sql.exec(
        `SELECT 1 stale FROM cove_commercial_scope_proofs
          WHERE product_id=? AND grant_id=?
            AND contract_id=? AND contract_version_id=? LIMIT 1`,
        p.productId,p.grantId,p.contractId,p.contractVersionId
      ).toArray();
      if(reused.length)
        throw Error("commercial_reinstatement_requires_new_legal_evidence");
    }
  }
  const old=sql.exec<{
    epoch:number;edition_id:string;grant_id:string;
    contract_id:string|null;contract_version_id:string|null
  }>("SELECT epoch,edition_id,grant_id,contract_id,contract_version_id FROM cove_commercial_scope_proofs WHERE product_id=? AND territory=? AND channel=?",
    p.productId,p.territory,p.channel).toArray()[0];
  // Positive refreshes of an unchanged exact grant must NOT invalidate
  // every paid buyer's entitlement. Global epochs advance only on genuine
  // legal withdrawal/reinstatement; new markets can publish independently.
  // A changed grant/contract in the SAME currently allowed epoch is illegal
  // without a prior owner DENY, even if primary D1 appears to approve it.
  if(state?.verdict==="allow"&&old?.epoch===state.epoch&&
     (old.edition_id!==p.editionId || old.grant_id!==p.grantId||
      old.contract_id!==p.contractId||
      old.contract_version_id!==p.contractVersionId))
    throw Error("commercial_rights_change_requires_prior_denial");
  const epoch=state?.verdict==="allow"?state.epoch:expectedEpoch+1;
  if(!Number.isSafeInteger(epoch)||epoch<=0)
    throw Error("commercial_epoch_exhausted");
  // Same SQLite transaction: one current owner epoch and exact canonical grant.
  sql.exec(`INSERT INTO cove_commercial_authority(product_id,epoch,verdict)
    VALUES(?,?,'allow') ON CONFLICT(product_id) DO UPDATE SET
    epoch=excluded.epoch,verdict='allow'`,p.productId,epoch);
  sql.exec(`INSERT INTO cove_commercial_scope_proofs(
    product_id,territory,channel,epoch,edition_id,grant_id,
    contract_id,contract_version_id,valid_until)
    VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(product_id,territory,channel) DO UPDATE SET
    epoch=excluded.epoch,edition_id=excluded.edition_id,
    grant_id=excluded.grant_id,contract_id=excluded.contract_id,
    contract_version_id=excluded.contract_version_id,valid_until=excluded.valid_until`,
    p.productId,p.territory,p.channel,epoch,p.editionId,p.grantId,
    p.contractId,p.contractVersionId,p.validUntil
  );
  return {applied:true,epoch};
}
export type CommercialReadRow={
  product_id:string;edition_id:string;grant_id:string;
  contract_id:string|null;contract_version_id:string|null;
  valid_until:string;epoch:number;
};
/** ONE SQLite query for up to 25 purchases; no D1, KV or cache staleness. */
export function readCommercialProofs(
  sql:AuthoritySql,ids:string[],territory:string,channel:CommercialChannel,now=new Date().toISOString()
):CommercialReadRow[] {
  if(!Array.isArray(ids)||ids.length>25||
     ids.some(id=>typeof id!=="string"||!commercialProductId.test(id)||
       id.startsWith("prd_gutenberg_")) ||
     new Set(ids).size!==ids.length ||
     !territoryPattern.test(territory)||
     !["retail","subscription","library"].includes(channel)||
     typeof now!=="string"||!isoTime.test(now))throw Error("invalid_commercial_batch");
  if(!ids.length)return [];
  return sql.exec<CommercialReadRow>(
    `SELECT p.product_id,p.edition_id,p.grant_id,p.contract_id,
            p.contract_version_id,p.valid_until,p.epoch
     FROM json_each(?) candidate
     JOIN cove_commercial_scope_proofs p
       ON p.product_id=candidate.value AND p.territory=? AND p.channel=?
     JOIN cove_commercial_authority a
       ON a.product_id=p.product_id AND a.epoch=p.epoch AND a.verdict='allow'
     WHERE p.valid_until>?
       AND NOT EXISTS(SELECT 1 FROM cove_commercial_subject_denials s
         WHERE (s.subject_kind='grant' AND s.subject_id=p.grant_id)
           OR (s.subject_kind='contract' AND s.subject_id=p.contract_id))
       AND p.contract_id IS NOT NULL AND length(p.contract_id)>=3
       AND p.contract_version_id IS NOT NULL AND length(p.contract_version_id)>=3
     ORDER BY CAST(candidate.key AS INTEGER) LIMIT 25`,
    JSON.stringify(ids),territory,channel,now
  ).toArray();
}
