/* eslint-disable prettier/prettier -- Strict current legal baseline input boundary. */
import {createHash,createPublicKey,verify} from "node:crypto";

const fail=code=>{throw Error("current_baseline_"+code);};
const digest=x=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x);
const id=x=>typeof x==="string"&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/.test(x);
const int=x=>Number.isSafeInteger(x)&&x>=0;
const exact=(x,keys)=>!!x&&typeof x==="object"&&!Array.isArray(x)&&
  Object.keys(x).sort().join("|")===keys.split("|").sort().join("|");
function canonical(x){
  if(Array.isArray(x))return x.map(canonical);
  if(x&&typeof x==="object")return Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])]));
  return x;
}
export const hashCurrentBaseline=x=>createHash("sha256").update(JSON.stringify(canonical(x))).digest("hex");
const bytes=x=>Buffer.from(JSON.stringify(canonical(x)),"utf8");
const scopeKey=r=>JSON.stringify([r.productId,r.territory,r.format,r.channel]);
const sourceTerritory={pg_us:"US",pg_au:"AU",pg_ca:"CA"};
const rowFields="productId|territory|format|channel|source|sourceItemId|artifactSha256|policySha256|canonicalAllowed|outstandingHold";
const evidenceFields="productId|territory|format|channel|source|sourceItemId|artifactSha256|policySha256|decision|basisSha256|observedAtMs|validUntilMs";
const reviewFields="schema|issuer|inventorySha256|ownerEpoch|observedAtMs|validUntilMs|withdrawalCutoffMs|currentWithdrawalsReconciled|rows|signature";
const sourceSet=new Set(["pg_us","pg_au","pg_ca","pg_eu","contract"]);
const currentScope=r=>id(r.productId)&&/^[A-Z]{2}$/.test(r.territory)&&
  ["ebook","audiobook"].includes(r.format)&&["retail","subscription","library"].includes(r.channel)&&
  sourceSet.has(r.source)&&id(r.sourceItemId);
const sourceScope=r=>r.source==="contract"||r.source==="pg_eu"||
  (sourceTerritory[r.source]===r.territory&&r.format==="ebook");
function checkInventory(rows){
  if(!Array.isArray(rows)||!rows.length||rows.length>1000000)fail("inventory_size");
  const out=new Map();
  for(const r of rows){
    if(!exact(r,rowFields)||!currentScope(r)||
      !(r.artifactSha256===null||digest(r.artifactSha256))||
      !(r.policySha256===null||digest(r.policySha256))||
      typeof r.canonicalAllowed!=="boolean"||typeof r.outstandingHold!=="boolean")fail("inventory_shape");
    const k=scopeKey(r);
    if(out.has(k))fail("duplicate_scope");
    out.set(k,r);
  }
  return out;
}
function signer(trust){
  if(!trust||!id(trust.issuer)||!digest(trust.spkiSha256)||
    typeof trust.publicKeyPem!=="string"||trust.publicKeyPem.length>1500)fail("reviewer_unconfigured");
  const key=createPublicKey(trust.publicKeyPem);
  if(key.asymmetricKeyType!=="ec"||key.asymmetricKeyDetails?.namedCurve!=="prime256v1"||
    createHash("sha256").update(key.export({type:"spki",format:"der"})).digest("hex")!==trust.spkiSha256)
    fail("reviewer_pin");
  return key;
}
function checkReview(review,trust,inventorySha256,epoch,now){
  if(!exact(review,reviewFields)||review.schema!=="cove.current-legal-review.v1"||
    review.issuer!==trust.issuer||review.inventorySha256!==inventorySha256||
    review.ownerEpoch!==epoch||review.currentWithdrawalsReconciled!==true||
    !int(review.observedAtMs)||!int(review.validUntilMs)||!int(review.withdrawalCutoffMs)||
    review.observedAtMs>now||review.withdrawalCutoffMs<review.observedAtMs||
    review.withdrawalCutoffMs>now||now-review.withdrawalCutoffMs>trust.maxWithdrawalAgeMs||
    review.validUntilMs<=now||review.validUntilMs-review.observedAtMs>trust.maxReviewAgeMs||
    !Array.isArray(review.rows)||review.rows.length>1000000||
    typeof review.signature!=="string"||!/^[A-Za-z0-9_-]{80,110}$/.test(review.signature))fail("review_scope_or_time");
  const {signature,...payload}=review;
  const sig=Buffer.from(signature,"base64url");
  if(sig.toString("base64url")!==signature||!verify("sha256",bytes(payload),signer(trust),sig))
    fail("review_signature");
}
/**
 * Candidate-only current baseline. The complete current catalog, current
 * policy/artifact digests and deny/hold flags must be captured by a trusted
 * canonical owner adapter, never by the external reviewer. Independent
 * reviewer trust and inventory digest are pinned outside the review archive.
 * No historic chronology or legacy hash is treated as positive authority.
 * Any current denial/hold wins, even if a fresh external review says allow.
 * Missing evidence is a scope-specific quarantine, not a global error.
 * No serving or publication permission is granted by this module.
 */
export function compileCurrentLegalBaseline({inventory,review,trust,ownerEpoch,nowMs}){
  if(!int(ownerEpoch)||!int(nowMs)||!trust||!digest(trust.inventorySha256)||
    !int(trust.maxReviewAgeMs)||trust.maxReviewAgeMs<1||trust.maxReviewAgeMs>86400000||
    !int(trust.maxWithdrawalAgeMs)||trust.maxWithdrawalAgeMs<1||trust.maxWithdrawalAgeMs>900000)
    fail("trusted_input");
  const rows=checkInventory(inventory);
  const ordered=[...rows.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0);
  const inventorySha256=hashCurrentBaseline(ordered.map(([,r])=>r));
  if(inventorySha256!==trust.inventorySha256)fail("inventory_pin");
  checkReview(review,trust,inventorySha256,ownerEpoch,nowMs);
  const reviewed=new Map();
  for(const r of review.rows){
    if(!exact(r,evidenceFields)||!currentScope(r)||!digest(r.artifactSha256)||
      !digest(r.policySha256)||!digest(r.basisSha256)||!["allow","deny"].includes(r.decision)||
      !int(r.observedAtMs)||!int(r.validUntilMs)||r.observedAtMs>review.observedAtMs||
      r.validUntilMs>review.validUntilMs||r.validUntilMs<=r.observedAtMs||
      r.validUntilMs-r.observedAtMs>trust.maxReviewAgeMs)fail("evidence_shape");
    const k=scopeKey(r),current=rows.get(k);
    if(!current||reviewed.has(k)||current.source!==r.source||current.sourceItemId!==r.sourceItemId)
      fail("foreign_or_duplicate_evidence");
    reviewed.set(k,r);
  }
  const counts={candidateAllow:0,quarantine:0,reasons:{}};
  const decisions=ordered.map(([k,r])=>{
    const e=reviewed.get(k);
    const reason=r.outstandingHold?"current_hold":!r.canonicalAllowed?"canonical_deny":
      !sourceScope(r)?"source_scope_not_reviewed":!e?"missing_current_evidence":
      e.decision==="deny"?"external_deny":
      !r.artifactSha256||!r.policySha256||e.artifactSha256!==r.artifactSha256||
      e.policySha256!==r.policySha256?"evidence_binding_mismatch":
      e.validUntilMs<=nowMs||nowMs-e.observedAtMs>trust.maxReviewAgeMs?"expired_evidence":null;
    const allowed=reason===null;
    if(allowed)counts.candidateAllow++;
    else{counts.quarantine++;counts.reasons[reason]=(counts.reasons[reason]||0)+1;}
    return {productId:r.productId,territory:r.territory,format:r.format,channel:r.channel,
      source:r.source,sourceItemId:r.sourceItemId,allowed,reason,artifactSha256:r.artifactSha256,policySha256:r.policySha256,
      basisSha256:allowed?e.basisSha256:null,validUntilMs:allowed?e.validUntilMs:0};
  });
  const manifest={schema:"cove.current-legal-baseline-candidate.v1",inventorySha256,
    ownerEpoch,reviewSha256:hashCurrentBaseline(review),evaluatedAtMs:nowMs,
    validUntilMs:decisions.reduce((end,r)=>r.allowed?Math.min(end,r.validUntilMs):end,
      Math.min(review.validUntilMs,review.withdrawalCutoffMs+trust.maxWithdrawalAgeMs)),decisions};
  return {manifest,manifestSha256:hashCurrentBaseline(manifest),counts,
    completeInventory:true,authorizing:false,permitsPublication:false,releaseCertified:false};
}
