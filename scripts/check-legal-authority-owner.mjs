/* eslint-disable prettier/prettier -- Assert revision ordering and deny-first behavior explicitly. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const directory=fs.mkdtempSync(path.join(os.tmpdir(),"cove-legal-fence-"));
try {
  const artifact=path.join(directory,"authority.mjs");
  await build({
    entryPoints:["src/storefront-strangler/legal-authority-core.ts"],
    outfile:artifact,bundle:true,platform:"node",format:"esm",target:"node22",logLevel:"silent"
  });
  const {createAuthoritySchema, createAuthorityProofSchema, readAuthority, applyAuthorityCommand,
    storeAuthorizedPresentationProof,readAuthorizedPresentations,persistSourceWithdrawal,
    capturePositiveVerificationFence,commitFreshPositiveVerification,
    validateWithdrawalBatch,persistSourceWithdrawalsBatch}=
    await import(pathToFileURL(artifact).href);
  const sqlitePath=path.join(directory,"persistent.sqlite");
  const makeSql=db=>({
    exec(statement,...args) {
      // Cloudflare SQL.exec is eager. Match that behavior exactly: a write
      // must commit even when its returned cursor is deliberately ignored.
      const prepared=db.prepare(statement);
      const rows=/^\s*SELECT\b/i.test(statement)
        ? prepared.all(...args)
        : (prepared.run(...args),[]);
      return {toArray:()=>rows};
    }
  });
  let db=new DatabaseSync(sqlitePath);
  let sql=makeSql(db);
  createAuthoritySchema(sql);
  createAuthorityProofSchema(sql);
  const proof={productId:'prd_gutenberg_2701',editionId:'ed_gutenberg_2701',
    productPublicId:'book-2701',editionPublicId:'edition-2701',
    offerJson:JSON.stringify({type:'public-domain',currency:'USD',amountMinor:0})};
  const candidates=['prd_gutenberg_2701'];
  const batch=(country='US',currency='USD')=>
    readAuthorizedPresentations(sql,candidates,country,currency);
  assert.deepEqual(batch(),[], 'Unseeded market authorization MUST deny');
  const cmd=(revision,action,territory="US")=>({
    sourceId:"2701",territory,revision,action
  });
  const state=(territory="US")=>readAuthority(sql,"2701",territory);
  assert.deepEqual(state(),{allowed:false,revision:null},
    "Cold/unseeded owner cannot infer authorization from a cached card");
  assert.equal(applyAuthorityCommand(sql,cmd(10,"deny")).applied,true);
  assert.deepEqual(state(),{allowed:false,revision:10});
  assert.equal(applyAuthorityCommand(sql,cmd(10,"deny")).applied,true,
    "Idempotent denial retry must acknowledge persisted denial");
  assert.equal(applyAuthorityCommand(sql,cmd(9,"allow")).applied,false);
  assert.equal(applyAuthorityCommand(sql,cmd(10,"allow")).applied,false);
  assert.equal(state().allowed,false);
  assert.equal(applyAuthorityCommand(sql,cmd(11,"allow")).applied,true);
  assert.deepEqual(state(),{allowed:true,revision:11});
  assert.deepEqual(batch(),[],"An allow flag without an exact primary proof cannot authorize");
  assert.deepEqual(
    storeAuthorizedPresentationProof(sql,cmd(11,"allow"),"USD",proof),
    {allowed:true,revision:11}
  );
  assert.equal(batch().length,1);
  assert.equal(batch()[0].edition_id,proof.editionId);
  assert.deepEqual(storeAuthorizedPresentationProof(sql,cmd(11,"allow"),"USD",proof),
    {allowed:true,revision:11},"Exact same-version offer retry is idempotent");
  assert.throws(()=>storeAuthorizedPresentationProof(sql,cmd(11,"allow"),"USD",
    {...proof,editionPublicId:"changed-edition-id"}),/authority_offer_proof_conflict/,
    "An old in-flight writer cannot substitute a different offer at the same epoch");
  assert.equal(batch()[0].edition_public_id,proof.editionPublicId,
    "Verified offer proof never changes within a legal epoch");
  assert.deepEqual(batch("CA"),[],"Country grant not inferred");
  assert.deepEqual(batch("US","CAD"),[],"Currency proof not inferred");
  assert.equal(applyAuthorityCommand(sql,cmd(11,"deny")).applied,true,
    "Same-revision denial must dominate positive grant");
  assert.equal(applyAuthorityCommand(sql,cmd(11,"allow")).applied,false);
  assert.equal(state().allowed,false);
  assert.deepEqual(batch(),[],"Equal-version denial immediately revokes stored proof");
  assert.equal(applyAuthorityCommand(sql,cmd(12,"allow")).applied,true);
  assert.equal(state().allowed,true);
  assert.deepEqual(batch(),[],"Old rev11 proof never authorizes new rev12");
  storeAuthorizedPresentationProof(sql,cmd(12,"allow"),"USD",proof);
  assert.equal(batch().length,1);
  // A global source withdrawal blocks every territory, including those with
  // previously allowed state. A later explicit fresh positive proof is needed.
  assert.equal(applyAuthorityCommand(sql,cmd(13,"deny","*")).applied,true);
  assert.equal(state().allowed,false);
  assert.deepEqual(state("CA"),{allowed:false,revision:13});
  assert.deepEqual(batch(),[],"Source-wide withdrawal atomically revokes old offer");
  assert.equal(applyAuthorityCommand(sql,cmd(13,"allow")).applied,false);
  assert.equal(state().allowed,false,
    "Global denial wins over equal-revision territory permission");
  assert.equal(applyAuthorityCommand(sql,cmd(14,"allow")).applied,true);
  assert.equal(state().allowed,true);
  assert.equal(state("CA").allowed,false,
    "US reinstatement cannot authorize an unrelated territory");
  assert.deepEqual(batch(),[],"No grandfathering of prior offer after fresh allow");
  storeAuthorizedPresentationProof(sql,cmd(14,"allow"),"USD",proof);
  assert.equal(batch().length,1);
  assert.throws(()=>storeAuthorizedPresentationProof(sql,cmd(12,"allow"),"USD",proof),
    /authority_positive_revision_unconfirmed/);
  assert.throws(()=>storeAuthorizedPresentationProof(sql,cmd(14,"allow"),"USD",
    {...proof,offerJson:JSON.stringify({type:"ebook",currency:"USD",amountMinor:100})}),
    /invalid_authority_offer/);
  assert.equal(applyAuthorityCommand(sql,cmd(12,"deny","*")).applied,false);
  assert.equal(applyAuthorityCommand(sql,{
    sourceId:"2702",territory:"CA",revision:20,action:"allow"
  }).applied,true);
  assert.equal(applyAuthorityCommand(sql,{
    sourceId:"2702",territory:"*",revision:19,action:"deny"
  }).applied,false,"A stale global denial must not be acknowledged");
  assert.equal(readAuthority(sql,"2702","CA").allowed,true);
  assert.equal(applyAuthorityCommand(sql,{
    sourceId:"2702",territory:"*",revision:21,action:"deny"
  }).applied,true);
  assert.equal(readAuthority(sql,"2702","CA").allowed,false);
  assert.equal(state().allowed,true);
  assert.throws(()=>applyAuthorityCommand(sql,cmd(15,"allow","*")),/invalid_authority_command/);
  assert.throws(()=>applyAuthorityCommand(sql,cmd(0,"allow")),/invalid_authority_command/);
  assert.throws(()=>applyAuthorityCommand(sql,cmd(16,"allow","ZZZ")),/invalid_authority_command/);
  assert.throws(()=>applyAuthorityCommand(sql,{...cmd(17,"allow"),sourceId:"../../"},),/invalid_authority_command/);
  assert.throws(()=>readAuthority(sql,"2701","*"),/invalid_authority_scope/);
  // Simulated isolate eviction: state is reloaded from durable SQL, not a
  // settled in-memory cache or a soon-to-expire KV/R2 snapshot.
  db.close();
  db=new DatabaseSync(sqlitePath);
  sql=makeSql(db);
  createAuthoritySchema(sql);
  createAuthorityProofSchema(sql);
  assert.deepEqual(state(),{allowed:true,revision:14});
  assert.equal(batch().length,1,"Positive proof survives Durable Object isolate eviction");
  assert.equal(applyAuthorityCommand(sql,cmd(15,"deny")).applied,true);
  assert.deepEqual(batch(),[]);
  db.close();
  db=new DatabaseSync(sqlitePath);
  sql=makeSql(db);
  assert.deepEqual(state(),{allowed:false,revision:15});
  assert.deepEqual(batch(),[],"Withdrawal survives durable restart");
  // Cross-service writer identity: the source-wide owner allocates its own
  // monotonic epoch; stale event clocks cannot produce a false ACK.
  const withdraw=persistSourceWithdrawal(sql,{
    sourceId:"2701",territory:"*",operationId:"catalog:source:2701:withdraw:1"
  });
  assert.equal(withdraw.applied,true);
  assert.equal(withdraw.revision,16);
  assert.equal(persistSourceWithdrawal(sql,{
    sourceId:"2701",territory:"*",operationId:"catalog:source:2701:withdraw:1"
  }).revision,16,"Duplicate webhook/publisher replay does not add an epoch");
  assert.throws(()=>persistSourceWithdrawal(sql,{
    sourceId:"2702",territory:"*",operationId:"catalog:source:2701:withdraw:1"
  }),/denial_operation_reused_with_different_scope/);
  assert.equal(applyAuthorityCommand(sql,cmd(17,"allow")).applied,true);
  storeAuthorizedPresentationProof(sql,cmd(17,"allow"),"USD",proof);
  assert.equal(batch().length,1);
  const old=persistSourceWithdrawal(sql,{
    sourceId:"2701",territory:"*",operationId:"catalog:source:2701:withdraw:1"
  });
  assert.equal(old.applied,false,"Retry of past withdrawal must not acknowledge a new grant");
  const newer=persistSourceWithdrawal(sql,{
    sourceId:"2701",territory:"*",operationId:"checkout:source:2701:withdraw:2"
  });
  assert.equal(newer.revision,18);
  assert.deepEqual(batch(),[],"New durable withdrawal immediately revokes checkout proof");
  assert.equal(applyAuthorityCommand(sql,cmd(19,"allow","CA")).applied,true);
  assert.equal(persistSourceWithdrawal(sql,{
    sourceId:"2701",territory:"*",operationId:"checkout:source:2701:withdraw:2"
  }).applied,false,"A fresh CA grant prevents a stale global ACK even if US remains denied");
  assert.equal(persistSourceWithdrawal(sql,{
    sourceId:"2701",territory:"*",operationId:"rights:source:2701:withdraw:3"
  }).revision,20);
  assert.equal(state("CA").allowed,false,"New global denial revokes CA immediately");
  const started=capturePositiveVerificationFence(sql,cmd(21,"allow"));
  assert.equal(started,20,"Regrant obtains the next owner epoch before D1 work");
  assert.equal(persistSourceWithdrawal(sql,{
    sourceId:"2701",territory:"*",operationId:"rights:source:2701:withdraw:4"
  }).revision,21);
  assert.equal(commitFreshPositiveVerification(sql,cmd(21,"allow"),started,"USD",proof).applied,false,
    "Primary proof begun before an acknowledged withdrawal must not restore rights");
  assert.deepEqual(batch(),[],"Delayed primary query cannot resurrect withdrawn offer");
  assert.throws(()=>capturePositiveVerificationFence(sql,cmd(21,"allow")),
    /positive_verification_stale_revision/);
  const fresh=capturePositiveVerificationFence(sql,cmd(22,"allow"));
  assert.equal(fresh,21);
  assert.equal(commitFreshPositiveVerification(sql,cmd(22,"allow"),fresh,"USD",proof).applied,true,
    "Only newly verified D1 proof after withdrawal can publish an allowance");
  assert.equal(batch().length,1);
  assert.equal(persistSourceWithdrawal(sql,{
    sourceId:"2701",territory:"*",operationId:"rights:source:2701:withdraw:5"
  }).revision,23);
  assert.deepEqual(batch(),[],"Later revocation dominates the new offer immediately");
  assert.throws(()=>persistSourceWithdrawal(sql,{
    sourceId:"2701",territory:"*",operationId:"../../escape"
  }),/invalid_denial_operation/);
  const batchRaw={operations:[
    {sourceId:"2702",territory:"*",operationId:"regional:2702:retracted"},
    {sourceId:"2703",territory:"*",operationId:"regional:2703:retracted"}
  ]};
  assert.equal(validateWithdrawalBatch(batchRaw).length,2);
  assert.throws(()=>validateWithdrawalBatch({operations:[batchRaw.operations[0],batchRaw.operations[0]]}),
    /duplicate_denial_batch_key/);
  assert.throws(()=>validateWithdrawalBatch({operations:[batchRaw.operations[0],
    {...batchRaw.operations[1],sourceId:"../../fake"}]}),/invalid_authority_command/);
  assert.deepEqual(readAuthority(sql,"2702","US"),{allowed:false,revision:null});
  db.exec("BEGIN");
  const pair=persistSourceWithdrawalsBatch(sql,batchRaw);
  db.exec("COMMIT");
  assert.equal(pair.applied,true);
  assert.deepEqual(pair.receipts.map(x=>x.revision),[1,1]);
  assert.deepEqual(readAuthority(sql,"2702","US"),{allowed:false,revision:1});
  assert.deepEqual(readAuthority(sql,"2703","CA"),{allowed:false,revision:1});
  db.exec("BEGIN");
  const duplicate=persistSourceWithdrawalsBatch(sql,batchRaw);
  db.exec("COMMIT");
  assert.equal(duplicate.applied,true);
  assert.deepEqual(duplicate.receipts.map(x=>x.revision),[1,1],
    "Canonical retraction event replay must retain owner epochs");
  const abort={operations:[{sourceId:"2704",territory:"*",operationId:"regional:2704:retracted"},
    {sourceId:"2703",territory:"*",operationId:"regional:2702:retracted"}]};
  db.exec("BEGIN");
  try {
    assert.throws(()=>persistSourceWithdrawalsBatch(sql,abort),
      /denial_operation_reused_with_different_scope/);
    db.exec("ROLLBACK");
  }catch(e){db.exec("ROLLBACK");throw e;}
  assert.deepEqual(readAuthority(sql,"2704","US"),{allowed:false,revision:null},
    "Atomic owner transaction rolls back first withdrawal if later command fails");
  db.close();
  console.log("PASS: persistent deny-first legal fence, stale/equal positive rejection, global withdrawal, territory isolation, recovery");
} finally {fs.rmSync(directory,{recursive:true,force:true});}
