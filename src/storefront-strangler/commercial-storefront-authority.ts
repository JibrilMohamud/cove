/* eslint-disable prettier/prettier -- Verified paid-offer snapshots share the immutable legal-owner transaction boundary. */
import type {AuthoritySql} from "./legal-authority-core";
import {readCommercialProofs,type CommercialReadRow} from "./commercial-legal-core";

type PaidDisplay={
  product_id:string;edition_id:string;product_public_id:string|null;
  edition_public_id:string|null;offer_json:string;
};
export type PaidOfferPublication=PaidDisplay&{
  territory:string;currency:string;rights_epoch:number;
  grant_id:string;contract_id:string;contract_version_id:string;
  valid_until:string;
};
const entity=/^[a-zA-Z0-9_-]{3,160}$/;
const product=/^prd_[a-zA-Z0-9_-]{3,120}$/;
const dateUtc=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
export function createCommercialStorefrontSchema(sql:AuthoritySql){
  sql.exec(`CREATE TABLE IF NOT EXISTS cove_commercial_storefront_proofs(
    product_id TEXT NOT NULL,territory TEXT NOT NULL,currency TEXT NOT NULL,
    rights_epoch INTEGER NOT NULL CHECK(rights_epoch>0),
    edition_id TEXT NOT NULL,grant_id TEXT NOT NULL,
    contract_id TEXT NOT NULL,contract_version_id TEXT NOT NULL,
    product_public_id TEXT,edition_public_id TEXT,
    offer_json TEXT NOT NULL,valid_until TEXT NOT NULL,
    PRIMARY KEY(product_id,territory,currency)
  ) WITHOUT ROWID`);
}
export function validatePaidOffer(p:PaidOfferPublication,now=Date.now()){
  if(!p||typeof p!=="object"||
     !product.test(p.product_id)||p.product_id.startsWith("prd_gutenberg_")||
     !entity.test(p.edition_id)||!entity.test(p.grant_id)||
     !entity.test(p.contract_id)||!entity.test(p.contract_version_id)||
     !/^[A-Z]{2}$/.test(p.territory)||!/^[A-Z]{3}$/.test(p.currency)||
     !Number.isSafeInteger(p.rights_epoch)||p.rights_epoch<=0||
     (p.product_public_id!==null&&
       (typeof p.product_public_id!=="string"||p.product_public_id.length>160))||
     (p.edition_public_id!==null&&
       (typeof p.edition_public_id!=="string"||p.edition_public_id.length>160))||
     typeof p.offer_json!=="string"||p.offer_json.length>512||
     typeof p.valid_until!=="string"||!dateUtc.test(p.valid_until)||
     !Number.isFinite(Date.parse(p.valid_until))||
     Date.parse(p.valid_until)<=now||Date.parse(p.valid_until)>now+5*60_000)
    throw Error("invalid_paid_storefront_publication");
  let offer:unknown;
  try{offer=JSON.parse(p.offer_json);}catch{throw Error("invalid_paid_retail_offer");}
  const o=offer as Record<string,unknown>|null;
  if(!o||Array.isArray(o)||o.currency!==p.currency||
     typeof o.type!=="string"||!/^[a-z][a-z0-9_-]{2,39}$/.test(o.type)||
     o.type==="public-domain"||
     !Number.isSafeInteger(o.amountMinor)||(o.amountMinor as number)<0||
     Object.keys(o).sort().join(",")!=="amountMinor,currency,type")
    throw Error("invalid_paid_retail_offer");
  return p;
}
/**
 * Run ONLY inside owner SQLite transaction AFTER primary D1 product/offer
 * verification and fresh owner read-rights proof. A D1 await may interleave
 * with a withdrawal; the epoch/identity check here makes the final commit
 * reject that race. The paid snapshot itself grants NO customer access.
 */
export function publishCommercialStorefront(
  sql:AuthoritySql,p:PaidOfferPublication,now=Date.now()
){
  validatePaidOffer(p,now);
  const right=readCommercialProofs(sql,[p.product_id],p.territory,"retail",
    new Date(now).toISOString())[0] as CommercialReadRow|undefined;
  if(!right||right.epoch!==p.rights_epoch||
     right.edition_id!==p.edition_id||right.grant_id!==p.grant_id||
     right.contract_id!==p.contract_id||
     right.contract_version_id!==p.contract_version_id||
     Date.parse(right.valid_until)<Date.parse(p.valid_until))
    throw Error("commercial_storefront_owner_proof_changed");
  const old=sql.exec<PaidOfferPublication>(
    `SELECT product_id,territory,currency,rights_epoch,edition_id,grant_id,
            contract_id,contract_version_id,product_public_id,edition_public_id,
            offer_json,valid_until
       FROM cove_commercial_storefront_proofs
       WHERE product_id=? AND territory=? AND currency=?`,
    p.product_id,p.territory,p.currency).toArray()[0];
  // A retail owner-first withdrawal may be acknowledged while the
  // canonical D1 offer deactivation is still in flight. The old D1 row
  // can therefore look active to a later positive publisher. Crossing an
  // owner epoch with an UNCHANGED price and legal grant is not fresh
  // publication evidence: refuse to resurrect the withdrawn offer.
  if(old&&old.rights_epoch!==p.rights_epoch&&
     old.offer_json===p.offer_json&&
     old.grant_id===p.grant_id&&
     old.contract_id===p.contract_id&&
     old.contract_version_id===p.contract_version_id){
    // An ordinary publication transition (for example preorder -> live or
    // an approved metadata revision) may retain its exact price and rights.
    // Only a completed, independently verified owner command can distinguish
    // that edit hold from an unreconciled retail withdrawal. A prefix alone,
    // a pending command or a journal for another epoch grants nothing.
    const publication=sql.exec(
      `SELECT 1 verified FROM cove_publication_commands command
       JOIN cove_commercial_withdrawal_ops withdrawal
         ON withdrawal.product_id=command.product_id
        AND withdrawal.epoch=command.epoch
        AND withdrawal.operation_id=('retail:publication:'||command.operation_id)
       WHERE command.product_id=? AND command.state='committed'
         AND command.epoch=? AND command.published_epoch IS NULL
         AND json_extract(command.result_json,'$.state') IN ('live','updated','preorder')
         AND json_extract(command.result_json,'$.publicationVersionId') IS NOT NULL
       LIMIT 1`,p.product_id,p.rights_epoch-1).toArray();
    if(publication.length!==1)
      throw Error("commercial_offer_reinstatement_requires_changed_evidence");
  }
  if(old&&old.rights_epoch===p.rights_epoch&&(
    old.edition_id!==p.edition_id||old.grant_id!==p.grant_id||
    old.contract_id!==p.contract_id||old.contract_version_id!==p.contract_version_id||
    old.product_public_id!==p.product_public_id||
    old.edition_public_id!==p.edition_public_id||old.offer_json!==p.offer_json))
    throw Error("commercial_offer_change_requires_owner_denial");
  sql.exec(`INSERT INTO cove_commercial_storefront_proofs(
      product_id,territory,currency,rights_epoch,edition_id,grant_id,
      contract_id,contract_version_id,product_public_id,edition_public_id,
      offer_json,valid_until
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(product_id,territory,currency) DO UPDATE SET
      rights_epoch=excluded.rights_epoch,edition_id=excluded.edition_id,
      grant_id=excluded.grant_id,contract_id=excluded.contract_id,
      contract_version_id=excluded.contract_version_id,
      product_public_id=excluded.product_public_id,
      edition_public_id=excluded.edition_public_id,
      offer_json=excluded.offer_json,valid_until=excluded.valid_until`,
    p.product_id,p.territory,p.currency,p.rights_epoch,p.edition_id,p.grant_id,
    p.contract_id,p.contract_version_id,p.product_public_id,p.edition_public_id,
    p.offer_json,p.valid_until);
  return {applied:true,epoch:p.rights_epoch};
}
/**
 * The authoritative paid storefront never consults KV, a D1 replica, or a
 * presentation snapshot for permission. A withdrawn contract, grant or
 * product epoch is excluded by the same SQLite query as the price proof.
 */
export function readCommercialStorefront(
 sql:AuthoritySql,ids:string[],territory:string,currency:string,
 now=new Date().toISOString()
):PaidDisplay[]{
  if(!Array.isArray(ids)||ids.length>128||
     ids.some(id=>typeof id!=="string"||!product.test(id)||
       id.startsWith("prd_gutenberg_"))||
     new Set(ids).size!==ids.length||!/^[A-Z]{2}$/.test(territory)||
     !/^[A-Z]{3}$/.test(currency)||!dateUtc.test(now))
    throw Error("invalid_paid_storefront_candidates");
  if(!ids.length)return [];
  return sql.exec<PaidDisplay>(`SELECT p.product_id,p.edition_id,
      p.product_public_id,p.edition_public_id,p.offer_json
    FROM json_each(?) candidate
    JOIN cove_commercial_storefront_proofs p
      ON p.product_id=candidate.value AND p.territory=? AND p.currency=?
    JOIN cove_commercial_scope_proofs legal
      ON legal.product_id=p.product_id AND legal.territory=p.territory
      AND legal.channel='retail'
      AND legal.epoch=p.rights_epoch AND legal.edition_id=p.edition_id
      AND legal.grant_id=p.grant_id AND legal.contract_id=p.contract_id
      AND legal.contract_version_id=p.contract_version_id
    JOIN cove_commercial_authority a
      ON a.product_id=p.product_id AND a.epoch=p.rights_epoch AND a.verdict='allow'
    WHERE p.valid_until>? AND legal.valid_until>?
      AND NOT EXISTS(SELECT 1 FROM cove_commercial_subject_denials denied
        WHERE (denied.subject_kind='grant' AND denied.subject_id=p.grant_id)
           OR (denied.subject_kind='contract' AND denied.subject_id=p.contract_id))
    ORDER BY CAST(candidate.key AS INTEGER) LIMIT 25`,
    JSON.stringify(ids),territory,currency,now,now).toArray();
}
