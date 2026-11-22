/* eslint-disable prettier/prettier -- External rights provenance is a legal trust boundary. */
/**
 * Validates a full, independently signed external withdrawal/reinstatement
 * chain. This is an OFFLINE REVIEW TOOL, never a retail grant. No source's
 * historical records currently satisfy this contract, and a newly signed
 * recreation of Cove's existing D1 audit is NOT authoritative source history.
 *
 * The verifier receives its independently trusted key and pin OUTSIDE the
 * archive. It never accepts a key, endorsement, or legal allow bit supplied
 * by an archive. A valid chain still cannot establish a current owner-denial
 * epoch, canonical D1 writer closure, expiry/contract parity, or release.
 *
 * Never log or publish the supplied archive: it may contain private source
 * IDs and rightsholder evidentiary references. The returned report omits them.
 */
import {createHash,createPublicKey,verify} from "node:crypto";

export const EVENT_SCHEMA="cove.independent-source-legal-event.v1";
export const CHECKPOINT_SCHEMA="cove.independent-source-legal-checkpoint.v1";
export const CHAIN_REPORT_SCHEMA="cove.independent-source-chain-review.v1";
const EVENT_FIELDS=[
  "action","basisDigest","effectiveAt","eventId","format","issuer",
  "previousDigest","recordedAt","reinstatesEventId","salesChannel",
  "schema","sequence","signature","source","sourceItemId","territory"
].sort().join("|");
const CHECKPOINT_FIELDS=[
  "complete","coverageFrom","coverageThrough","eventCount","issuer",
  "lastDigest","lastSequence","schema","signature","source"
].sort().join("|");
const ZERO="0".repeat(64);
const no=(v)=>{throw Error("independent_source_chain_denied_"+v);};
const uint=(v,n=0)=>Number.isSafeInteger(v)&&v>=n;
const digest=(v)=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const names=(v)=>Object.keys(v).sort().join("|");
const sourceRe=/^pg_(?:us|au|ca|eu)$/;
const trustedIssuerRe=/^[a-z0-9][a-z0-9._:-]{3,100}$/;
const itemRe=/^(?:[0-9]{1,10}|(?:pgau|pgca|pgeu)_[a-z0-9_]{1,90})$/;
const eventRe=/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const sigRe=/^[a-zA-Z0-9_-]{50,220}$/;
const actions=new Set(["initial-grant","withdraw","expire","reinstate"]);
function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==="object")
    return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
export function canonicalLegalBytes(item){
  if(!item||typeof item!=="object"||Array.isArray(item))
    no("invalid_signed_envelope");
  const {signature,...rest}=item;
  return Buffer.from(JSON.stringify(canonical(rest)),"utf8");
}
function strictUtc(x){
  if(typeof x!=="string"||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x))
    no("noncanonical_event_time");
  const t=Date.parse(x);
  if(!Number.isFinite(t)||new Date(t).toISOString()!==x)
    no("invalid_event_time");
  return t;
}
function exactSourceItem(source,item){
  if(!sourceRe.test(source)||!itemRe.test(item))
    no("invalid_source_scope");
  const p={pg_us:/^[0-9]{1,10}$/,pg_au:/^pgau_[a-z0-9_]{1,90}$/,
    pg_ca:/^pgca_[a-z0-9_]{1,90}$/,pg_eu:/^pgeu_[a-z0-9_]{1,90}$/};
  if(!p[source].test(item))no("source_identity_mismatch");
}
function signedFields(row,expected){
  if(!row||typeof row!=="object"||Array.isArray(row)||
    names(row)!==expected||!sigRe.test(row.signature))
    no("signed_envelope_shape");
}
function checkedSigner(publicKeyPem,expectedSpkiSha256){
  if(!digest(expectedSpkiSha256)||typeof publicKeyPem!=="string"||
    publicKeyPem.length<130||publicKeyPem.length>1500)
    no("trusted_external_key_unconfigured");
  let k;
  try{k=createPublicKey(publicKeyPem);}catch{no("invalid_trusted_external_key");}
  if(k.asymmetricKeyType!=="ec"||
    k.asymmetricKeyDetails?.namedCurve!=="prime256v1")
    no("unreviewed_external_signing_algorithm");
  const encoded=k.export({type:"spki",format:"der"});
  const pin=createHash("sha256").update(encoded).digest("hex");
  if(pin!==expectedSpkiSha256)no("independent_source_signer_pin_mismatch");
  return k;
}
function signatureChecked(row,k){
  if(!sigRe.test(row.signature))no("signature_shape");
  let bytes;
  try{bytes=Buffer.from(row.signature,"base64url");}catch{no("signature_encoding");}
  if(bytes.length<64||bytes.length>80||
    bytes.toString("base64url")!==row.signature||
    !verify("sha256",canonicalLegalBytes(row),k,bytes))
    no("signature_invalid");
}
function sourceValid(row,issuer,source){
  if(row.issuer!==issuer||row.source!==source)
    no("signed_source_identity_mismatch");
}
function verifyEvent(row,k,issuer,source){
  signedFields(row,EVENT_FIELDS);
  if(row.schema!==EVENT_SCHEMA||!actions.has(row.action)||
    !uint(row.sequence,1)||!eventRe.test(row.eventId)||
    !digest(row.previousDigest)||!digest(row.basisDigest)||
    !/^[A-Z]{2}$/.test(row.territory)||
    !["ebook","audiobook"].includes(row.format)||
    !["retail","subscription","library"].includes(row.salesChannel))
    no("unreviewed_event_semantics");
  sourceValid(row,issuer,source);
  exactSourceItem(source,row.sourceItemId);
  const recorded=strictUtc(row.recordedAt),effective=strictUtc(row.effectiveAt);
  if(effective>recorded)no("future_effective_legal_event");
  if(row.action==="reinstate"){
    if(typeof row.reinstatesEventId!=="string"||
      !eventRe.test(row.reinstatesEventId))
      no("reinstatement_missing_external_denial_reference");
  } else if(row.reinstatesEventId!==null)no("unexpected_reinstatement_reference");
  signatureChecked(row,k);
  return {recorded,effective};
}
const statusKey=(row)=>[
  row.sourceItemId,row.territory,row.format,row.salesChannel
].join("\u0000");
/**
 * The caller must inject a previously independently vetted provider public
 * key and its out-of-band pinned SPKI SHA256, never values from the archive.
 * Checked replay is bounded, chronological and gap-free. Signed checkpoints
 * must attest an exhaustive continuous source stream from sequence 1.
 *
 * This returns NONAUTHORIZING diagnostic results even for a valid archive:
 * D1 canonical parity, external publisher scope, currently effective legal
 * basis, current owner epoch, and exclusive owner writer are separate proofs.
 */
export function reviewIndependentExternalLegalHistory(archive,trust){
  if(!trust||typeof trust!=="object"||
    !trustedIssuerRe.test(trust.issuer)||!sourceRe.test(trust.source))
    no("independent_source_trust_unconfigured");
  const key=checkedSigner(trust.publicKeyPem,trust.expectedSpkiSha256);
  if(!archive||typeof archive!=="object"||Array.isArray(archive)||
    names(archive)!=="checkpoint|events"||
    !Array.isArray(archive.events)||archive.events.length<1||
    archive.events.length>100000)no("incomplete_external_event_archive");
  const checkpoint=archive.checkpoint;
  signedFields(checkpoint,CHECKPOINT_FIELDS);
  if(checkpoint.schema!==CHECKPOINT_SCHEMA||
    checkpoint.complete!==true||
    !uint(checkpoint.eventCount,1)||
    !uint(checkpoint.lastSequence,1)||
    checkpoint.eventCount!==checkpoint.lastSequence||
    checkpoint.eventCount!==archive.events.length||
    !digest(checkpoint.lastDigest))
    no("unattested_full_external_history");
  sourceValid(checkpoint,trust.issuer,trust.source);
  const coverageFrom=strictUtc(checkpoint.coverageFrom);
  const through=strictUtc(checkpoint.coverageThrough);
  if(through<coverageFrom)no("coverage_clock_invalid");
  signatureChecked(checkpoint,key);
  const state=new Map(),eventIds=new Set();
  let lastSeq=0,lastDigest=ZERO,lastRecorded=-1;
  const counts={initialGrant:0,withdraw:0,expire:0,reinstate:0};
  for(const row of archive.events){
    const {recorded,effective}=verifyEvent(row,key,trust.issuer,trust.source);
    if(row.sequence!==lastSeq+1)no("external_event_sequence_gap_or_duplicate");
    if(row.previousDigest!==lastDigest)no("external_event_chain_broken");
    if(eventIds.has(row.eventId))no("external_event_identity_reused");
    if(recorded<lastRecorded||recorded<coverageFrom||recorded>through)
      no("external_event_recording_backdated_or_outside_checkpoint");
    const scope=statusKey(row),prior=state.get(scope);
    if(prior&&effective<prior.effective)
      no("backdated_scope_reinstatement_or_revision");
    if(row.action==="initial-grant"){
      if(prior)no("duplicate_or_recreated_initial_grant");
      counts.initialGrant++;
      state.set(scope,{current:"granted",effective,terminalEventId:null});
    }else if(row.action==="withdraw"||row.action==="expire"){
      if(prior?.current==="withdrawn"||prior?.current==="expired")
        no("duplicate_terminal_legal_event");
      counts[row.action]++;
      state.set(scope,{current:row.action==="withdraw"?"withdrawn":"expired",
        effective,terminalEventId:row.eventId});
    }else{
      if(!prior||prior.current==="granted"||
        prior.terminalEventId!==row.reinstatesEventId)
        no("unproven_terminal_to_positive_transition");
      counts.reinstate++;
      state.set(scope,{current:"granted",effective,terminalEventId:null});
    }
    eventIds.add(row.eventId);
    lastDigest=createHash("sha256").update(canonicalLegalBytes(row))
      .update(Buffer.from(row.signature,"utf8")).digest("hex");
    lastSeq=row.sequence;lastRecorded=recorded;
  }
  if(lastDigest!==checkpoint.lastDigest||lastSeq!==checkpoint.lastSequence)
    no("signed_source_checkpoint_mismatch");
  if(lastRecorded>through)no("signed_source_coverage_incomplete");
  // No source item IDs, event IDs, signatures, keys, raw legal documents,
  // provider URLs, rightsholder names or financial records in this report.
  return {
    schema:CHAIN_REPORT_SCHEMA,
    signedSourceEventCount:lastSeq,
    sourceScopesObserved:state.size,
    eventKinds:counts,
    coverageFrom:checkpoint.coverageFrom,
    coverageThrough:checkpoint.coverageThrough,
    validatedDigest:lastDigest,
    signerPublicKeyFingerprint:trust.expectedSpkiSha256,
    sourceHistoryIntegrityVerified:true,
    sourceAuthorityIndependentlyEstablished:false,
    canonicalGrantHistoryReconciled:false,
    currentOwnerDenialEpochVerified:false,
    canonicalWriterExclusive:false,
    authorizing:false,permitsPublication:false,releaseCertified:false,
    blockers:[
      "external_signer_independent_legal_authority_not_established",
      "complete_external_withdrawals_not_reconciled_to_primary_grants",
      "source_and_contract_scope_parity_not_verified",
      "current_production_owner_denial_epoch_missing",
      "exclusive_primary_d1_write_authority_not_proven",
    ]
  };
}
