/* eslint-disable prettier/prettier -- Adversarial source history fixtures use ephemeral test-only keys. */
import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash,generateKeyPairSync,sign} from "node:crypto";
import {
  EVENT_SCHEMA,CHECKPOINT_SCHEMA,CHAIN_REPORT_SCHEMA,canonicalLegalBytes,
  reviewIndependentExternalLegalHistory
} from "./independent-source-legal-event-chain.mjs";

function fixture(input={}){
  const {privateKey,publicKey}=generateKeyPairSync("ec",{namedCurve:"prime256v1"});
  const trust={
    issuer:"independent.pg.au.rights-source",source:"pg_au",
    publicKeyPem:publicKey.export({format:"pem",type:"spki"}),
    expectedSpkiSha256:createHash("sha256")
      .update(publicKey.export({format:"der",type:"spki"})).digest("hex")
  };
  const signed=(row)=>({...row,signature:sign("sha256",canonicalLegalBytes(row),
    privateKey).toString("base64url")});
  const scopes=input.scopes||[
    {action:"initial-grant",eventId:"e1",sourceItemId:"pgau_1",
      recordedAt:"2026-10-01T12:00:00.000Z",effectiveAt:"2026-10-01T12:00:00.000Z",
      reinstatesEventId:null},
    {action:"withdraw",eventId:"e2",sourceItemId:"pgau_1",
      recordedAt:"2026-10-02T12:00:00.000Z",effectiveAt:"2026-10-02T12:00:00.000Z",
      reinstatesEventId:null},
    {action:"reinstate",eventId:"e3",sourceItemId:"pgau_1",
      recordedAt:"2026-10-03T12:00:00.000Z",effectiveAt:"2026-10-03T12:00:00.000Z",
      reinstatesEventId:"e2"},
  ];
  const sequence=input.sequence||scopes.map((_,i)=>i+1);
  let digest="0".repeat(64);
  const events=scopes.map((x,i)=>{
    const e=signed({
      schema:EVENT_SCHEMA,issuer:trust.issuer,source:trust.source,
      sequence:sequence[i],eventId:x.eventId,sourceItemId:x.sourceItemId,
      territory:x.territory||"AU",format:"ebook",salesChannel:"retail",
      action:x.action,recordedAt:x.recordedAt,effectiveAt:x.effectiveAt,
      basisDigest:(x.basisDigest||"a".repeat(64)),previousDigest:digest,
      reinstatesEventId:x.reinstatesEventId,
    });
    digest=createHash("sha256").update(canonicalLegalBytes(e))
      .update(Buffer.from(e.signature,"utf8")).digest("hex");
    return e;
  });
  const checkpoint=signed({
    schema:CHECKPOINT_SCHEMA,issuer:trust.issuer,source:trust.source,
    complete:true,eventCount:events.length,lastSequence:events.length,
    lastDigest:digest,coverageFrom:"2026-09-01T00:00:00.000Z",
    coverageThrough:"2026-11-22T23:59:59.999Z",
  });
  return {trust,archive:{events,checkpoint},signed};
}
function expectDenied(modify,code){
  const f=fixture();
  modify(f);
  assert.throws(()=>reviewIndependentExternalLegalHistory(f.archive,f.trust),
    new RegExp("independent_source_chain_denied_"+code));
}
test("authentic continuous signed archive is STILL never legal or release authorization",()=>{
  const f=fixture();
  const result=reviewIndependentExternalLegalHistory(f.archive,f.trust);
  assert.equal(result.schema,CHAIN_REPORT_SCHEMA);
  assert.equal(result.signedSourceEventCount,3);
  assert.equal(result.sourceScopesObserved,1);
  assert.deepEqual(result.eventKinds,
    {initialGrant:1,withdraw:1,expire:0,reinstate:1});
  assert.equal(result.sourceHistoryIntegrityVerified,true);
  assert.equal(result.sourceAuthorityIndependentlyEstablished,false);
  assert.equal(result.canonicalGrantHistoryReconciled,false);
  assert.equal(result.currentOwnerDenialEpochVerified,false);
  assert.equal(result.canonicalWriterExclusive,false);
  assert.equal(result.authorizing,false);
  assert.equal(result.permitsPublication,false);
  assert.equal(result.releaseCertified,false);
  const report=JSON.stringify(result);
  assert.ok(!report.includes("pgau_1"));
  assert.ok(!report.includes("e1"));
  assert.ok(!report.includes("privateKey"));
  assert.ok(!report.includes("signature"));
  assert.ok(result.blockers.includes("complete_external_withdrawals_not_reconciled_to_primary_grants"));
});
test("a valid external signature without independent pinned signer is NOT enough",()=>{
  const f=fixture();
  assert.throws(()=>reviewIndependentExternalLegalHistory(f.archive,
    {...f.trust,expectedSpkiSha256:"1".repeat(64)}),/signer_pin_mismatch/);
  assert.throws(()=>reviewIndependentExternalLegalHistory(f.archive,
    {...f.trust,publicKeyPem:"supplied by the payload"}),/trusted_external_key_unconfigured|invalid_trusted_external_key/);
  assert.throws(()=>reviewIndependentExternalLegalHistory(f.archive,{
    source:"pg_au",issuer:"fake"
  }),/trusted_external_key_unconfigured/);
});
test("edits to immutable signed event payload or checkpoint are denied",()=>{
  expectDenied(f=>{f.archive.events[1].action="initial-grant";},"signature_invalid");
  expectDenied(f=>{f.archive.events[2].basisDigest="b".repeat(64);},"signature_invalid");
  expectDenied(f=>{f.archive.events[0].sourceItemId="pgau_2";},"signature_invalid");
  expectDenied(f=>{f.archive.checkpoint.eventCount=2;},"unattested_full_external_history");
  expectDenied(f=>{f.archive.checkpoint.coverageThrough="2026-11-22T23:59:59.998Z";},"signature_invalid");
});
test("event sequence gap, duplicate or a broken cryptographic chain is rejected",()=>{
  const f=fixture({sequence:[1,3,4]});
  assert.throws(()=>reviewIndependentExternalLegalHistory(f.archive,f.trust),/sequence_gap_or_duplicate/);
  const g=fixture({sequence:[1,1,3]});
  assert.throws(()=>reviewIndependentExternalLegalHistory(g.archive,g.trust),/sequence_gap_or_duplicate/);
  const h=fixture();
  const row=h.archive.events[1];
  h.archive.events[1]=h.signed({...row,previousDigest:"f".repeat(64),signature:undefined});
  assert.throws(()=>reviewIndependentExternalLegalHistory(h.archive,h.trust),/event_chain_broken/);
});
test("signed backdated chronology is detected rather than treated as valid reinstatement",()=>{
  const f=fixture({scopes:[
    {action:"initial-grant",eventId:"e1",sourceItemId:"pgau_1",
      recordedAt:"2026-10-03T12:00:00.000Z",effectiveAt:"2026-10-01T12:00:00.000Z",
      reinstatesEventId:null},
    {action:"withdraw",eventId:"e2",sourceItemId:"pgau_1",
      recordedAt:"2026-10-02T12:00:00.000Z",effectiveAt:"2026-10-02T12:00:00.000Z",
      reinstatesEventId:null},
  ]});
  assert.throws(()=>reviewIndependentExternalLegalHistory(f.archive,f.trust),
    /recording_backdated/);
  const g=fixture({scopes:[
    {action:"initial-grant",eventId:"e1",sourceItemId:"pgau_1",
      recordedAt:"2026-10-01T12:00:00.000Z",effectiveAt:"2026-10-01T12:00:00.000Z",
      reinstatesEventId:null},
    {action:"withdraw",eventId:"e2",sourceItemId:"pgau_1",
      recordedAt:"2026-10-02T12:00:00.000Z",effectiveAt:"2026-10-02T12:00:00.000Z",
      reinstatesEventId:null},
    {action:"reinstate",eventId:"e3",sourceItemId:"pgau_1",
      recordedAt:"2026-10-03T12:00:00.000Z",effectiveAt:"2026-10-01T23:00:00.000Z",
      reinstatesEventId:"e2"},
  ]});
  assert.throws(()=>reviewIndependentExternalLegalHistory(g.archive,g.trust),
    /backdated_scope_reinstatement_or_revision/);
});
test("signed reinstatement cannot bypass a missing exact terminal withdrawal",()=>{
  const s=[
    {action:"initial-grant",eventId:"e1",sourceItemId:"pgau_1",
      recordedAt:"2026-10-01T12:00:00.000Z",effectiveAt:"2026-10-01T12:00:00.000Z",reinstatesEventId:null},
    {action:"withdraw",eventId:"e2",sourceItemId:"pgau_1",
      recordedAt:"2026-10-02T12:00:00.000Z",effectiveAt:"2026-10-02T12:00:00.000Z",reinstatesEventId:null},
    {action:"reinstate",eventId:"e3",sourceItemId:"pgau_1",
      recordedAt:"2026-10-03T12:00:00.000Z",effectiveAt:"2026-10-03T12:00:00.000Z",reinstatesEventId:"e1"},
  ];
  const f=fixture({scopes:s});
  assert.throws(()=>reviewIndependentExternalLegalHistory(f.archive,f.trust),
    /unproven_terminal_to_positive_transition/);
  const g=fixture({scopes:s.slice(0,1).concat(s[2])});
  assert.throws(()=>reviewIndependentExternalLegalHistory(g.archive,g.trust),
    /unproven_terminal_to_positive_transition/);
});
test("source scope, proof coverage, event format and source clock must be exact",()=>{
  expectDenied(f=>{f.archive.events[1].territory="XX";},"signature_invalid");
  expectDenied(f=>{f.archive.events[1].recordedAt="2026-02-30T12:00:00.000Z";},"invalid_event_time");
  expectDenied(f=>{f.archive.events[0].effectiveAt="2026-10-02T13:00:00.000Z";},"future_effective_legal_event");
  expectDenied(f=>{f.archive.events[0].source="pg_us";},"signed_source_identity_mismatch");
  expectDenied(f=>{f.archive.checkpoint.complete=false;},"unattested_full_external_history");
  expectDenied(f=>{f.archive.events.pop();},"unattested_full_external_history");
  expectDenied(f=>{f.archive.events[0].unexpected="allow";},"signed_envelope_shape");
  expectDenied(f=>{f.archive.checkpoint.signature="fake";},"signed_envelope_shape");
});
test("unsupported fabricated legal stream is never inferred from raw audit rows",()=>{
  const f=fixture();
  assert.throws(()=>reviewIndependentExternalLegalHistory([
    {grantId:"a",recordedAt:"2026-10-01T12:00:00Z"}
  ],f.trust),/incomplete_external_event_archive/);
  assert.throws(()=>reviewIndependentExternalLegalHistory({
    events:f.archive.events,checkpoint:{...f.archive.checkpoint,signerPublicKey:f.trust.publicKeyPem}
  },f.trust),/signed_envelope_shape/);
  assert.throws(()=>reviewIndependentExternalLegalHistory({...f.archive,
    unsafeAllow:true},f.trust),/incomplete_external_event_archive/);
});
