/* eslint-disable prettier/prettier -- Legal rights proof and revocation ordering regression. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";

const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cove-commercial-legal-"));
try {
  const outfile=path.join(dir,"commercial.mjs");
  await build({entryPoints:["src/storefront-strangler/commercial-legal-core.ts"],
    outfile,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"});
  const core=await import(pathToFileURL(outfile).href);
  const file=path.join(dir,"commercial.sqlite");
  let db=new DatabaseSync(file);
  const sql=()=>({exec(query,...args){
    const q=db.prepare(query);
    const result=/^\s*SELECT\b/i.test(query)?q.all(...args):(q.run(...args),[]);
    return {toArray:()=>result};
  }});
  core.createCommercialAuthoritySchema(sql());
  const id="prd_commercial_a17";
  const proof={productId:id,editionId:"ed_commercial_a17",territory:"US",
    channel:"retail",grantId:"right_valid_17",contractId:"rcontract_17",
    contractVersionId:"rcv_17",validUntil:new Date(Date.now()+120000).toISOString()};
  const read=(country="US",channel="retail",now=new Date().toISOString())=>
    core.readCommercialProofs(sql(),[id],country,channel,now);
  assert.deepEqual(read(),[],"Missing strongly consistent proof must deny");
  assert.throws(()=>core.validateCommercialProof({...proof,productId:"prd_gutenberg_2701"}),
    /invalid_commercial_proof/,"Gutenberg must not enter paid proof scope");
  assert.throws(()=>core.validateCommercialProof({...proof,grantId:""}),
    /invalid_commercial_proof/,"A paid proof must identify a canonical grant");
  assert.throws(()=>core.validateCommercialProof({...proof,contractVersionId:"rcv_17",contractId:null}),
    /invalid_commercial_proof/,"Versioned contract must have exact parent");
  assert.throws(()=>core.validateCommercialProof({...proof,contractId:null,contractVersionId:null}),
    /invalid_commercial_proof/,"Paid retail distribution never inherits a contract-free public-domain proof");
  assert.throws(()=>core.validateCommercialProof({...proof,contractVersionId:null}),
    /invalid_commercial_proof/,"Even a valid contract requires a precise version");
  assert.throws(()=>core.validateCommercialProof({...proof,territory:"*"}),
    /invalid_commercial_proof/,"A global wildcard cannot stand in for country approval");
  assert.throws(()=>core.validateCommercialProof({...proof,validUntil:new Date(Date.now()+48*3600000).toISOString()}),
    /invalid_commercial_proof/,"Long-lived cached allowances are forbidden");
  assert.equal(core.captureCommercialEpoch(sql(),{productId:id}),0);
  assert.deepEqual(core.publishFreshCommercialProof(sql(),proof,0),{applied:true,epoch:1});
  assert.equal(read().length,1);
  assert.equal(read()[0].grant_id,proof.grantId);
  db.prepare("UPDATE cove_commercial_scope_proofs SET contract_id=NULL WHERE product_id=? AND territory='US'").run(id);
  assert.deepEqual(read(),[],"Legacy owner records with missing contracts are never paid grants");
  db.prepare("UPDATE cove_commercial_scope_proofs SET contract_id=? WHERE product_id=? AND territory='US'").run(proof.contractId,id);
  db.prepare("UPDATE cove_commercial_scope_proofs SET contract_version_id=NULL WHERE product_id=? AND territory='US'").run(id);
  assert.deepEqual(read(),[],"Legacy owner records with missing contract versions remain denied");
  db.prepare("UPDATE cove_commercial_scope_proofs SET contract_version_id=? WHERE product_id=? AND territory='US'").run(proof.contractVersionId,id);
  assert.equal(read().length,1);
  assert.deepEqual(core.publishFreshCommercialProof(sql(),{
    ...proof,validUntil:new Date(Date.now()+180000).toISOString()
  },1),{applied:true,epoch:1},
  "Refreshing the same verified offer must NOT churn every buyer entitlement");
  assert.throws(()=>core.publishFreshCommercialProof(sql(),{
    ...proof,grantId:"right_different_18"
  },1),/commercial_rights_change_requires_prior_denial/,
  "Grant substitution requires an acknowledged owner DENY first");
  assert.equal(read()[0].grant_id,proof.grantId);
  assert.deepEqual(core.publishFreshCommercialProof(sql(),{
    ...proof,territory:"CA"
  },1),{applied:true,epoch:1},
  "Adding a separately verified country must not invalidate other market epochs");

  assert.equal(read("CA").length,1,
    "Canada is authorized ONLY because a separate CA-specific fresh proof was explicitly published");
  assert.deepEqual(read("AU"),[],"No permission may be inferred for an unapproved country");
  assert.deepEqual(read("US","library"),[],"Retail purchase grant cannot authorize a library loan");
  assert.deepEqual(read("US","retail",new Date(Date.now()+250000).toISOString()),[],
    "Expired proof must deny even if an invalidation job never runs");
  // Subject-wide withdrawal must scale beyond the old 25-product limit.
  // All 35 independent editions share one commercial contract, yet only a
  // single owner SQLite tombstone is needed to deny every active grant.
  const many=Array.from({length:35},(_,i)=>"prd_bulk_"+String(i+1).padStart(3,"0"));
  for(const productId of many){
    const base=core.captureCommercialEpoch(sql(),{productId});
    assert.deepEqual(core.publishFreshCommercialProof(sql(),{
      ...proof,productId,editionId:"ed_"+productId,grantId:"grant_"+productId,
      contractId:"contract_bulk_35",contractVersionId:"contract_bulk_version_1"
    },base),{applied:true,epoch:1});
  }
  const manyRead=()=>many.flatMap(productId=>core.readCommercialProofs(
    sql(),[productId],"US","retail"));
  assert.equal(manyRead().length,35);
  const subject={subjectKind:"contract",subjectId:"contract_bulk_35",
    operationId:"contract:bulk35:withdraw"};
  assert.deepEqual(core.denyCommercialSubject(sql(),subject),{
    applied:true,subjectKind:"contract",subjectId:"contract_bulk_35"
  });
  assert.equal(manyRead().length,0,"One contract revocation must instantly deny all 35 books");
  assert.deepEqual(core.denyCommercialSubject(sql(),subject),{
    applied:true,subjectKind:"contract",subjectId:"contract_bulk_35"
  },"Identical owner withdrawal retry must be idempotent");
  assert.throws(()=>core.denyCommercialSubject(sql(),{
    ...subject,subjectId:"different_contract"
  }),/commercial_subject_op_scope_collision/);
  const secondOp={...subject,operationId:"contract:bulk35:withdraw-replay"};
  assert.deepEqual(core.denyCommercialSubject(sql(),secondOp),{
    applied:true,subjectKind:"contract",subjectId:"contract_bulk_35"
  });
  assert.throws(()=>core.denyCommercialSubject(sql(),{
    ...secondOp,subjectId:"another_contract"
  }),/commercial_subject_op_scope_collision/,
    "Every replay operation ID must remain permanently bound to its first subject");
  assert.throws(()=>core.publishFreshCommercialProof(sql(),{
    ...proof,productId:many[0],editionId:"ed_"+many[0],
    grantId:"grant_"+many[0],contractId:"contract_bulk_35",
    contractVersionId:"contract_bulk_version_2"
  },1),/commercial_subject_withdrawal_terminal/,
  "New contract version may not revive the revoked contract ID");
  const grantOnlyProduct="prd_grant_scope_17";
  assert.deepEqual(core.publishFreshCommercialProof(sql(),{
    ...proof,productId:grantOnlyProduct,editionId:"ed_grant_scope_17",
    grantId:"grant_scope_17",contractId:"contract_grant_scope_17",
    contractVersionId:"contract_grant_scope_version_1"
  },0),{applied:true,epoch:1});
  assert.equal(core.readCommercialProofs(sql(),[grantOnlyProduct],"US","retail").length,1);
  assert.deepEqual(core.denyCommercialSubject(sql(),{
    subjectKind:"grant",subjectId:"grant_scope_17",
    operationId:"grant:valid17:withdraw"
  }),{applied:true,subjectKind:"grant",subjectId:"grant_scope_17"});
  assert.deepEqual(core.readCommercialProofs(sql(),[grantOnlyProduct],"US","retail"),[],
    "One grant tombstone immediately denies independently allowed product");
  const stale=core.captureCommercialEpoch(sql(),{productId:id});
  const denied=core.denyCommercialProduct(sql(),{
    productId:id,operationId:"contract:17:revoked"
  });
  assert.deepEqual(denied,{applied:true,epoch:2});
  assert.deepEqual(read(),[],"Committed withdrawal immediately disables old proof");
  assert.deepEqual(core.publishFreshCommercialProof(sql(),proof,stale),
    {applied:false,epoch:2},"Slow primary D1 allow cannot resurrect withdrawal");
  // A withdrawal committed in the owner can outlive a failed canonical-D1
  // update. A later canonical read of the old active grant is NOT new legal
  // verification and must not regrant access, even at the latest epoch.
  assert.throws(()=>core.publishFreshCommercialProof(sql(),proof,2),
    /commercial_reinstatement_requires_new_legal_evidence/,
    "Same old grant and contract version cannot resurrect an owner withdrawal");
  assert.deepEqual(read(),[],"Old immutable legal evidence stays denied");
  const priceOnlyProduct="prd_reprice_scope_17";
  const priceOnly={...proof,productId:priceOnlyProduct,
    editionId:"ed_reprice_scope_17",grantId:"grant_reprice_scope_17",
    contractId:"contract_reprice_scope_17",
    contractVersionId:"contract_reprice_version_1"};
  assert.deepEqual(core.publishFreshCommercialProof(sql(),priceOnly,0),
    {applied:true,epoch:1});
  assert.deepEqual(core.denyCommercialProduct(sql(),{
    productId:priceOnlyProduct,operationId:"retail:qa-price-revision-1"
  }),{applied:true,epoch:2});
  assert.deepEqual(core.publishFreshCommercialProof(sql(),priceOnly,2),
    {applied:true,epoch:3},
    "Retail offer repricing may retain independently valid distribution rights");
  assert.equal(core.readCommercialProofs(sql(),[priceOnlyProduct],"US","retail").length,1);

  assert.deepEqual(read(),[]);
  assert.deepEqual(core.denyCommercialProduct(sql(),{
    productId:id,operationId:"contract:17:revoked"
  }),{applied:true,epoch:2},"Same event replay cannot increment epoch");
  assert.throws(()=>core.denyCommercialProduct(sql(),{
    productId:"prd_commercial_b18",operationId:"contract:17:revoked"
  }),/commercial_denial_scope_collision/,"Event receipt scope is immutable");
  assert.deepEqual(core.publishFreshCommercialProof(sql(),{
    ...proof,grantId:"right_fresh_18"
  },2),{applied:true,epoch:3});
  assert.equal(read()[0].grant_id,"right_fresh_18");
  // ABA scenario: a legal grant was revoked, later replaced, revoked
  // again, and replaced again. An ancient owner proof must never become
  // publishable merely because the current scope rows were overwritten.
  assert.deepEqual(core.denyCommercialProduct(sql(),{
    productId:id,operationId:"contract:17:second-withdrawal"
  }),{applied:true,epoch:4});
  assert.deepEqual(core.publishFreshCommercialProof(sql(),{
    ...proof,grantId:"right_fresh_19"
  },4),{applied:true,epoch:5});
  assert.throws(()=>core.publishFreshCommercialProof(sql(),proof,5),
    /commercial_reinstatement_requires_new_legal_evidence/,
    "An overwritten original grant remains permanently retired in owner SQLite");
  assert.throws(()=>core.publishFreshCommercialProof(sql(),{
    ...proof,grantId:"right_fresh_18"
  },5),/commercial_reinstatement_requires_new_legal_evidence/,
    "Every intermediary withdrawn grant must remain permanently retired");
  assert.equal(read()[0].grant_id,"right_fresh_19");
  assert.deepEqual(core.denyCommercialProduct(sql(),{
    productId:id,operationId:"contract:17:revoked"
  }),{applied:false,epoch:2},
    "A stale denial replay after fresh approval cannot masquerade as current");
  db.close();
  db=new DatabaseSync(file);
  assert.equal(read().length,1,"Owner proof survives SQLite Durable Object restart");
  const before=core.captureCommercialEpoch(sql(),{productId:id});
  db.exec("BEGIN");
  try{
    core.denyCommercialProduct(sql(),{productId:id,operationId:"contract:17:rollback"});
    db.exec("ROLLBACK");
  }catch(e){db.exec("ROLLBACK");throw e;}
  assert.equal(core.captureCommercialEpoch(sql(),{productId:id}),before,
    "Transaction rollback cannot create a ghost legal-denial receipt");
  assert.equal(read().length,1);
  assert.throws(()=>core.readCommercialProofs(sql(),[id,id],"US","retail"),
    /invalid_commercial_batch/);
  assert.throws(()=>core.readCommercialProofs(sql(),[id],"U$","retail"),
    /invalid_commercial_batch/);
  assert.deepEqual(core.readCommercialProofs(sql(),[],"US","retail"),[]);
  db.close();
  console.log("PASS: independent paid product/territory/channel proof; grant and contract scope; one-SQL batch; durable revoke, ABA, replay and expiration; no Gutenberg equivalence");
}finally{fs.rmSync(dir,{recursive:true,force:true});}
