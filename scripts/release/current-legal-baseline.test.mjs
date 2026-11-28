/* eslint-disable prettier/prettier -- exact legal-boundary fixtures */
import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash,generateKeyPairSync,sign} from "node:crypto";
import {compileCurrentLegalBaseline,hashCurrentBaseline} from "./current-legal-baseline.mjs";
const now=1760000000000;
const a="a".repeat(64),b="b".repeat(64),c="c".repeat(64);
const {privateKey,publicKey}=generateKeyPairSync("ec",{namedCurve:"prime256v1"});
const spkiSha256=createHash("sha256").update(publicKey.export({type:"spki",format:"der"})).digest("hex");
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==="object"?
  Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const seal=payload=>({...payload,signature:sign("sha256",Buffer.from(JSON.stringify(canonical(payload))),privateKey).toString("base64url")});
const row=(productId,extra={})=>({productId,territory:"US",format:"ebook",channel:"retail",source:"pg_us",
  sourceItemId:productId,artifactSha256:a,policySha256:b,canonicalAllowed:true,outstandingHold:false,...extra});
const evidence=(r,extra={})=>{const {canonicalAllowed,outstandingHold,...scope}=r;return {...scope,
  decision:"allow",basisSha256:c,observedAtMs:now-1000,validUntilMs:now+1000,...extra}};
function fixture(inventory,rows,extra={}){
  const sorted=[...inventory].sort((a,b)=>JSON.stringify([a.productId,a.territory,a.format,a.channel])<
    JSON.stringify([b.productId,b.territory,b.format,b.channel])?-1:1);
  const inventorySha256=hashCurrentBaseline(sorted);
  const trust={issuer:"reviewer-one",publicKeyPem:publicKey.export({type:"spki",format:"pem"}).toString(),
    spkiSha256,inventorySha256,maxReviewAgeMs:3600000,maxWithdrawalAgeMs:60000};
  const review=seal({schema:"cove.current-legal-review.v1",issuer:trust.issuer,inventorySha256,
    ownerEpoch:7,observedAtMs:now-1000,withdrawalCutoffMs:now-500,validUntilMs:now+2000,
    currentWithdrawalsReconciled:true,rows,...extra});
  return {inventory,review,trust,ownerEpoch:7,nowMs:now};
}
test("complete scope partition with current holds, deny, absence and artifact changes",()=>{
  const rows=[row("p1"),row("p2",{outstandingHold:true}),row("p3",{canonicalAllowed:false}),
    row("p4"),row("p5"),row("p6",{artifactSha256:null}),row("p7",{territory:"AU"}),
    row("p8"),row("p9")];
  const proofs=[evidence(rows[0]),evidence(rows[1]),evidence(rows[2]),
    evidence(rows[4],{decision:"deny"}),evidence(rows[5],{artifactSha256:a}),evidence(rows[6]),
    evidence(rows[7],{artifactSha256:c}),evidence(rows[8],{observedAtMs:now-2000,validUntilMs:now-1})];
  const result=compileCurrentLegalBaseline(fixture(rows,proofs));
  assert.equal(result.counts.candidateAllow,1);
  assert.equal(result.counts.quarantine,8);
  for(const reason of ["current_hold","canonical_deny","missing_current_evidence","external_deny",
    "evidence_binding_mismatch","source_scope_not_reviewed","expired_evidence"])
    assert.ok(result.counts.reasons[reason]);
  assert.equal(result.manifest.decisions.length,rows.length);
  assert.equal(result.manifest.validUntilMs,now+1000);
  assert.equal(result.permitsPublication,false);
  assert.equal(result.authorizing,false);
  assert.equal(result.releaseCertified,false);
});
test("reject tampering, trust substitution, stale cutoffs, owner race, duplicate and foreign evidence",()=>{
  const r=row("p1"), e=evidence(r), valid=fixture([r],[e]);
  assert.throws(()=>compileCurrentLegalBaseline({...valid,ownerEpoch:8}),/review_scope_or_time/);
  assert.throws(()=>compileCurrentLegalBaseline({...valid,trust:{...valid.trust,spkiSha256:a}}),/reviewer_pin/);
  assert.throws(()=>compileCurrentLegalBaseline({...valid,inventory:[{...r,outstandingHold:true}]}),/inventory_pin/);
  assert.throws(()=>compileCurrentLegalBaseline({...valid,review:{...valid.review,rows:[{...e,decision:"deny"}]}}),/review_signature/);
  assert.throws(()=>compileCurrentLegalBaseline(fixture([r],[e,e])),/foreign_or_duplicate_evidence/);
  assert.throws(()=>compileCurrentLegalBaseline(fixture([r],[evidence(row("p2"))])),/foreign_or_duplicate_evidence/);
  assert.throws(()=>compileCurrentLegalBaseline(fixture([r],[e],{withdrawalCutoffMs:now-100000})),/review_scope_or_time/);
  assert.throws(()=>compileCurrentLegalBaseline(fixture([r],[e],{currentWithdrawalsReconciled:false})),/review_scope_or_time/);
  assert.throws(()=>compileCurrentLegalBaseline(fixture([r,r],[e])),/duplicate_scope/);
});
test("full-catalog-sized baseline compiles without per-record signatures or stack overflow",()=>{
  const rows=Array.from({length:82247},(_,i)=>row("p"+String(i).padStart(6,"0")));
  const report=compileCurrentLegalBaseline(fixture(rows,rows.map(r=>evidence(r))));
  assert.equal(report.counts.candidateAllow,82247);
  assert.equal(report.counts.quarantine,0);
  assert.equal(report.manifest.decisions.length,82247);
  assert.equal(report.permitsPublication,false);
});

test("atomic generation seal rejects stale CAS, owner epoch drift, current holds and tampering",async()=>{
  const {DatabaseSync}=await import("node:sqlite");
  const {initializeBaselineStore,sealBaselineGeneration,inspectBaselineCandidate}=await import("./current-legal-baseline-generation.mjs");
  const db=new DatabaseSync(":memory:");
  try{
    initializeBaselineStore(db);
    const r=row("p1"), input=fixture([r],[evidence(r)]);
    assert.equal(sealBaselineGeneration(db,input,0).generation,1);
    assert.deepEqual(inspectBaselineCandidate(db,r,7,now),{candidateAllowed:true,authorizing:false});
    for(const [current,epoch,time] of [[{...r,outstandingHold:true},7,now],[{...r,canonicalAllowed:false},7,now],
      [{...r,artifactSha256:c},7,now],[row("unknown"),7,now],[r,8,now],[r,7,now+1000]])
      assert.equal(inspectBaselineCandidate(db,current,epoch,time).candidateAllowed,false);
    assert.throws(()=>sealBaselineGeneration(db,input,0),/generation_conflict/);
    assert.throws(()=>sealBaselineGeneration(db,{...input,ownerEpoch:6},1),/generation_conflict/);
    assert.throws(()=>sealBaselineGeneration(db,{...input,review:{...input.review,signature:"bad"}},1),/review_scope_or_time/);
    assert.equal(db.prepare("SELECT generation FROM baseline_head").get().generation,1);
    assert.equal(sealBaselineGeneration(db,input,1).generation,2);
    db.exec("UPDATE baseline_generation SET manifest_json='{}' WHERE generation=2");
    assert.equal(inspectBaselineCandidate(db,r,7,now).candidateAllowed,false);
  }finally{db.close();}
});


test("paged owner publication binds independent evidence and complete captured membership",async()=>{
  const {prepareCurrentLegalOwnerPublication:prepare}=await import("./prepare-current-legal-owner-publication.mjs");
  const inventory=[row("p1"),row("p2"),row("p3",{canonicalAllowed:false})];
  const input=fixture(inventory,[evidence(inventory[0]),evidence(inventory[2])]);
  const pages=[{kind:"products",rows:inventory.map(r=>({productId:r.productId}))},{kind:"scopes",rows:inventory}]
    .map((p,index)=>({...p,index,sha256:hashCurrentBaseline(p)}));
  let root=hashCurrentBaseline({schema:"cove.canonical-owner-capture-seed.v1",ownerEpoch:7,withdrawalSequence:2});
  for(const p of pages)root=hashCurrentBaseline({prior:root,index:p.index,kind:p.kind,sha256:p.sha256});
  const descriptor={schema:"cove.canonical-owner-paged-inventory.v1",ownerEpoch:7,withdrawalSequence:2,
    productCount:3,scopeCount:3,pageCount:2,rootSha256:root,defaultVerdict:"deny"};
  const capture={primaryId:"4bd657ac-8789-403e-a28c-93aba8d0a989",descriptor,pages,inventorySha256:hashCurrentBaseline(descriptor)};
  const args={capture,review:input.review,trust:input.trust,generation:1,nowMs:now};
  const result=prepare(args);
  assert.equal(result.authorizing,false);
  assert.equal(result.requiresIndependentSignatures,true);
  assert.equal(result.header.inventorySha256,capture.inventorySha256);
  assert.deepEqual(result.batches[0].map(r=>r.verdict),["allow","quarantine","deny"]);
  assert.equal(result.header.batchSha256[0],hashCurrentBaseline(result.batches[0]));
  assert.throws(()=>prepare({...args,capture:{...capture,pages:[pages[1],pages[0]]}}),/publication_capture_page/);
  assert.throws(()=>prepare({...args,capture:{...capture,pages:[pages[0],{...pages[1],rows:[]}]}}),/publication_capture_page/);
  assert.throws(()=>prepare({...args,review:{...input.review,rows:[]}}),/review_signature/);
  assert.throws(()=>prepare({...args,nowMs:now+3000}),/review_scope_or_time/);
});
