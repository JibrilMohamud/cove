/* eslint-disable prettier/prettier -- Auditable real-resolver staging proof; no external database or network. */
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";
import {DatabaseSync} from "node:sqlite";

// The Python child is an in-memory SQLite legal-source database. No primary
// D1, credentials, real product, Stripe or customer content is available.
const child=spawn("python3",["-u","scripts/staging/rights-resolver-sqlite-fixture.py"],{
  stdio:["pipe","pipe","pipe"],
});
const pending=new Map();let counter=0;let stderr="";
child.stderr.on("data",chunk=>{stderr=String(chunk).slice(0,200);});
createInterface({input:child.stdout}).on("line",line=>{
  try{
    const response=JSON.parse(line);
    const job=pending.get(response.id);
    if(!job)return;
    pending.delete(response.id);
    if(response.ok)job.resolve(response);
    else job.reject(Error("Isolated fixture RPC failed: "+String(response.error||"").slice(0,150)));
  }catch{
    for(const job of pending.values())job.reject(Error("Invalid local SQLite fixture response"));
    pending.clear();
  }
});
child.on("exit",()=>{
  for(const job of pending.values())job.reject(Error("Local SQLite fixture exited"));
  pending.clear();
});
function rpc(op,other={}){
  return new Promise((resolve,reject)=>{
    const id=++counter;
    pending.set(id,{resolve,reject});
    child.stdin.write(JSON.stringify({id,op,...other})+"\n");
  });
}
function statement(sql,args=[]){
  return {
    bind:(...args)=>statement(sql,args),
    first:async()=>((await rpc("query",{sql,params:args})).results[0]||null),
    all:async()=>({results:(await rpc("query",{sql,params:args})).results}),
    run:async()=>{throw Error("Canonical fixture SQL is read-only");},
  };
}
const sourceDB={
  prepare:sql=>statement(sql),
  batch:async()=>{throw Error("Canonical source D1 fixture cannot write");},
};
// The actual legal-owner SQLite modules operate against an independent
// in-memory SQLite database, not a copy of any canonical rights source.
const sqlite=new DatabaseSync(":memory:");
const ownerSql={
  exec:(sql,...args)=>{
    const stmt=sqlite.prepare(sql);
    const rows=/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql)?stmt.all(...args):(stmt.run(...args),[]);
    return {toArray:()=>rows};
  },
};
const folder=mkdtempSync(path.join(tmpdir(),"cove-real-owner-lease-"));
try{
  await build({
    entryPoints:{
      rights:"src/features/fore/rights.server.ts",
      lease:"src/storefront-strangler/canonical-commercial-lease.ts",
      legal:"src/storefront-strangler/commercial-legal-core.ts",
      storefront:"src/storefront-strangler/commercial-storefront-authority.ts",
    },
    outdir:folder,bundle:true,platform:"node",format:"esm",target:"node22",
    logLevel:"silent",
  });
  const load=async name=>import(pathToFileURL(path.join(folder,name+".js")).href);
  const {resolveProductRights}=await load("rights");
  const {canonicalCommercialLeaseUntil,CANONICAL_PAID_NEXT_BOUNDARY_SQL,CANONICAL_PAID_OFFER_NEXT_BOUNDARY_SQL}=await load("lease");
  const {
    createCommercialAuthoritySchema,publishFreshCommercialProof,
    denyCommercialSubject,denyCommercialProduct,
  }=await load("legal");
  const {
    createCommercialStorefrontSchema,publishCommercialStorefront,
    readCommercialStorefront,
  }=await load("storefront");
  // Prove source code is constrained to a single book/edition, and includes
  // future negative grants, contract versions, language rules, offers,
  // product release and primary-D1 clock freshness.
  assert.match(CANONICAL_PAID_NEXT_BOUNDARY_SQL,/rights_grants/);
  assert.match(CANONICAL_PAID_NEXT_BOUNDARY_SQL,/rights_contract_versions/);
  assert.match(CANONICAL_PAID_NEXT_BOUNDARY_SQL,/rights_contract_languages/);
  assert.match(CANONICAL_PAID_OFFER_NEXT_BOUNDARY_SQL,/offers/);
  assert.match(CANONICAL_PAID_OFFER_NEXT_BOUNDARY_SQL,/editions/);
  assert.ok((CANONICAL_PAID_NEXT_BOUNDARY_SQL.match(/UNION ALL/g)||[]).length<=3);
  assert.ok((CANONICAL_PAID_OFFER_NEXT_BOUNDARY_SQL.match(/UNION ALL/g)||[]).length<=1);
  assert.match(CANONICAL_PAID_NEXT_BOUNDARY_SQL,/julianday\(at\)>=julianday\(\?\)/);
  assert.match(CANONICAL_PAID_OFFER_NEXT_BOUNDARY_SQL,/julianday\(at\)>=julianday\(\?\)/);
  assert.match(CANONICAL_PAID_NEXT_BOUNDARY_SQL,/primary_now/);
  assert.equal(
    (CANONICAL_PAID_NEXT_BOUNDARY_SQL.match(/FROM target t\s+CROSS JOIN rights_grants rg/g)||[]).length,
    4,
    "All legal schedule branches must seed indexed one-book grants, never scan global rights",
  );
  assert.doesNotMatch(
    CANONICAL_PAID_NEXT_BOUNDARY_SQL,
    /FROM rights_grants rg\s+JOIN target t/,
  );

  createCommercialAuthoritySchema(ownerSql);
  createCommercialStorefrontSchema(ownerSql);
  const scenarios=[
    ["baseline",true,false],
    ["future-explicit-deny",true,true],
    ["contract-expiry-soon",true,true],
    ["future-competitive-offer",true,true],
    ["invalid-legal-time",true,"invalid"],
    ["explicit-deny",false,false],
    ["version-inactive",false,false],
    ["contract-inactive",false,false],
    ["contract-expired",false,false],
    ["grant-expired",false,false],
    ["format-denied",false,false],
    ["territory-denied",false,false],
    ["channel-denied",false,false],
    ["drm-required",false,false],
    ["language-denied",false,false],
    ["language-allow-mismatch",false,false],
    ["product-disabled",false,false],
  ];
  let positives=0,negatives=0,schedules=0,malformed=0;
  for(const [name,expected,short] of scenarios){
    await rpc("scenario",{name});
    const evaluatedAtMs=Date.now();
    const decision=await resolveProductRights(sourceDB,"prd_fixture_001","US",{
      salesChannel:"retail",at:new Date(evaluatedAtMs).toISOString(),persist:false,
    });
    assert.equal(decision.allowed,expected,"Canonical rights decision: "+name);
    assert.equal(decision.productId,"prd_fixture_001");
    assert.equal(decision.territory,"US");
    assert.equal(decision.salesChannel,"retail");
    if(!decision.allowed){negatives++;continue;}
    assert.equal(decision.grantId,"grant_fixture_001");
    assert.equal(decision.contractId,"contract_fixture_001");
    assert.equal(decision.contractVersionId,"version_fixture_001");
    assert.equal(decision.editionId,"ed_fixture_001");
    if(short==="invalid"){
      await assert.rejects(
        canonicalCommercialLeaseUntil(sourceDB,decision.productId,evaluatedAtMs),
        /canonical_lease_primary_unverified/,
        "Unparseable source time must fail closed",
      );
      malformed++;continue;
    }
    const until=await canonicalCommercialLeaseUntil(sourceDB,decision.productId,evaluatedAtMs);
    assert.match(until,/Z$/);
    const leaseMs=Date.parse(until)-Date.now();
    assert.ok(leaseMs>0,"Positive must have a fresh usable legal lease: "+name);
    assert.ok(leaseMs<=30*60_000,"Rights positive cannot exceed 30 minutes");
    if(short===true){
      assert.ok(leaseMs<3000,"Future legal or offer mutation must expire the right before its transition: "+name);
      schedules++;
    }else{
      assert.ok(leaseMs>5000,"Stable canonical grant should have a useful lease");
    }
    positives++;
    if(name==="baseline"){
      // Do not publish a mere 'allowed: true'. Bind exact canonical grant,
      // contract, effective version and independently verified offer to the
      // untrusted-free owner SQLite proof in an atomic local transaction.
      const receipt=publishFreshCommercialProof(ownerSql,{
        productId:decision.productId,editionId:decision.editionId,
        territory:"US",channel:"retail",grantId:decision.grantId,
        contractId:decision.contractId,
        contractVersionId:decision.contractVersionId,validUntil:until,
      },0);
      assert.equal(receipt.applied,true);
      assert.equal(receipt.epoch,1);
      const offer=await sourceDB.prepare(
        "SELECT id,amount_minor,currency FROM offers WHERE product_id=? AND active=1 AND sales_channel='retail'",
      ).bind(decision.productId).first();
      assert.ok(offer);
      assert.equal(offer.id,"offer_fixture_001");
      assert.equal(offer.currency,"USD");
      assert.equal(offer.amount_minor,599);
      const price={type:"retail",currency:offer.currency,amountMinor:offer.amount_minor};
      const validUntil=new Date(Math.min(Date.now()+4*60_000,Date.parse(until))).toISOString();
      publishCommercialStorefront(ownerSql,{
        product_id:decision.productId,edition_id:decision.editionId,
        product_public_id:null,edition_public_id:null,territory:"US",currency:"USD",
        rights_epoch:receipt.epoch,grant_id:decision.grantId,
        contract_id:decision.contractId,
        contract_version_id:decision.contractVersionId,
        offer_json:JSON.stringify(price),valid_until:validUntil,
      });
      const before=readCommercialStorefront(ownerSql,[decision.productId],"US","USD");
      assert.equal(before.length,1,"Exact canonical paid proof must authorize a current offer");
      assert.deepEqual(JSON.parse(before[0].offer_json),price);
      const tombstone=denyCommercialSubject(ownerSql,{
        subjectKind:"contract",subjectId:decision.contractId,
        operationId:"stage:owner:contract:withdrawal:1",
      });
      assert.equal(tombstone.applied,true);
      assert.equal(readCommercialStorefront(ownerSql,[decision.productId],"US","USD").length,0,
        "Owner contract veto must be immediately effective");
      assert.throws(()=>publishFreshCommercialProof(ownerSql,{
        productId:decision.productId,editionId:decision.editionId,
        territory:"US",channel:"retail",grantId:decision.grantId,
        contractId:decision.contractId,
        contractVersionId:decision.contractVersionId,validUntil:until,
      },1),/commercial_subject_withdrawal_terminal/,
      "Stale D1 canonical evidence cannot undo owner's accepted withdrawal");
      assert.equal(readCommercialStorefront(ownerSql,[decision.productId],"US","USD").length,0);
    }
  }
  assert.equal(positives,4);
  assert.equal(negatives,12);
  assert.equal(schedules,3);
  assert.equal(malformed,1);
  // Refuse old or future Worker snapshots independently of canonical
  // SQL: even a 30-minute lease cannot be based on a stale evaluation.
  await rpc("scenario",{name:"baseline"});
  for(const delta of [-3000,3000]){
    await assert.rejects(
      canonicalCommercialLeaseUntil(sourceDB,"prd_fixture_001",Date.now()+delta),
      /canonical_lease_unfresh_evaluation/,
    );
  }
  assert.equal(readCommercialStorefront(ownerSql,["prd_fixture_001"],"US","USD").length,0);
  // A pending canonical ALLOW has crossed an imminent legal transition
  // between resolver evaluation and the D1 follow-up. A query anchored
  // to the later D1 NOW would incorrectly omit it; the evaluatedAt fence
  // must keep the expired boundary visible and refuse publication.
  const evaluationStart=Date.now()-500;
  let boundCount=0;
  const crossingDB={
    prepare:(sql)=>{
      assert.match(sql,/julianday\(at\)>=julianday\(\?\)/);
      return {bind:(productId,start)=>{
        assert.equal(productId,"prd_fixture_001");
        assert.equal(start,new Date(evaluationStart).toISOString());
        boundCount++;
        return {first:async()=>({
          product_count:1,primary_now:new Date().toISOString(),
          next_transition:new Date(Date.now()-150).toISOString(),
          invalid_times:0,
        })};
      }};
    },
  };
  await assert.rejects(
    canonicalCommercialLeaseUntil(crossingDB,"prd_fixture_001",evaluationStart),
    /canonical_lease_transition_imminent/,
    "A legal change during canonical evaluation must prevent a stale positive",
  );
  assert.equal(boundCount,2);
  console.log(JSON.stringify({
    event:"cove_stage_real_canonical_owner_lease",
    canonicalCases:scenarios.length,positives,negatives,
    futureTransitions:schedules,malformedDatesDenied:malformed,
    staleOrFutureClockDenied:2,midVerificationTransitionDenied:true,liveOwnerContractVeto:true,
    productionModified:false,releaseCertified:false,passed:true,
  }));
}finally{
  sqlite.close();
  child.stdin.end();
  child.kill("SIGTERM");
  rmSync(folder,{recursive:true,force:true});
}
